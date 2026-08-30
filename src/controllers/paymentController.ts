import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import axios from 'axios';
import { getPaymentGateway, getCurrency, getGatewayCountry } from '../utils/gatewayRouter';
import { calculatePaymentFees } from '../utils/feeCalculations';
import {
  findPackageMarketPriceWithFallback,
  gatewayForPackageCurrency,
  packageAvailableInMarket,
  paystackChannelsForCurrency,
  resolvePricingMarket,
} from '../utils/pricingMarkets';
import { queueEmail } from '../lib/emailQueue';
import { ticketPurchaseTemplate, donationReceiptTemplate, packageSubscriptionTemplate } from '../lib/emailTemplates';
import { generateTicketPDF } from '../lib/ticketPDF';
import { generateReceiptPDF } from '../lib/receiptPDF';
import { createDonationRecordsForTransaction } from '../lib/donationCompletion';
import { recordPaymentEvent } from '../middleware/metrics';
import { displayName, maskEmail, maskPhone } from '../utils/logger';
import { createEventTicketWithUniqueNumber } from '../lib/eventTickets';
import {
  activateSubscriptionFromInvoice,
  applyPackagePaymentToInvoices,
  invoiceCoveredMonths,
  publicInvoicePaymentQuote,
} from '../services/packageInvoiceService';
import { getEffectiveDonationDonor } from '../lib/donationMemberMatching';

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY!;
const PAYSTACK_BASE_URL = process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co';
const SYSTEM_SUBACCOUNT_CODE = process.env.SYSTEM_SUBACCOUNT_CODE!;
const BACKEND_URL = process.env.BACKEND_URL!;

function packagePaymentLogMeta(traceId: string, pendingTx: any, metadata: any = {}, extra: Record<string, unknown> = {}) {
  return {
    traceId,
    pendingTransactionId: pendingTx?.id,
    reference: pendingTx?.reference,
    ministryAdminId: metadata.ministryAdminId,
    packageId: metadata.packageId,
    packageName: metadata.packageName,
    billingCycle: metadata.billingCycle,
    amount: metadata.baseAmount,
    totalAmount: metadata.totalAmount ?? pendingTx?.amount,
    currency: pendingTx?.currency,
    initiatedBy: metadata.initiatedBy,
    initiatedByName: metadata.initiatedByName,
    ...extra,
  };
}

function eventTicketPaymentLogMeta(traceId: string, pendingTx: any, metadata: any = {}, extra: Record<string, unknown> = {}) {
  return {
    traceId,
    pendingTransactionId: pendingTx?.id,
    transactionId: extra.transactionId,
    reference: pendingTx?.reference,
    eventId: metadata.eventId ?? pendingTx?.eventId,
    churchId: pendingTx?.churchId,
    userId: metadata.userId ?? pendingTx?.userId,
    userName: metadata.userName,
    isGuest: metadata.isGuest === true,
    guestName: metadata.guestName,
    guestEmail: maskEmail(metadata.guestEmail),
    guestPhone: maskPhone(metadata.guestPhone),
    quantity: metadata.quantity,
    amount: metadata.baseAmount,
    totalAmount: metadata.totalAmount ?? pendingTx?.amount,
    currency: pendingTx?.currency,
    ...extra,
  };
}

function donationPaymentLogMeta(traceId: string, pendingTx: any, metadata: any = {}, extra: Record<string, unknown> = {}) {
  return {
    traceId,
    pendingTransactionId: pendingTx?.id,
    transactionId: extra.transactionId,
    reference: pendingTx?.reference,
    campaignId: metadata.campaignId,
    campaignName: metadata.campaignName,
    churchId: pendingTx?.churchId || metadata.churchId,
    userId: metadata.userId ?? pendingTx?.userId,
    userName: metadata.userName,
    isGuest: metadata.isGuest === true,
    guestName: metadata.guestName,
    donorName: metadata.donorName,
    guestEmail: maskEmail(metadata.guestEmail),
    guestPhone: maskPhone(metadata.guestPhone),
    amount: metadata.baseAmount,
    totalAmount: metadata.totalAmount ?? pendingTx?.amount,
    currency: pendingTx?.currency,
    ...extra,
  };
}

const subscribeSchema = z.object({
  packageId: z.string().optional(),
  billingCycle: z.enum(['monthly', 'yearly']).optional(),
  invoiceId: z.string().optional(),
}).refine(data => !!data.invoiceId || (!!data.packageId && !!data.billingCycle), {
  message: 'Package and billing cycle are required unless paying an invoice',
});

