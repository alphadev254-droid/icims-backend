import prisma from '../lib/prisma';
import { queueEmail } from '../lib/emailQueue';
import { packageSubscriptionTemplate, ticketPurchaseTemplate } from '../lib/emailTemplates';
import { createDonationRecordsForTransaction, preflightDonationWallets } from '../lib/donationCompletion';
import { getEffectiveDonationDonor } from '../lib/donationMemberMatching';
import { createEventTicketWithUniqueNumber } from '../lib/eventTickets';
import {
  assertPaystackMatchesPendingTransaction,
  clearStalePaystackPending,
  withPaystackReferenceLock,
} from '../lib/paystackCompletionGuards';
import { generateReceiptPDF } from '../lib/receiptPDF';
import { generateTicketPDF } from '../lib/ticketPDF';
import { recordPaymentEvent } from '../middleware/metrics';
import { maskEmail, maskPhone } from '../utils/logger';
import { activateSubscriptionFromInvoice, applyPackagePaymentToInvoices } from './packageInvoiceService';

const SYSTEM_SUBACCOUNT_CODE = process.env.SYSTEM_SUBACCOUNT_CODE!;

export type PaystackCompletionType = 'package_subscription' | 'event_ticket' | 'donation' | string;

export type PaystackCompletionResult = {
  type: PaystackCompletionType;
  reference: string;
  status: 'completed' | 'already_processed' | 'failed' | 'ignored';
  callbackParams?: Record<string, string | number | boolean | null | undefined>;
};

function parseMetadata(value: unknown): any {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value;
}