export async function initiatePackageSubscription(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const role = req.user?.role;
  const traceId = `PKG-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  console.log(`[${traceId}] ========== PACKAGE SUBSCRIPTION INITIATED ==========`);
  console.log(`[${traceId}] User ID: ${userId}, Role: ${role}`);
  console.log(`[${traceId}] Request body:`, req.body);
  
  if (!userId) {
    console.log(`[${traceId}] ERROR: Not authenticated`);
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const parsed = subscribeSchema.safeParse(req.body);
  if (!parsed.success) {
    console.log(`[${traceId}] ERROR: Validation failed:`, parsed.error.errors);
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  let { packageId, billingCycle } = parsed.data;
  const { invoiceId } = parsed.data;
  console.log(`[${traceId}] Package ID: ${packageId}, Billing: ${billingCycle}`);

  // Get current user with ministryAdminId field
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    console.log(`[${traceId}] ERROR: User not found`);
    res.status(404).json({ success: false, message: 'User not found' });
    return;
  }
  console.log(`[${traceId}] User found: ${user.email}`);

  // Determine national admin
  let ministryAdminId: string;
  let ministryAdmin: any;
  
  if (role === 'ministry_admin') {
    ministryAdminId = userId;
    ministryAdmin = user;
    console.log(`[${traceId}] User is national admin`);
  } else {
    // Other roles: get national admin from ministryAdminId field
    if (!user.ministryAdminId) {
      console.log(`[${traceId}] ERROR: No national admin assigned`);
      res.status(400).json({ success: false, message: 'No national admin assigned to your account' });
      return;
    }
    ministryAdminId = user.ministryAdminId;
    ministryAdmin = await prisma.user.findUnique({ where: { id: ministryAdminId } });
    if (!ministryAdmin) {
      console.log(`[${traceId}] ERROR: National admin not found: ${ministryAdminId}`);
      res.status(404).json({ success: false, message: 'National admin not found' });
      return;
    }
    console.log(`[${traceId}] National admin found: ${ministryAdmin.email}`);
  }

  if (!ministryAdmin.email) {
    console.log(`[${traceId}] ERROR: National admin email missing`);
    res.status(400).json({ success: false, message: 'National admin email required for payment' });
    return;
  }

  let invoice: any = null;
  if (invoiceId) {
    invoice = await prisma.packageInvoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) {
      res.status(404).json({ success: false, message: 'Invoice not found' });
      return;
    }
    if (invoice.ministryAdminId !== ministryAdminId) {
      res.status(403).json({ success: false, message: 'This invoice does not belong to your ministry account' });
      return;
    }
    if (['paid', 'cancelled'].includes(invoice.status)) {
      res.status(400).json({ success: false, message: `Invoice is already ${invoice.status}` });
      return;
    }
    packageId = invoice.packageId;
    billingCycle = invoice.billingCycle === 'yearly' ? 'yearly' : 'monthly';
  }

  const pkg = await prisma.package.findUnique({
    where: { id: packageId! },
    include: { marketPrices: true },
  });
  if (!pkg) {
    console.log(`[${traceId}] ERROR: Package not found: ${packageId}`);
    res.status(404).json({ success: false, message: 'Package not found' });
    return;
  }
  if (pkg.isPrivate && !invoice) {
    const assignedPrivatePackage = await prisma.subscription.findFirst({
      where: { ministryAdminId, packageId: pkg.id },
      select: { id: true },
    });
    if (!assignedPrivatePackage) {
      res.status(403).json({ success: false, message: 'This private package is not assigned to your ministry account.' });
      return;
    }
  }
  console.log(`[${traceId}] Package: ${pkg.name} (${pkg.displayName})`);

  // Public package prices resolve through pricing markets. Private packages
  // keep their own negotiated package-table price.
  
  // Read the legacy account gateway only as a private-package currency fallback.
  // The actual checkout gateway is derived from the final currency.
  console.log(`[${traceId}] Calling getPaymentGateway for ministryAdminId: ${ministryAdminId}`);
  const accountGateway = await getPaymentGateway(ministryAdminId);
  const market = await resolvePricingMarket(ministryAdmin.accountCountry);
  const generalMarket = market.code === 'general' ? market : await resolvePricingMarket('General');
  const marketPrice = pkg.isPrivate ? null : findPackageMarketPriceWithFallback(pkg, market.id, generalMarket.id);
  if (!invoice && !pkg.isPrivate && !packageAvailableInMarket(pkg, market.id, generalMarket.id)) {
    res.status(400).json({ success: false, message: 'This package is not available for your country or market.' });
    return;
  }
  const currency = invoice
    ? invoice.currency
    : pkg.isPrivate
      ? (pkg.currencyCode || getCurrency(accountGateway))
      : marketPrice?.currencyCode;
  if (!currency) {
    res.status(400).json({ success: false, message: 'Package pricing is not configured for your country or the General market.' });
    return;
  }
  const gateway = invoice
    ? gatewayForPackageCurrency(invoice.currency)
    : gatewayForPackageCurrency(currency);
  const gatewayCountry = getGatewayCountry(gateway);
  
  console.log(`[${traceId}] Gateway: ${gateway}, Country: ${gatewayCountry}, Currency: ${currency}`);
  console.log(`[${traceId}] National Admin accountCountry: ${ministryAdmin.accountCountry}`);
  
  const baseAmount = invoice
    ? Math.max(0, invoice.balanceDue || invoice.amount)
    : pkg.isPrivate
      ? Number(billingCycle === 'monthly' ? pkg.priceMonthly : pkg.priceYearly)
      : Number(billingCycle === 'monthly' ? marketPrice?.priceMonthly : marketPrice?.priceYearly);
  if (!invoice && !pkg.isPrivate && (!marketPrice || !Number.isFinite(baseAmount) || baseAmount <= 0)) {
    res.status(400).json({ success: false, message: 'Package pricing is not configured for your country or the General market.' });
    return;
  }
  console.log(`[${traceId}] Pricing market: ${market.name}; base amount: ${baseAmount} ${currency}${pkg.isPrivate ? ' from private package' : marketPrice ? ' from market price' : ''}`);
  
  // Calculate fees (Kenya has no tax, Malawi has 17.5% tax)
  const fees = calculatePaymentFees(baseAmount, gatewayCountry);
  
  console.log(`[${traceId}] Fees - Base: ${fees.baseAmount}, Convenience: ${fees.convenienceFee}, System Fee: ${fees.systemFeeAmount}, Total: ${fees.totalAmount}`);
  console.log(`[${traceId}] Routing to: ${gateway === 'paychangu' ? 'PAYCHANGU (Malawi)' : 'PAYSTACK (Kenya)'}`);
  
  const amountInKobo = Math.round(fees.totalAmount * 100);
  


  // Create pending transaction (expires in 1 hour)
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + 1);

  const pendingTx = await prisma.pendingTransaction.create({
    data: {
      amount: fees.totalAmount,
      currency,
      userId,
      churchId: user.churchId || '',
      type: 'package_subscription',
      expiresAt,
      metadata: JSON.stringify({
        traceId,
        ministryAdminId,
        initiatedBy: userId,
        initiatedByName: displayName(user.firstName, user.lastName),
        packageId,
        packageName: pkg.name,
        billingCycle,
        invoiceId: invoice?.id,
        invoiceNumber: invoice?.invoiceNumber,
        invoiceServicePeriodStart: invoice?.servicePeriodStart,
        invoiceServicePeriodEnd: invoice?.servicePeriodEnd,
        baseAmount: fees.baseAmount,
        convenienceFee: fees.convenienceFee,
        systemFeeAmount: fees.systemFeeAmount,
        ceilRoundingAmount: fees.ceilRoundingAmount,
        totalAmount: fees.totalAmount,
        gatewayFeeRate: fees.systemGatewayFeeRate,
        systemFeeRate: fees.systemFeeRate,
        gateway,
        gatewayCountry,
      }),
    },
  });
  console.log(`[${traceId}] Pending transaction created: ${pendingTx.id}`);
  console.log(`[${traceId}] Pending transaction metadata:`, pendingTx.metadata ? JSON.parse(pendingTx.metadata) : {});

  // Route to appropriate gateway
  if (gateway === 'paychangu') {
    console.log(`[${traceId}] ========== ROUTING TO PAYCHANGU ==========`);
    return await initiatePaychanguPayment(pendingTx, ministryAdmin, fees, traceId, res);
  } else {
    console.log(`[${traceId}] ========== ROUTING TO PAYSTACK ==========`);
    return await initiatePaystackPayment(pendingTx, ministryAdmin, fees, traceId, res);
  }
}

export async function initiatePublicInvoicePayment(req: Request, res: Response): Promise<void> {
  const traceId = `INV-PUBLIC-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const token = String(req.params.token || req.body?.token || '');
  const requestedMonths = req.body?.months !== undefined ? Number(req.body.months) : undefined;

  if (!token || token.length < 24) {
    res.status(404).json({ success: false, message: 'Invoice not found' });
    return;
  }

  const invoice = await prisma.packageInvoice.findUnique({ where: { publicToken: token } });
  if (!invoice || invoice.status === 'cancelled') {
    res.status(404).json({ success: false, message: 'Invoice not found or no longer available' });
    return;
  }
  if (invoice.status === 'paid' || invoice.balanceDue <= 0) {
    res.status(400).json({ success: false, message: 'Invoice has already been paid' });
    return;
  }

  const ministryAdmin = await prisma.user.findUnique({ where: { id: invoice.ministryAdminId } });
  if (!ministryAdmin?.email) {
    res.status(400).json({ success: false, message: 'Invoice account cannot receive online payments right now' });
    return;
  }

  const pkg = await prisma.package.findUnique({ where: { id: invoice.packageId } });
  if (!pkg) {
    res.status(404).json({ success: false, message: 'Invoice package not found' });
    return;
  }

  const currency = invoice.currency;
  const gateway = gatewayForPackageCurrency(currency);
  const gatewayCountry = getGatewayCountry(gateway);

  let invoiceQuote: ReturnType<typeof publicInvoicePaymentQuote>;
  try {
    const selectedMonths = requestedMonths || invoiceCoveredMonths(invoice);
    invoiceQuote = publicInvoicePaymentQuote(invoice, selectedMonths);
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message || 'Invalid invoice payment months' });
    return;
  }
  const baseAmount = invoiceQuote.baseAmount;
  const fees = calculatePaymentFees(baseAmount, gatewayCountry);
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + 1);

  const pendingTx = await prisma.pendingTransaction.create({
    data: {
      amount: fees.totalAmount,
      currency,
      userId: ministryAdmin.id,
      churchId: ministryAdmin.churchId || '',
      type: 'package_subscription',
      expiresAt,
      metadata: JSON.stringify({
        traceId,
        ministryAdminId: invoice.ministryAdminId,
        initiatedBy: ministryAdmin.id,
        initiatedByName: 'Public invoice link',
        publicInvoicePayment: true,
        invoicePublicToken: token,
        packageId: invoice.packageId,
        packageName: pkg.name,
        billingCycle: invoice.billingCycle === 'yearly' ? 'yearly' : 'monthly',
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        invoiceServicePeriodStart: invoice.servicePeriodStart,
        invoiceServicePeriodEnd: invoiceQuote.extraPeriodEnd || invoice.servicePeriodEnd,
        originalInvoiceServicePeriodStart: invoice.servicePeriodStart,
        originalInvoiceServicePeriodEnd: invoice.servicePeriodEnd,
        invoicePaymentMonths: invoiceQuote.selectedMonths,
        originalInvoiceMonths: invoiceQuote.originalInvoiceMonths,
        extraInvoiceMonths: invoiceQuote.extraMonths,
        invoiceMonthlyAmount: invoiceQuote.monthlyAmount,
        originalInvoiceAmountDue: invoiceQuote.originalAmountDue,
        extraInvoiceAmount: invoiceQuote.extraAmount,
        extraInvoiceServicePeriodStart: invoiceQuote.extraPeriodStart,
        extraInvoiceServicePeriodEnd: invoiceQuote.extraPeriodEnd,
        baseAmount: fees.baseAmount,
        convenienceFee: fees.convenienceFee,
        systemFeeAmount: fees.systemFeeAmount,
        ceilRoundingAmount: fees.ceilRoundingAmount,
        totalAmount: fees.totalAmount,
        gatewayFeeRate: fees.systemGatewayFeeRate,
        systemFeeRate: fees.systemFeeRate,
        gateway,
        gatewayCountry,
      }),
    },
  });

  recordPaymentEvent(gateway, 'package_subscription', 'initialized', packagePaymentLogMeta(traceId, pendingTx, JSON.parse(pendingTx.metadata || '{}'), {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    source: 'public_invoice_link',
  }));

  if (gateway === 'paychangu') {
    return await initiatePaychanguPayment(pendingTx, ministryAdmin, fees, traceId, res);
  }
  return await initiatePaystackPayment(pendingTx, ministryAdmin, fees, traceId, res);
}