function packagePaymentLogMeta(traceId: string, pendingTx: any, metadata: any = {}, extra: Record<string, unknown> = {}) {
  return {
    traceId,
    pendingTransactionId: pendingTx?.id,
    reference: pendingTx?.reference,
    ministryAdminId: metadata.ministryAdminId,
    packageId: metadata.packageId,
    packageName: metadata.packageName,
    billingCycle: metadata.billingCycle,
    durationMonths: metadata.durationMonths,
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

function failedResult(type: PaystackCompletionType, reference: string): PaystackCompletionResult {
  return { type, reference, status: 'failed' };
}

function guestCallbackParams(metadata: any, currency: string) {
  return {
    isGuest: true,
    guestEmail: metadata.guestEmail || '',
    guestName: metadata.guestName || '',
    amount: metadata.baseAmount,
    currency,
    eventId: metadata.eventId,
  };
}

async function completePackageSubscription(txData: any, traceId: string, metadata: any): Promise<PaystackCompletionResult> {
  const reference = String(txData.reference);
  const existingPayment = await prisma.payment.findFirst({ where: { reference } });
  if (existingPayment) {
    console.log(`[${traceId}] Package payment already processed: ${existingPayment.id}`);
    await clearStalePaystackPending(reference, metadata.pendingTxId, traceId);
    return { type: 'package_subscription', reference, status: 'already_processed' };
  }

  const pendingTx = metadata.pendingTxId
    ? await prisma.pendingTransaction.findUnique({ where: { id: metadata.pendingTxId } })
    : await prisma.pendingTransaction.findUnique({ where: { reference } });

  if (!pendingTx) {
    console.log(`[${traceId}] Package pending transaction not found`);
    recordPaymentEvent('paystack', 'package_subscription', 'failed', {
      traceId,
      reference,
      errorMessage: 'Pending transaction not found',
    });
    return failedResult('package_subscription', reference);
  }

  assertPaystackMatchesPendingTransaction({
    paystackData: txData,
    pendingTx,
    traceId,
    paymentType: 'package_subscription',
  });

  const pendingMetadata = parseMetadata(pendingTx.metadata);
  const amount = txData.amount / 100;
  const baseAmount = pendingMetadata.baseAmount || amount;
  const convenienceFee = pendingMetadata.convenienceFee || 0;
  const systemFeeAmount = pendingMetadata.systemFeeAmount || 0;
  const ceilRoundingAmount = pendingMetadata.ceilRoundingAmount || 0;
  const totalAmount = pendingMetadata.totalAmount || amount;
  const gateway = pendingMetadata.gateway || 'paystack';
  const systemGatewayFeeRate = pendingMetadata.gatewayFeeRate || 0;
  const systemFeeRate = pendingMetadata.systemFeeRate || 0;
  const startsAt = pendingMetadata.invoiceServicePeriodStart ? new Date(pendingMetadata.invoiceServicePeriodStart) : new Date(txData.paid_at);
  const expiresAt = pendingMetadata.invoiceServicePeriodEnd ? new Date(pendingMetadata.invoiceServicePeriodEnd) : new Date(startsAt);

  if (!pendingMetadata.invoiceServicePeriodEnd) {
    if (metadata.billingCycle === 'monthly') {
      expiresAt.setMonth(expiresAt.getMonth() + 1);
    } else {
      expiresAt.setFullYear(expiresAt.getFullYear() + 1);
    }
  }

  const pkg = await prisma.package.findUnique({ where: { id: metadata.packageId } });
  const payment = await prisma.payment.create({
    data: {
      ministryAdminId: metadata.ministryAdminId,
      packageId: metadata.packageId,
      invoiceId: pendingMetadata.invoiceId || null,
      amount,
      currency: txData.currency,
      type: 'package_subscription',
      status: 'completed',
      packageName: pkg?.name || 'Unknown',
      reference,
      createdById: metadata.initiatedBy,
      billingCycle: metadata.billingCycle,
      baseAmount,
      convenienceFee,
      systemFeeAmount,
      ceilRoundingAmount,
      totalAmount,
      gateway,
      paymentMethod: txData.channel || 'card',
      channel: txData.channel,
      paidAt: new Date(txData.paid_at),
      customerEmail: txData.customer?.email,
      customerPhone: txData.customer?.phone,
      cardLast4: txData.authorization?.last4,
      cardBank: txData.authorization?.bank,
      subaccountCode: txData.subaccount?.subaccount_code || SYSTEM_SUBACCOUNT_CODE,
      subaccountName: txData.subaccount?.business_name || 'ICIMS System',
      gatewayCharge: txData.fees ? txData.fees / 100 : 0,
      systemGatewayFeeRate,
      systemFeeRate,
      gatewayPayload: pendingMetadata.gatewayPayload ? JSON.stringify(pendingMetadata.gatewayPayload) : null,
      gatewayResponse: JSON.stringify(txData),
      expiresAt,
    },
  });

  recordPaymentEvent(gateway, 'package_subscription', 'completed', packagePaymentLogMeta(traceId, pendingTx, {
    ...metadata,
    ...pendingMetadata,
  }, {
    paymentId: payment.id,
    reference,
    gatewayStatus: txData.status,
    gatewayCharge: payment.gatewayCharge,
  }));

  if (pendingMetadata.invoiceId) {
    await applyPackagePaymentToInvoices(payment.id, pendingMetadata);
  } else {
    await activateSubscriptionFromInvoice({
      ministryAdminId: metadata.ministryAdminId,
      packageId: metadata.packageId,
      servicePeriodStart: startsAt,
      servicePeriodEnd: expiresAt,
    });
  }

  await prisma.pendingTransaction.delete({ where: { id: pendingTx.id } });

  const subscriberUser = await prisma.user.findUnique({ where: { id: metadata.initiatedBy } });
  const packageFeatures = await prisma.packageFeatureLink.findMany({
    where: { packageId: metadata.packageId },
    include: { feature: { select: { displayName: true } } },
  });

  if (subscriberUser && pkg) {
    const receiptPDF = await generateReceiptPDF({
      receiptNumber: reference,
      type: 'package_subscription',
      customerName: `${subscriberUser.firstName} ${subscriberUser.lastName}`,
      customerEmail: subscriberUser.email,
      amount: baseAmount,
      currency: txData.currency,
      paidAt: new Date(txData.paid_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
      paymentMethod: txData.channel || 'card',
      description: `${pkg.displayName} - ${metadata.billingCycle} subscription`,
      itemDetails: [
        { label: 'Package', value: pkg.displayName },
        { label: 'Billing Cycle', value: metadata.billingCycle },
        { label: 'Expires On', value: expiresAt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) },
      ],
    });

    queueEmail(
      subscriberUser.email,
      `Subscription Confirmed - ${pkg.displayName}`,
      packageSubscriptionTemplate({
        firstName: subscriberUser.firstName,
        packageName: pkg.displayName,
        amount: baseAmount,
        currency: txData.currency,
        billingCycle: metadata.billingCycle,
        expiresAt: expiresAt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
        features: packageFeatures.map(pf => pf.feature.displayName),
      }),
      [{ filename: `receipt-${reference}.pdf`, content: receiptPDF }],
    );
  }

  return { type: 'package_subscription', reference, status: 'completed' };
}

async function completeEventTicket(txData: any, traceId: string, metadata: any): Promise<PaystackCompletionResult> {
  const reference = String(txData.reference);
  const existingTransaction = await prisma.transaction.findFirst({ where: { reference } });
  if (existingTransaction) {
    console.log(`[${traceId}] Event ticket already processed: ${existingTransaction.id}`);
    await clearStalePaystackPending(reference, null, traceId);
    const isGuest = metadata.isGuest === 'true' || metadata.isGuest === true;
    return {
      type: 'event_ticket',
      reference,
      status: 'already_processed',
      callbackParams: isGuest ? guestCallbackParams(metadata, txData.currency) : undefined,
    };
  }

  const pendingTx = await prisma.pendingTransaction.findUnique({ where: { reference } });
  if (!pendingTx) {
    console.log(`[${traceId}] Event ticket pending transaction not found`);
    recordPaymentEvent('paystack', 'event_ticket', 'failed', {
      traceId,
      reference,
      errorMessage: 'Pending transaction not found',
    });
    return failedResult('event_ticket', reference);
  }

  assertPaystackMatchesPendingTransaction({
    paystackData: txData,
    pendingTx,
    traceId,
    paymentType: 'event_ticket',
  });

  const pendingMetadata = parseMetadata(pendingTx.metadata);
  const amount = txData.amount / 100;
  const { effectiveUserId, effectiveIsGuest } = getEffectiveDonationDonor(pendingTx, pendingMetadata);
  const transaction = await prisma.transaction.create({
    data: {
      userId: effectiveUserId || metadata.userId || null,
      churchId: pendingTx.churchId,
      eventId: pendingMetadata.eventId,
      type: 'event_ticket',
      amount,
      baseAmount: pendingMetadata.baseAmount,
      convenienceFee: pendingMetadata.convenienceFee,
      systemFeeAmount: pendingMetadata.systemFeeAmount,
      ceilRoundingAmount: pendingMetadata.ceilRoundingAmount || 0,
      totalAmount: pendingMetadata.totalAmount,
      currency: txData.currency,
      status: 'completed',
      gateway: pendingMetadata.gateway,
      gatewayCountry: pendingMetadata.gatewayCountry,
      reference,
      paymentMethod: txData.channel || 'card',
      channel: txData.channel,
      paidAt: new Date(txData.paid_at),
      customerEmail: txData.customer?.email,
      customerPhone: txData.customer?.phone,
      cardLast4: txData.authorization?.last4,
      cardBank: txData.authorization?.bank,
      gatewayCharge: txData.fees ? txData.fees / 100 : 0,
      systemGatewayFeeRate: pendingMetadata.gatewayFeeRate || 0,
      systemFeeRate: pendingMetadata.systemFeeRate || 0,
      subaccountCode: metadata.subaccountCode || txData.subaccount?.subaccount_code,
      subaccountName: metadata.subaccountName || txData.subaccount?.business_name,
      gatewayPayload: pendingMetadata.gatewayPayload ? JSON.stringify(pendingMetadata.gatewayPayload) : null,
      gatewayResponse: JSON.stringify(txData),
      isGuest: effectiveIsGuest,
      guestName: effectiveIsGuest ? pendingMetadata.guestName : null,
      guestEmail: effectiveIsGuest ? pendingMetadata.guestEmail : null,
      guestPhone: effectiveIsGuest ? pendingMetadata.guestPhone : null,
    },
  });

  recordPaymentEvent(pendingMetadata.gateway || 'paystack', pendingTx.type || 'event_ticket', 'completed', eventTicketPaymentLogMeta(traceId, pendingTx, pendingMetadata, {
    transactionId: transaction.id,
    reference,
    gatewayStatus: txData.status,
    gatewayCharge: transaction.gatewayCharge,
  }));

  const quantity = pendingMetadata.quantity || 1;
  const event = await prisma.event.findUnique({ where: { id: pendingMetadata.eventId }, include: { church: true } });
  const isGuest = pendingMetadata.isGuest === true;
  const user = isGuest ? null : await prisma.user.findUnique({ where: { id: pendingTx.userId! } });

  for (let i = 0; i < quantity; i++) {
    const ticket = await createEventTicketWithUniqueNumber(event!, {
      churchId: pendingTx.churchId || pendingMetadata.churchId || event!.churchId,
      userId: isGuest ? null : pendingTx.userId,
      transactionId: transaction.id,
      status: 'confirmed',
      isGuest,
      guestName: isGuest ? pendingMetadata.guestName : null,
      guestEmail: isGuest ? pendingMetadata.guestEmail : null,
      guestPhone: isGuest ? pendingMetadata.guestPhone : null,
    });

    const attendeeName = isGuest ? pendingMetadata.guestName : `${user!.firstName} ${user!.lastName}`;
    const emailTo = isGuest ? pendingMetadata.guestEmail : user!.email;
    if (!event || !emailTo) continue;

    const ticketPDF = await generateTicketPDF({
      ticketNumber: ticket.ticketNumber,
      eventTitle: event.title,
      eventDate: new Date(event.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
      eventEndDate: new Date(event.endDate || event.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
      eventLocation: event.location,
      attendeeName,
      churchName: event.church.name,
      amount: pendingMetadata.baseAmount,
      currency: txData.currency,
    });
    const receiptPDF = await generateReceiptPDF({
      receiptNumber: reference,
      type: 'event_ticket',
      customerName: attendeeName,
      customerEmail: emailTo,
      amount: pendingMetadata.baseAmount,
      currency: txData.currency,
      paidAt: new Date(txData.paid_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
      paymentMethod: txData.channel || 'card',
      description: `Event Ticket - ${event.title}`,
      itemDetails: [
        { label: 'Event', value: event.title },
        { label: 'Church', value: event.church.name },
        { label: 'Date', value: new Date(event.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) },
        { label: 'Location', value: event.location },
        { label: 'Ticket Number', value: ticket.ticketNumber },
      ],
    });

    queueEmail(
      emailTo,
      `Ticket Confirmation - ${event.title}`,
      ticketPurchaseTemplate({
        firstName: isGuest ? pendingMetadata.guestName.split(' ')[0] : user!.firstName,
        eventTitle: event.title,
        ticketNumber: ticket.ticketNumber,
        amount: pendingMetadata.baseAmount,
        currency: txData.currency,
        eventDate: new Date(event.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
        eventEndDate: new Date(event.endDate || event.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
        eventLocation: event.location,
        churchName: event.church.name,
        ...(isGuest && {
          viewUrl: `${process.env.FRONTEND_URL || 'http://localhost:8080'}/payment/callback?status=success&type=event_ticket&isGuest=true&reference=${reference}&guestEmail=${encodeURIComponent(pendingMetadata.guestEmail)}&guestName=${encodeURIComponent(pendingMetadata.guestName)}&amount=${pendingMetadata.baseAmount}&currency=${txData.currency}&eventId=${pendingMetadata.eventId}`,
        }),
      }),
      [
        { filename: `ticket-${ticket.ticketNumber}.pdf`, content: ticketPDF },
        { filename: `receipt-${reference}.pdf`, content: receiptPDF },
      ],
    );
  }

  await prisma.event.update({ where: { id: pendingMetadata.eventId }, data: { ticketsSold: { increment: quantity } } });
  await prisma.pendingTransaction.delete({ where: { id: pendingTx.id } });

  return {
    type: 'event_ticket',
    reference,
    status: 'completed',
    callbackParams: isGuest ? guestCallbackParams(pendingMetadata, txData.currency) : undefined,
  };
}

async function completeDonation(txData: any, traceId: string, metadata: any): Promise<PaystackCompletionResult> {
  const reference = String(txData.reference);
  const existingTransaction = await prisma.transaction.findFirst({ where: { reference } });
  if (existingTransaction) {
    console.log(`[${traceId}] Donation already processed: ${existingTransaction.id}`);
    await clearStalePaystackPending(reference, null, traceId);
    const isGuest = metadata.isGuest === 'true' || metadata.isGuest === true;
    return {
      type: 'donation',
      reference,
      status: 'already_processed',
      callbackParams: isGuest ? guestCallbackParams(metadata, txData.currency) : undefined,
    };
  }

  const pendingTx = await prisma.pendingTransaction.findUnique({ where: { reference } });
  if (!pendingTx) {
    console.log(`[${traceId}] Donation pending transaction not found`);
    recordPaymentEvent('paystack', 'donation', 'failed', {
      traceId,
      reference,
      errorMessage: 'Pending transaction not found',
    });
    return failedResult('donation', reference);
  }

  assertPaystackMatchesPendingTransaction({
    paystackData: txData,
    pendingTx,
    traceId,
    paymentType: 'donation',
  });

  const pendingMetadata = parseMetadata(pendingTx.metadata);
  const amount = txData.amount / 100;
  const donationDonor = getEffectiveDonationDonor(pendingTx, pendingMetadata);
  await preflightDonationWallets({
    pendingTx,
    metadata: pendingMetadata,
    reference,
    currency: txData.currency,
  });

  const transaction = await prisma.transaction.create({
    data: {
      userId: donationDonor.effectiveUserId || metadata.userId || null,
      churchId: pendingTx.churchId,
      type: 'donation',
      amount,
      baseAmount: pendingMetadata.baseAmount,
      convenienceFee: pendingMetadata.convenienceFee,
      systemFeeAmount: pendingMetadata.systemFeeAmount,
      ceilRoundingAmount: pendingMetadata.ceilRoundingAmount || 0,
      totalAmount: pendingMetadata.totalAmount,
      currency: txData.currency,
      status: 'completed',
      gateway: pendingMetadata.gateway,
      gatewayCountry: pendingMetadata.gatewayCountry,
      reference,
      paymentMethod: txData.channel || 'card',
      channel: txData.channel,
      paidAt: new Date(txData.paid_at),
      customerEmail: txData.customer?.email,
      customerPhone: txData.customer?.phone,
      cardLast4: txData.authorization?.last4,
      cardBank: txData.authorization?.bank,
      gatewayCharge: txData.fees ? txData.fees / 100 : 0,
      systemGatewayFeeRate: pendingMetadata.gatewayFeeRate || 0,
      systemFeeRate: pendingMetadata.systemFeeRate || 0,
      subaccountCode: metadata.subaccountCode || txData.subaccount?.subaccount_code,
      subaccountName: metadata.subaccountName || txData.subaccount?.business_name,
      gatewayPayload: pendingMetadata.gatewayPayload ? JSON.stringify(pendingMetadata.gatewayPayload) : null,
      gatewayResponse: JSON.stringify(txData),
      isGuest: donationDonor.effectiveIsGuest,
      guestName: donationDonor.effectiveIsGuest ? pendingMetadata.guestName : null,
      guestEmail: donationDonor.effectiveIsGuest ? pendingMetadata.guestEmail : null,
      guestPhone: donationDonor.effectiveIsGuest ? pendingMetadata.guestPhone : null,
    },
  });

  recordPaymentEvent(pendingMetadata.gateway || 'paystack', pendingTx.type || 'donation', 'completed', donationPaymentLogMeta(traceId, pendingTx, pendingMetadata, {
    transactionId: transaction.id,
    reference,
    gatewayStatus: txData.status,
    gatewayCharge: transaction.gatewayCharge,
  }));

  await createDonationRecordsForTransaction({
    pendingTx,
    metadata: pendingMetadata,
    transactionId: transaction.id,
    reference,
    currency: txData.currency,
    paymentMethod: txData.channel || 'card',
    gatewayCustomerEmail: txData.customer?.email,
  });

  await prisma.pendingTransaction.delete({ where: { id: pendingTx.id } });

  return {
    type: 'donation',
    reference,
    status: 'completed',
    callbackParams: pendingMetadata.isGuest === true ? guestCallbackParams(pendingMetadata, txData.currency) : undefined,
  };
}

export async function completePaystackPayment(txData: any, traceId: string): Promise<PaystackCompletionResult> {
  const reference = String(txData.reference);
  const metadata = txData.metadata || {};
  const type = metadata.type || 'event_ticket';

  return withPaystackReferenceLock(reference, traceId, async () => {
    console.log(`[${traceId}] Completing Paystack payment - type: ${type}, reference: ${reference}`);

    if (type === 'package_subscription') {
      return completePackageSubscription(txData, traceId, metadata);
    }
    if (type === 'event_ticket') {
      return completeEventTicket(txData, traceId, metadata);
    }
    if (type === 'donation') {
      return completeDonation(txData, traceId, metadata);
    }

    console.log(`[${traceId}] Unsupported Paystack payment type: ${type}`);
    return { type, reference, status: 'ignored' };
  });
}

export function buildPaystackCallbackUrl(result: PaystackCompletionResult, frontendUrl = process.env.FRONTEND_URL || ''): string {
  const status = result.status === 'failed' ? 'failed' : 'success';
  const params = new URLSearchParams({
    reference: result.reference,
    status,
    type: result.type,
  });

  for (const [key, value] of Object.entries(result.callbackParams || {})) {
    if (value !== undefined && value !== null) {
      params.set(key, String(value));
    }
  }

  return `${frontendUrl}/payment/callback?${params.toString()}`;
}