async function initiatePaystackPayment(
  pendingTx: any,
  ministryAdmin: any,
  fees: any,
  traceId: string,
  res: Response
): Promise<void> {
  console.log(`[${traceId}] initiatePaystackPayment called`);
  const amountInKobo = Math.round(fees.totalAmount * 100);
  const metadata = pendingTx.metadata ? JSON.parse(pendingTx.metadata) : {};
  const channels = paystackChannelsForCurrency(pendingTx.currency);
  console.log(`[${traceId}] Amount in kobo: ${amountInKobo}`);

  try {
    const paystackPayload = {
      email: ministryAdmin.email,
      amount: amountInKobo,
      currency: pendingTx.currency,
      callback_url: `${BACKEND_URL}/api/payments/verify`,
      metadata: {
        ...metadata,
        type: 'package_subscription',
        pendingTxId: pendingTx.id,
        initiatedBy: pendingTx.userId,
      },
      ...(channels && { channels }),
      ...(SYSTEM_SUBACCOUNT_CODE && { subaccount: SYSTEM_SUBACCOUNT_CODE }),
    };

    await prisma.pendingTransaction.update({
      where: { id: pendingTx.id },
      data: {
        metadata: JSON.stringify({
          ...metadata,
          gatewayPayload: paystackPayload,
        }),
      },
    });
    
    console.log(`[${traceId}] Paystack request:`, JSON.stringify(paystackPayload, null, 2));
    console.log(`[${traceId}] Calling Paystack API: ${PAYSTACK_BASE_URL}/transaction/initialize`);
    
    const response = await axios.post(
      `${PAYSTACK_BASE_URL}/transaction/initialize`,
      paystackPayload,
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log(`[${traceId}] Paystack API call successful`);
    console.log(`[${traceId}] Paystack response:`, JSON.stringify(response.data, null, 2));

    // Update pending transaction with reference
    console.log(`[${traceId}] Updating pending transaction with reference: ${response.data.data.reference}`);
    await prisma.pendingTransaction.update({
      where: { id: pendingTx.id },
      data: { reference: response.data.data.reference },
    });

    console.log(`[${traceId}] Paystack SUCCESS:`, {
      reference: response.data.data.reference,
      access_code: response.data.data.access_code,
    });

    console.log(`[${traceId}] Sending response to client`);
    recordPaymentEvent('paystack', pendingTx.type, 'initialized', packagePaymentLogMeta(traceId, pendingTx, metadata, {
      reference: response.data.data.reference,
      gatewayStatus: response.status,
    }));
    res.json({
      success: true,
      data: {
        authorization_url: response.data.data.authorization_url,
        access_code: response.data.data.access_code,
        reference: response.data.data.reference,
      },
    });
  } catch (error: any) {
    recordPaymentEvent('paystack', pendingTx.type, 'failed', packagePaymentLogMeta(traceId, pendingTx, metadata, {
      gatewayStatus: error.response?.status,
      errorMessage: error.message,
    }));
    console.log(`[${traceId}] Paystack error occurred, deleting pending transaction`);
    await prisma.pendingTransaction.delete({ where: { id: pendingTx.id } }).catch(() => {});
    
    console.error(`[${traceId}] ========== PAYSTACK ERROR ==========`);
    console.error(`[${traceId}] Status:`, error.response?.status);
    console.error(`[${traceId}] Response:`, JSON.stringify(error.response?.data, null, 2));
    console.error(`[${traceId}] Message:`, error.message);
    
    if (error.response?.data?.message?.includes('No active channel')) {
      res.status(400).json({ 
        success: false, 
        message: 'Payment channels not activated. Please ensure SYSTEM_SUBACCOUNT_CODE is properly configured in Paystack.' 
      });
    } else {
      res.status(500).json({
        success: false,
        message: error.response?.data?.message || 'Failed to initialize payment',
      });
    }
  }
}

async function initiatePaychanguPayment(
  pendingTx: any,
  ministryAdmin: any,
  fees: any,
  traceId: string,
  res: Response
): Promise<void> {
  console.log(`[${traceId}] initiatePaychanguPayment called`);
  const PAYCHANGU_SECRET_KEY = process.env.PAYCHANGU_SECRET_KEY!;
  console.log(`[${traceId}] Paychangu secret key exists: ${!!PAYCHANGU_SECRET_KEY}`);
  const existingMetadata = pendingTx.metadata ? JSON.parse(pendingTx.metadata) : {};

  try {
    const tx_ref = pendingTx.reference || `PKG-${Date.now()}`;
    console.log(`[${traceId}] Transaction reference: ${tx_ref}`);
    
    const returnUrl = existingMetadata.publicInvoicePayment && existingMetadata.invoicePublicToken
      ? `${process.env.FRONTEND_URL}/invoice/pay/${existingMetadata.invoicePublicToken}?status=cancelled`
      : `${process.env.FRONTEND_URL}/dashboard/packages?status=cancelled`;

    const paychanguPayload = {
      amount: fees.totalAmount,
      currency: 'MWK',
      email: ministryAdmin.email,
      tx_ref,
      callback_url: `${BACKEND_URL}/api/webhooks/paychangu/callback`,
      return_url: returnUrl,
      customization: {
        title: 'Package Subscription',
        description: 'ICIMS Package Subscription'
      }
    };

    await prisma.pendingTransaction.update({
      where: { id: pendingTx.id },
      data: {
        metadata: JSON.stringify({
          ...existingMetadata,
          gatewayPayload: paychanguPayload,
        }),
      },
    });
    
    console.log(`[${traceId}] Paychangu request:`, JSON.stringify(paychanguPayload, null, 2));
    console.log(`[${traceId}] Calling Paychangu API: https://api.paychangu.com/payment`);
    
    const response = await axios.post(
      'https://api.paychangu.com/payment',
      paychanguPayload,
      {
        headers: {
          Authorization: `Bearer ${PAYCHANGU_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log(`[${traceId}] Paychangu API call successful`);
    console.log(`[${traceId}] Paychangu response:`, JSON.stringify(response.data, null, 2));

    // Update pending transaction with reference
    console.log(`[${traceId}] Updating pending transaction with reference: ${tx_ref}`);
    await prisma.pendingTransaction.update({
      where: { id: pendingTx.id },
      data: { reference: tx_ref },
    });

    console.log(`[${traceId}] Paychangu SUCCESS:`, {
      checkout_url: response.data.data?.checkout_url,
    });

    console.log(`[${traceId}] Sending response to client`);
    recordPaymentEvent('paychangu', pendingTx.type, 'initialized', packagePaymentLogMeta(traceId, pendingTx, existingMetadata, {
      reference: tx_ref,
      gatewayStatus: response.status,
    }));
    res.json({
      success: true,
      data: {
        authorization_url: response.data.data?.checkout_url,
        reference: tx_ref,
      },
    });
  } catch (error: any) {
    recordPaymentEvent('paychangu', pendingTx.type, 'failed', packagePaymentLogMeta(traceId, pendingTx, existingMetadata, {
      gatewayStatus: error.response?.status,
      errorMessage: error.message,
    }));
    console.log(`[${traceId}] Paychangu error occurred, deleting pending transaction`);
    await prisma.pendingTransaction.delete({ where: { id: pendingTx.id } }).catch(() => {});
    
    console.error(`[${traceId}] ========== PAYCHANGU ERROR ==========`);
    console.error(`[${traceId}] Status:`, error.response?.status);
    console.error(`[${traceId}] Response:`, JSON.stringify(error.response?.data, null, 2));
    console.error(`[${traceId}] Message:`, error.message);
    
    res.status(500).json({
      success: false,
      message: error.response?.data?.message || 'Failed to initialize payment',
    });
  }
}

export async function verifyPayment(req: Request, res: Response): Promise<void> {
  const { reference } = req.query;
  const traceId = `VERIFY-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  console.log(`[${traceId}] ========== PAYMENT VERIFICATION ==========`);
  console.log(`[${traceId}] Reference: ${reference}`);

  if (!reference) {
    console.log(`[${traceId}] ERROR: Missing reference`);
    res.status(400).json({ success: false, message: 'Reference required' });
    return;
  }

  try {
    console.log(`[${traceId}] Verifying with Paystack...`);
    
    const response = await axios.get(
      `${PAYSTACK_BASE_URL}/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        },
      }
    );

    const { data } = response.data;
    console.log(`[${traceId}] Paystack response:`, {
      status: data.status,
      amount: data.amount,
      currency: data.currency,
      paid_at: data.paid_at,
      metadata: data.metadata,
    });

    if (data.status === 'success') {
      const { metadata } = data;
      const amount = data.amount / 100;
      const type = metadata.type || 'event_ticket';
      const originalTraceId = metadata.traceId || 'UNKNOWN';

      console.log(`[${traceId}] Payment successful - Type: ${type}, Amount: ${amount}`);
      console.log(`[${traceId}] Original trace ID: ${originalTraceId}`);

      // Handle package subscription
      if (type === 'package_subscription') {
        console.log(`[${traceId}] ========== PACKAGE SUBSCRIPTION ==========`);
        console.log(`[${traceId}] ministryAdminId: ${metadata.ministryAdminId}`);
        console.log(`[${traceId}] packageId: ${metadata.packageId}`);
        console.log(`[${traceId}] billingCycle: ${metadata.billingCycle}`);
        console.log(`[${traceId}] pendingTxId: ${metadata.pendingTxId}`);
        console.log(`[${traceId}] initiatedBy: ${metadata.initiatedBy}`);

        const existingPayment = await prisma.payment.findFirst({ where: { reference: data.reference } });
        if (existingPayment) {
          console.log(`[${traceId}] Payment already processed: ${existingPayment.id}`);
          res.redirect(`${process.env.FRONTEND_URL}/payment/callback?reference=${reference}&status=success&type=package_subscription`);
          return;
        }
        console.log(`[${traceId}] No duplicate found — proceeding`);
        
        const pkg = await prisma.package.findUnique({ where: { id: metadata.packageId } });
        console.log(`[${traceId}] Package: ${pkg ? pkg.name : 'NOT FOUND'}`);

        // Get pending transaction
        const pendingTx = await prisma.pendingTransaction.findUnique({
          where: { id: metadata.pendingTxId },
        });
        console.log(`[${traceId}] PendingTransaction: ${pendingTx ? pendingTx.id : 'NOT FOUND'}`);

        // Parse metadata from pending transaction
        const pendingMetadata = pendingTx?.metadata ? JSON.parse(pendingTx.metadata) : {};
        console.log(`[${traceId}] PendingMetadata:`, pendingMetadata);
        const baseAmount = pendingMetadata.baseAmount || amount;
        const convenienceFee = pendingMetadata.convenienceFee || 0;
        const systemFeeAmount = pendingMetadata.systemFeeAmount || 0;
        const ceilRoundingAmount = pendingMetadata.ceilRoundingAmount || 0;
        const totalAmount = pendingMetadata.totalAmount || amount;
        const gateway = pendingMetadata.gateway || 'paystack';
        const gatewayCountry = pendingMetadata.gatewayCountry || 'Kenya';
        const systemGatewayFeeRate = pendingMetadata.gatewayFeeRate || 0;
        const systemFeeRate = pendingMetadata.systemFeeRate || 0;
        console.log(`[${traceId}] Fee breakdown — base: ${baseAmount}, convenience: ${convenienceFee}, systemFee: ${systemFeeAmount}, total: ${totalAmount}`);

        // Create payment record
        const startsAt = pendingMetadata.invoiceServicePeriodStart ? new Date(pendingMetadata.invoiceServicePeriodStart) : new Date(data.paid_at);
        const expiresAt = pendingMetadata.invoiceServicePeriodEnd ? new Date(pendingMetadata.invoiceServicePeriodEnd) : new Date(startsAt);
        if (!pendingMetadata.invoiceServicePeriodEnd) {
          if (metadata.billingCycle === 'monthly') {
            expiresAt.setMonth(expiresAt.getMonth() + 1);
          } else {
            expiresAt.setFullYear(expiresAt.getFullYear() + 1);
          }
        }
        console.log(`[${traceId}] Subscription period — startsAt: ${startsAt.toISOString()}, expiresAt: ${expiresAt.toISOString()}`);

        const payment = await prisma.payment.create({
          data: {
            ministryAdminId: metadata.ministryAdminId,
            packageId: metadata.packageId,
            invoiceId: pendingMetadata.invoiceId || null,
            amount,
            currency: data.currency,
            type: 'package_subscription',
            status: 'completed',
            packageName: pkg?.name || 'Unknown',
            reference: data.reference,
            createdById: metadata.initiatedBy,
            billingCycle: metadata.billingCycle,
            baseAmount,
            convenienceFee,
            systemFeeAmount,
            ceilRoundingAmount,
            totalAmount,
            gateway,
            paymentMethod: data.channel || 'card',
            channel: data.channel,
            paidAt: new Date(data.paid_at),
            customerEmail: data.customer?.email,
            customerPhone: data.customer?.phone,
            cardLast4: data.authorization?.last4,
            cardBank: data.authorization?.bank,
            subaccountCode: data.subaccount?.subaccount_code || SYSTEM_SUBACCOUNT_CODE,
            subaccountName: data.subaccount?.business_name || 'ICIMS System',
            gatewayCharge: data.fees ? data.fees / 100 : 0,
            systemGatewayFeeRate,
            systemFeeRate,
            gatewayPayload: pendingMetadata.gatewayPayload ? JSON.stringify(pendingMetadata.gatewayPayload) : null,
            gatewayResponse: JSON.stringify(data),
            expiresAt,
          },
        });
        console.log(`[${traceId}] Payment record created: ${payment.id}`);
        recordPaymentEvent(gateway, 'package_subscription', 'completed', packagePaymentLogMeta(traceId, pendingTx, {
          ...metadata,
          ...pendingMetadata,
        }, {
          paymentId: payment.id,
          reference: data.reference,
          gatewayStatus: data.status,
          gatewayCharge: payment.gatewayCharge,
        }));
        console.log(`[${traceId}] Payment — amount: ${payment.amount}, currency: ${payment.currency}, gateway: ${payment.gateway}, gatewayCharge: ${payment.gatewayCharge}`);

        if (pendingMetadata.invoiceId) {
          await applyPackagePaymentToInvoices(payment.id, pendingMetadata);
        } else {
          // Create or update subscription and reset email tracking
          await activateSubscriptionFromInvoice({
            ministryAdminId: metadata.ministryAdminId,
            packageId: metadata.packageId,
            servicePeriodStart: startsAt,
            servicePeriodEnd: expiresAt,
          });
        }
        console.log(`[${traceId}] Subscription upserted — ministryAdminId: ${metadata.ministryAdminId}, expiresAt: ${expiresAt.toISOString()}`);

        // Delete pending transaction
        if (pendingTx) {
          await prisma.pendingTransaction.delete({ where: { id: pendingTx.id } });
          console.log(`[${traceId}] Pending transaction deleted`);
        }

        // Send package subscription confirmation email with PDF receipt
        const subscriberUser = await prisma.user.findUnique({ where: { id: metadata.initiatedBy } });
        const packageFeatures = await prisma.packageFeatureLink.findMany({
          where: { packageId: metadata.packageId },
          include: { feature: { select: { displayName: true } } }
        });
        
        if (subscriberUser && pkg) {
          const receiptPDF = await generateReceiptPDF({
            receiptNumber: data.reference,
            type: 'package_subscription',
            customerName: `${subscriberUser.firstName} ${subscriberUser.lastName}`,
            customerEmail: subscriberUser.email,
            amount: baseAmount,
            currency: data.currency,
            paidAt: new Date(data.paid_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
            paymentMethod: data.channel || 'card',
            description: `${pkg.displayName} - ${metadata.billingCycle} subscription`,
            itemDetails: [
              { label: 'Package', value: pkg.displayName },
              { label: 'Billing Cycle', value: metadata.billingCycle },
              { label: 'Expires On', value: expiresAt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) }
            ]
          });
          
          queueEmail(
            subscriberUser.email,
            `Subscription Confirmed - ${pkg.displayName}`,
            packageSubscriptionTemplate({
              firstName: subscriberUser.firstName,
              packageName: pkg.displayName,
              amount: baseAmount,
              currency: data.currency,
              billingCycle: metadata.billingCycle,
              expiresAt: expiresAt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
              features: packageFeatures.map(pf => pf.feature.displayName)
            }),
            [{ filename: `receipt-${data.reference}.pdf`, content: receiptPDF }]
          );
        }

        console.log(`[${traceId}] Redirecting to: /payment/callback?reference=${reference}&status=success&type=package_subscription`);

        res.redirect(`${process.env.FRONTEND_URL}/payment/callback?reference=${reference}&status=success&type=package_subscription`);
      } else if (type === 'event_ticket') {
        console.log(`[${traceId}] Processing event ticket...`);

        const existingTransaction = await prisma.transaction.findFirst({ where: { reference: data.reference } });
        if (existingTransaction) {
          console.log(`[${traceId}] Already processed by webhook: ${existingTransaction.id}`);
          const isGuest = metadata.isGuest === 'true' || metadata.isGuest === true;
          const callbackUrl = isGuest
            ? `${process.env.FRONTEND_URL}/payment/callback?reference=${reference}&status=success&type=event_ticket&isGuest=true&guestEmail=${encodeURIComponent(metadata.guestEmail)}&guestName=${encodeURIComponent(metadata.guestName)}&amount=${metadata.baseAmount}&currency=${data.currency}&eventId=${metadata.eventId}`
            : `${process.env.FRONTEND_URL}/payment/callback?reference=${reference}&status=success&type=event_ticket`;
          res.redirect(callbackUrl);
          return;
        }

        const pendingTx = await prisma.pendingTransaction.findUnique({
          where: { reference: String(reference) }
        });

        if (!pendingTx) {
          console.log(`[${traceId}] Pending transaction not found and no existing transaction`);
          recordPaymentEvent('paystack', 'event_ticket', 'failed', {
            traceId,
            reference: String(reference),
            errorMessage: 'Pending transaction not found',
          });
          res.redirect(`${process.env.FRONTEND_URL}/payment/callback?reference=${reference}&status=failed`);
          return;
        }
        
        const pendingMetadata = pendingTx.metadata ? JSON.parse(pendingTx.metadata) : {};
        console.log(`[${traceId}] Fee breakdown - Base: ${pendingMetadata.baseAmount}, Convenience: ${pendingMetadata.convenienceFee}, System Fee: ${pendingMetadata.systemFeeAmount}, Total: ${pendingMetadata.totalAmount}`);
        const { effectiveUserId, effectiveIsGuest } = getEffectiveDonationDonor(pendingTx, pendingMetadata);
        
        // Create transaction
        const transaction = await prisma.transaction.create({
          data: {
            userId: effectiveUserId || metadata.userId || null,
            churchId: pendingTx.churchId,
            eventId: pendingMetadata.eventId,
            type: 'event_ticket',
            amount: data.amount / 100,
            baseAmount: pendingMetadata.baseAmount,
            convenienceFee: pendingMetadata.convenienceFee,
            systemFeeAmount: pendingMetadata.systemFeeAmount,
            ceilRoundingAmount: pendingMetadata.ceilRoundingAmount || 0,
            totalAmount: pendingMetadata.totalAmount,
            currency: data.currency,
            status: 'completed',
            gateway: pendingMetadata.gateway,
            gatewayCountry: pendingMetadata.gatewayCountry,
            reference: data.reference,
            paymentMethod: data.channel || 'card',
            channel: data.channel,
            paidAt: new Date(data.paid_at),
            customerEmail: data.customer?.email,
            customerPhone: data.customer?.phone,
            cardLast4: data.authorization?.last4,
            cardBank: data.authorization?.bank,
            gatewayCharge: data.fees ? data.fees / 100 : 0,
            systemGatewayFeeRate: pendingMetadata.gatewayFeeRate || 0,
            systemFeeRate: pendingMetadata.systemFeeRate || 0,
            subaccountCode: metadata.subaccountCode || data.subaccount?.subaccount_code,
            subaccountName: metadata.subaccountName || data.subaccount?.business_name,
            gatewayPayload: pendingMetadata.gatewayPayload ? JSON.stringify(pendingMetadata.gatewayPayload) : null,
            gatewayResponse: JSON.stringify(data),
            isGuest: effectiveIsGuest,
            guestName: effectiveIsGuest ? pendingMetadata.guestName : null,
            guestEmail: effectiveIsGuest ? pendingMetadata.guestEmail : null,
            guestPhone: effectiveIsGuest ? pendingMetadata.guestPhone : null,
          }
        });
        
        console.log(`[${traceId}] Transaction created: ${transaction.id}`);
        recordPaymentEvent(pendingMetadata.gateway || 'paystack', pendingTx.type || type, 'completed', eventTicketPaymentLogMeta(traceId, pendingTx, pendingMetadata, {
          transactionId: transaction.id,
          reference: data.reference,
          gatewayStatus: data.status,
          gatewayCharge: transaction.gatewayCharge,
        }));
        console.log(`[${traceId}] Subaccount: ${transaction.subaccountCode} - ${transaction.subaccountName}`);
        console.log(`[${traceId}] Transaction saved with fees - Base: ${transaction.baseAmount}, Convenience: ${transaction.convenienceFee}, System Fee: ${transaction.systemFeeAmount}, Gateway Charge: ${transaction.gatewayCharge}`);
        console.log(`[${traceId}] System fee applied: ${pendingMetadata.systemFeeAmount > 0 ? 'YES' : 'NO'} (${pendingMetadata.gatewayCountry})`);
        
        // Create tickets
        const quantity = pendingMetadata.quantity || 1;
        const event = await prisma.event.findUnique({ where: { id: pendingMetadata.eventId }, include: { church: true } });
        const isGuestTicket = pendingMetadata.isGuest === true;
        const user = isGuestTicket ? null : await prisma.user.findUnique({ where: { id: pendingTx.userId! } });
        
        for (let i = 0; i < quantity; i++) {
          const ticket = await createEventTicketWithUniqueNumber(event!, {
            churchId: pendingTx.churchId || pendingMetadata.churchId || event!.churchId,
            userId: isGuestTicket ? null : pendingTx.userId,
            transactionId: transaction.id,
            status: 'confirmed',
            isGuest: isGuestTicket,
            guestName: isGuestTicket ? pendingMetadata.guestName : null,
            guestEmail: isGuestTicket ? pendingMetadata.guestEmail : null,
            guestPhone: isGuestTicket ? pendingMetadata.guestPhone : null,
          });
          const ticketNumber = ticket.ticketNumber;
          
          // Send email — guest path
          if (isGuestTicket && event) {
            const attendeeName = pendingMetadata.guestName;
            const emailTo = pendingMetadata.guestEmail;
            const ticketPDF = await generateTicketPDF({
              ticketNumber,
              eventTitle: event.title,
              eventDate: new Date(event.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
              eventEndDate: new Date(event.endDate || event.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
              eventLocation: event.location,
              attendeeName,
              churchName: event.church.name,
              amount: pendingMetadata.baseAmount,
              currency: data.currency,
            });
            const receiptPDF = await generateReceiptPDF({
              receiptNumber: data.reference,
              type: 'event_ticket',
              customerName: attendeeName,
              customerEmail: emailTo,
              amount: pendingMetadata.baseAmount,
              currency: data.currency,
              paidAt: new Date(data.paid_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
              paymentMethod: data.channel || 'card',
              description: `Event Ticket - ${event.title}`,
              itemDetails: [
                { label: 'Event', value: event.title },
                { label: 'Church', value: event.church.name },
                { label: 'Date', value: new Date(event.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) },
                { label: 'Location', value: event.location },
                { label: 'Ticket Number', value: ticketNumber },
              ],
            });
            queueEmail(
              emailTo,
              `Ticket Confirmation - ${event.title}`,
              ticketPurchaseTemplate({
                firstName: attendeeName.split(' ')[0],
                eventTitle: event.title,
                ticketNumber,
                amount: pendingMetadata.baseAmount,
                currency: data.currency,
                eventDate: new Date(event.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
                eventEndDate: new Date(event.endDate || event.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
                eventLocation: event.location,
                churchName: event.church.name,
                viewUrl: `${process.env.FRONTEND_URL}/payment/callback?status=success&type=event_ticket&isGuest=true&reference=${data.reference}&guestEmail=${encodeURIComponent(emailTo)}&guestName=${encodeURIComponent(attendeeName)}&amount=${pendingMetadata.baseAmount}&currency=${data.currency}&eventId=${pendingMetadata.eventId}`,
              }),
              [
                { filename: `ticket-${ticketNumber}.pdf`, content: ticketPDF },
                { filename: `receipt-${data.reference}.pdf`, content: receiptPDF },
              ]
            );
          }

          // Send email — registered user path
          if (!isGuestTicket && user && event) {
            const ticketPDF = await generateTicketPDF({
              ticketNumber,
              eventTitle: event.title,
              eventDate: new Date(event.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
              eventEndDate: new Date(event.endDate || event.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
              eventLocation: event.location,
              attendeeName: `${user.firstName} ${user.lastName}`,
              churchName: event.church.name,
              amount: pendingMetadata.baseAmount,
              currency: data.currency,
            });
            const receiptPDF = await generateReceiptPDF({
              receiptNumber: data.reference,
              type: 'event_ticket',
              customerName: `${user.firstName} ${user.lastName}`,
              customerEmail: user.email,
              amount: pendingMetadata.baseAmount,
              currency: data.currency,
              paidAt: new Date(data.paid_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
              paymentMethod: data.channel || 'card',
              description: `Event Ticket - ${event.title}`,
              itemDetails: [
                { label: 'Event', value: event.title },
                { label: 'Church', value: event.church.name },
                { label: 'Date', value: new Date(event.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) },
                { label: 'Location', value: event.location },
                { label: 'Ticket Number', value: ticketNumber },
              ],
            });
            queueEmail(
              user.email,
              `Ticket Confirmation - ${event.title}`,
              ticketPurchaseTemplate({
                firstName: user.firstName,
                eventTitle: event.title,
                ticketNumber,
                amount: pendingMetadata.baseAmount,
                currency: data.currency,
                eventDate: new Date(event.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
                eventEndDate: new Date(event.endDate || event.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
                eventLocation: event.location,
                churchName: event.church.name,
              }),
              [
                { filename: `ticket-${ticketNumber}.pdf`, content: ticketPDF },
                { filename: `receipt-${data.reference}.pdf`, content: receiptPDF },
              ]
            );
          }
        }
        
        // Update event
        await prisma.event.update({
          where: { id: pendingMetadata.eventId },
          data: { ticketsSold: { increment: quantity } }
        });
        
        // Delete pending transaction
        await prisma.pendingTransaction.delete({ where: { id: pendingTx.id } });
        
        console.log(`[${traceId}] ${quantity} ticket(s) created`);
        const ticketCallbackUrl = pendingMetadata.isGuest
          ? `${process.env.FRONTEND_URL}/payment/callback?reference=${reference}&status=success&type=event_ticket&isGuest=true&guestEmail=${encodeURIComponent(pendingMetadata.guestEmail)}&guestName=${encodeURIComponent(pendingMetadata.guestName)}&amount=${pendingMetadata.baseAmount}&currency=${data.currency}&eventId=${pendingMetadata.eventId}`
          : `${process.env.FRONTEND_URL}/payment/callback?reference=${reference}&status=success&type=event_ticket`;
        res.redirect(ticketCallbackUrl);
      } else if (type === 'donation') {
        console.log(`[${traceId}] Processing donation...`);

        const existingTransaction = await prisma.transaction.findFirst({ where: { reference: data.reference } });
        if (existingTransaction) {
          console.log(`[${traceId}] Already processed by webhook: ${existingTransaction.id}`);
          const isGuest = metadata.isGuest === 'true' || metadata.isGuest === true;
          const callbackUrl = isGuest
            ? `${process.env.FRONTEND_URL}/payment/callback?reference=${reference}&status=success&type=donation&isGuest=true&guestEmail=${encodeURIComponent(metadata.guestEmail || '')}&guestName=${encodeURIComponent(metadata.guestName)}&amount=${metadata.baseAmount}&currency=${data.currency}`
            : `${process.env.FRONTEND_URL}/payment/callback?reference=${reference}&status=success&type=donation`;
          res.redirect(callbackUrl);
          return;
        }

        const pendingTx = await prisma.pendingTransaction.findUnique({
          where: { reference: String(reference) }
        });

        if (!pendingTx) {
          console.log(`[${traceId}] Pending transaction not found and no existing transaction`);
          recordPaymentEvent('paystack', 'donation', 'failed', {
            traceId,
            reference: String(reference),
            errorMessage: 'Pending transaction not found',
          });
          res.redirect(`${process.env.FRONTEND_URL}/payment/callback?reference=${reference}&status=failed`);
          return;
        }
        
        const pendingMetadata = pendingTx.metadata ? JSON.parse(pendingTx.metadata) : {};
        console.log(`[${traceId}] Fee breakdown - Base: ${pendingMetadata.baseAmount}, Convenience: ${pendingMetadata.convenienceFee}, System Fee: ${pendingMetadata.systemFeeAmount}, Total: ${pendingMetadata.totalAmount}`);
        const donationDonor = getEffectiveDonationDonor(pendingTx, pendingMetadata);
        
        // Create transaction
        const transaction = await prisma.transaction.create({
          data: {
            userId: donationDonor.effectiveUserId || metadata.userId || null,
            churchId: pendingTx.churchId,
            type: 'donation',
            amount: data.amount / 100,
            baseAmount: pendingMetadata.baseAmount,
            convenienceFee: pendingMetadata.convenienceFee,
            systemFeeAmount: pendingMetadata.systemFeeAmount,
            ceilRoundingAmount: pendingMetadata.ceilRoundingAmount || 0,
            totalAmount: pendingMetadata.totalAmount,
            currency: data.currency,
            status: 'completed',
            gateway: pendingMetadata.gateway,
            gatewayCountry: pendingMetadata.gatewayCountry,
            reference: data.reference,
            paymentMethod: data.channel || 'card',
            channel: data.channel,
            paidAt: new Date(data.paid_at),
            customerEmail: data.customer?.email,
            customerPhone: data.customer?.phone,
            cardLast4: data.authorization?.last4,
            cardBank: data.authorization?.bank,
            gatewayCharge: data.fees ? data.fees / 100 : 0,
            systemGatewayFeeRate: pendingMetadata.gatewayFeeRate || 0,
            systemFeeRate: pendingMetadata.systemFeeRate || 0,
            subaccountCode: metadata.subaccountCode || data.subaccount?.subaccount_code,
            subaccountName: metadata.subaccountName || data.subaccount?.business_name,
            gatewayPayload: pendingMetadata.gatewayPayload ? JSON.stringify(pendingMetadata.gatewayPayload) : null,
            gatewayResponse: JSON.stringify(data),
            isGuest: donationDonor.effectiveIsGuest,
            guestName: donationDonor.effectiveIsGuest ? pendingMetadata.guestName : null,
            guestEmail: donationDonor.effectiveIsGuest ? pendingMetadata.guestEmail : null,
            guestPhone: donationDonor.effectiveIsGuest ? pendingMetadata.guestPhone : null,
          }
        });
        
        console.log(`[${traceId}] Transaction created: ${transaction.id}`);
        recordPaymentEvent(pendingMetadata.gateway || 'paystack', pendingTx.type || type, 'completed', donationPaymentLogMeta(traceId, pendingTx, pendingMetadata, {
          transactionId: transaction.id,
          reference: data.reference,
          gatewayStatus: data.status,
          gatewayCharge: transaction.gatewayCharge,
        }));
        console.log(`[${traceId}] Subaccount: ${transaction.subaccountCode} - ${transaction.subaccountName}`);
        console.log(`[${traceId}] Transaction saved with fees - Base: ${transaction.baseAmount}, Convenience: ${transaction.convenienceFee}, System Fee: ${transaction.systemFeeAmount}, Gateway Charge: ${transaction.gatewayCharge}`);
        console.log(`[${traceId}] System fee applied: ${pendingMetadata.systemFeeAmount > 0 ? 'YES' : 'NO'} (${pendingMetadata.gatewayCountry})`);
        
        await createDonationRecordsForTransaction({
          pendingTx,
          metadata: pendingMetadata,
          transactionId: transaction.id,
          reference: data.reference,
          currency: data.currency,
          paymentMethod: data.channel || 'card',
          gatewayCustomerEmail: data.customer?.email,
        });
        
        // Delete pending transaction
        await prisma.pendingTransaction.delete({ where: { id: pendingTx.id } });
        
        console.log(`[${traceId}] Donation created`);
        const isGuestDonation = pendingMetadata.isGuest === true;
        const donationCallbackUrl = isGuestDonation
          ? `${process.env.FRONTEND_URL}/payment/callback?reference=${reference}&status=success&type=donation&isGuest=true&guestEmail=${encodeURIComponent(pendingMetadata.guestEmail || '')}&guestName=${encodeURIComponent(pendingMetadata.guestName)}&amount=${pendingMetadata.baseAmount}&currency=${data.currency}`
          : `${process.env.FRONTEND_URL}/payment/callback?reference=${reference}&status=success&type=donation`;
        res.redirect(donationCallbackUrl);
      } else {
        // Handle other payment types (event tickets, donations, etc.)
        console.log(`[${traceId}] Other payment type, redirecting to callback`);
        res.redirect(`${process.env.FRONTEND_URL}/payment/callback?reference=${reference}`);
      }
    } else {
      console.log(`[${traceId}] Payment NOT successful - Status: ${data.status}`);
      res.redirect(`${process.env.FRONTEND_URL}/dashboard/packages?reference=${reference}&status=failed`);
    }
  } catch (error: any) {
    console.error(`[${traceId}] ========== VERIFICATION ERROR ==========`);
    console.error(`[${traceId}] Status:`, error.response?.status);
    console.error(`[${traceId}] Response:`, JSON.stringify(error.response?.data, null, 2));
    console.error(`[${traceId}] Message:`, error.message);
    res.redirect(`${process.env.FRONTEND_URL}/dashboard/packages?reference=${reference}&status=error`);
  }
}
