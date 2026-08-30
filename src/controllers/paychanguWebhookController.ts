import { Request, Response } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import axios from 'axios';
import { createDonationRecordsForTransaction } from '../lib/donationCompletion';
import { queueEmail } from '../lib/emailQueue';
import { packageSubscriptionTemplate, ticketPurchaseTemplate, withdrawalFinalStatusTemplate } from '../lib/emailTemplates';
import { generateTicketPDF } from '../lib/ticketPDF';
import { generateReceiptPDF } from '../lib/receiptPDF';
import { refundWithdrawal } from '../utils/walletOperations';
import { queuePaymentProcessing } from '../lib/paymentQueue';
import { recordPaymentEvent, recordWithdrawalEvent } from '../middleware/metrics';
import { maskEmail, maskPhone } from '../utils/logger';
import { createEventTicketWithUniqueNumber } from '../lib/eventTickets';
import { activateSubscriptionFromInvoice, applyPackagePaymentToInvoices } from '../services/packageInvoiceService';
import { getEffectiveDonationDonor } from '../lib/donationMemberMatching';

function safeJsonParse(value: string): any {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function paychanguPaymentLogMeta(traceId: string, pendingTx: any, metadata: any = {}, payload: any = {}, extra: Record<string, unknown> = {}) {
  return {
    traceId,
    pendingTransactionId: pendingTx?.id,
    reference: pendingTx?.reference || payload?.tx_ref,
    chargeId: payload?.charge_id,
    type: pendingTx?.type || payload?.type,
    ministryAdminId: metadata.ministryAdminId,
    packageId: metadata.packageId,
    billingCycle: metadata.billingCycle,
    initiatedBy: metadata.initiatedBy,
    initiatedByName: metadata.initiatedByName,
    eventId: metadata.eventId,
    eventTitle: metadata.eventTitle,
    campaignId: metadata.campaignId,
    campaignName: metadata.campaignName,
    churchId: pendingTx?.churchId || metadata.churchId,
    userId: pendingTx?.userId || metadata.userId,
    userName: metadata.userName,
    isGuest: metadata.isGuest === true,
    guestName: metadata.guestName,
    donorName: metadata.donorName,
    guestEmail: maskEmail(metadata.guestEmail),
    guestPhone: maskPhone(metadata.guestPhone),
    amount: metadata.baseAmount,
    totalAmount: metadata.totalAmount || pendingTx?.amount,
    currency: pendingTx?.currency || payload?.currency,
    gatewayStatus: payload?.status,
    ...extra,
  };
}

function buildGatewayTrace(metadata: any, webhookPayload: any, verifyPayload?: any) {
  return {
    gatewayPayload: metadata.gatewayPayload ? JSON.stringify(metadata.gatewayPayload) : null,
    gatewayResponse: JSON.stringify({
      webhookPayload,
      verifyResponse: verifyPayload ?? null,
    }),
  };
}

function getPaychanguCheckoutData(verifyPayload?: any, webhookPayload?: any) {
  const data = verifyPayload?.data ?? {};
  const channel = String(data.authorization?.channel || webhookPayload?.authorization?.channel || '').toLowerCase();
  const paymentMethod = channel.includes('bank')
    ? 'bank_transfer'
    : channel.includes('card')
      ? 'card'
      : channel.includes('mobile')
        ? 'mobile_money'
        : 'mobile_money';

  return {
    paymentMethod,
    channel: data.authorization?.channel || webhookPayload?.authorization?.channel || null,
    gatewayCharge: data.charges != null ? Number(data.charges) : null,
    customerEmail: data.customer?.email || null,
    customerPhone: data.customer?.phone || data.authorization?.mobile_number || null,
    authorizationCode: data.authorization?.authorization_code || null,
    cardLast4: data.authorization?.card_number ? String(data.authorization.card_number).slice(-4) : null,
    cardBank: data.authorization?.provider || data.authorization?.brand || null,
  };
}

export async function paychanguWebhook(req: Request, res: Response): Promise<void> {
  const traceId = `PAYCHANGU-${Date.now()}`;

  console.log(`[${traceId}] WEBHOOK HIT - Queuing for async processing`);

  // Verify signature
  const signature = req.headers['signature'] as string;
  if (signature) {
    const computedSig = crypto
      .createHmac('sha256', process.env.PAYCHANGU_WEBHOOK_SECRET || process.env.PAYCHANGU_SECRET_KEY!)
      .update(req.rawBody!)
      .digest('hex');
    
    if (computedSig !== signature) {
      console.error(`[${traceId}] Invalid signature`);
      res.status(200).json({ received: false });
      return;
    }
  }

  // Queue for processing - return 200 immediately
  await queuePaymentProcessing({
    gateway: 'paychangu',
    payload: req.body,
  });

  console.log(`[${traceId}] ✅ Queued, returning 200`);
  res.json({ received: true, queued: true });
}

// Process Paychangu payment (called by worker)
export async function processPaychanguPayment(payload: any, traceId: string): Promise<void> {
  try {
    const { tx_ref, status, event_type, charge_id } = payload;

    // Handle payouts
    if (event_type === 'api.payout') {
      if (String(charge_id || '').startsWith('PLATFORM-PAYOUT-')) {
        const platformWithdrawalId = charge_id.replace('PLATFORM-PAYOUT-', '');
        const platformWithdrawal = await (prisma as any).platformWithdrawal.findUnique({ where: { id: platformWithdrawalId } });
        if (!platformWithdrawal) return;
        if (status === 'success' && platformWithdrawal.status !== 'completed') {
          await (prisma as any).platformWithdrawal.update({
            where: { id: platformWithdrawalId },
            data: {
              status: 'completed',
              processedAt: new Date(),
              gatewayResponse: JSON.stringify({
                previous: platformWithdrawal.gatewayResponse ? safeJsonParse(platformWithdrawal.gatewayResponse) : null,
                webhookPayload: payload,
              }),
            },
          });
          recordWithdrawalEvent(platformWithdrawal.method, 'completed', 'platform');
        } else if (status !== 'success' && platformWithdrawal.status !== 'failed') {
          await (prisma as any).platformWithdrawal.update({
            where: { id: platformWithdrawalId },
            data: {
              status: 'failed',
              failureReason: String(payload.message || payload.status || 'Platform payout failed').substring(0, 500),
              gatewayResponse: JSON.stringify({
                previous: platformWithdrawal.gatewayResponse ? safeJsonParse(platformWithdrawal.gatewayResponse) : null,
                webhookPayload: payload,
              }),
            },
          });
          recordWithdrawalEvent(platformWithdrawal.method, 'failed', 'platform');
        }
        return;
      }

      const withdrawalId = charge_id?.replace('PAYOUT-', '');
      if (!withdrawalId) return;

      const withdrawal = await prisma.withdrawal.findUnique({
        where: { id: withdrawalId },
        include: { wallet: { select: { currency: true, church: { select: { name: true } } } } },
      });

      if (!withdrawal) return;

      if (status === 'success' && withdrawal.status !== 'completed') {
        await prisma.withdrawal.update({
          where: { id: withdrawalId },
          data: {
            status: 'completed',
            processedAt: new Date(),
            gatewayResponse: JSON.stringify({
              previous: withdrawal.gatewayResponse ? safeJsonParse(withdrawal.gatewayResponse) : null,
              webhookPayload: payload,
            }),
          },
        });
        recordWithdrawalEvent(withdrawal.method, 'completed', 'ministry');

        if (withdrawal.initiatedBy) {
          const initiator = await prisma.user.findUnique({
            where: { id: withdrawal.initiatedBy },
            select: { firstName: true, email: true },
          });

          if (initiator?.email) {
            await queueEmail(initiator.email, 'Withdrawal Completed',
              withdrawalFinalStatusTemplate({
                firstName: initiator.firstName,
                email: initiator.email,
                amount: withdrawal.amount,
                fee: withdrawal.fee,
                netAmount: withdrawal.netAmount,
                currency: withdrawal.wallet?.currency || 'MWK',
                method: withdrawal.method,
                status: 'completed',
                withdrawalId,
                churchName: withdrawal.wallet?.church?.name,
              }), 'withdrawal_final_status');
          }
        }
      } else if (status !== 'success' && withdrawal.status !== 'failed') {
        await refundWithdrawal(withdrawalId);
        await prisma.withdrawal.update({
          where: { id: withdrawalId },
          data: {
            status: 'failed',
            failureReason: String(payload.message || payload.status || 'Payout failed').substring(0, 500),
            gatewayResponse: JSON.stringify({
              previous: withdrawal.gatewayResponse ? safeJsonParse(withdrawal.gatewayResponse) : null,
              webhookPayload: payload,
            }),
          },
        });
        recordWithdrawalEvent(withdrawal.method, 'failed', 'ministry');
      }
      return;
    }

    if (status !== 'success') {
      console.log(`[${traceId}] Payment not successful, skipping`);
      recordPaymentEvent('paychangu', payload.type || 'unknown', 'failed', {
        traceId,
        reference: tx_ref,
        chargeId: charge_id,
        gatewayStatus: status,
      });
      return;
    }

    // Verify payment with Paychangu API
    const PAYCHANGU_SECRET_KEY = process.env.PAYCHANGU_SECRET_KEY;
    const verifyResponse = await axios.get(
      `https://api.paychangu.com/verify-payment/${tx_ref}`,
      { headers: { Authorization: `Bearer ${PAYCHANGU_SECRET_KEY}` } }
    );

    if (verifyResponse.data.data?.status !== 'success') {
      console.log(`[${traceId}] Verification failed`);
      recordPaymentEvent('paychangu', payload.type || 'unknown', 'failed', {
        traceId,
        reference: tx_ref,
        chargeId: charge_id,
        gatewayStatus: verifyResponse.data.data?.status,
      });
      return;
    }

    const pendingTx = await prisma.pendingTransaction.findUnique({ where: { reference: tx_ref } });
    if (!pendingTx) {
      console.log(`[${traceId}] Pending transaction not found: ${tx_ref}`);
      return;
    }

    const metadata = typeof pendingTx.metadata === 'string' ? JSON.parse(pendingTx.metadata) : pendingTx.metadata;

    // Process based on type
    if (pendingTx.type === 'package_subscription') {
      await processPaychanguSubscription(pendingTx, metadata, payload, traceId, verifyResponse.data);
    } else if (pendingTx.type === 'event_ticket') {
      await processPaychanguTicket(pendingTx, metadata, payload, traceId, verifyResponse.data);
    } else if (pendingTx.type === 'donation') {
      await processPaychanguDonation(pendingTx, metadata, payload, traceId, verifyResponse.data);
    }
    recordPaymentEvent('paychangu', pendingTx.type, 'completed', paychanguPaymentLogMeta(traceId, pendingTx, metadata, payload, {
      verifiedStatus: verifyResponse.data.data?.status,
    }));

    // Successful payments now live in payments/transactions with full payloads.
    // Remove the pending attempt so this table only shows pending, expired, or failed/stuck attempts.
    await prisma.pendingTransaction.delete({ where: { id: pendingTx.id } }).catch(() => {});

    console.log(`[${traceId}] ✅ Payment processed successfully`);

  } catch (error: any) {
    console.error(`[${traceId}] ERROR:`, error.message);
    throw error;
  }
}

// Helper functions for processing different payment types
async function processPaychanguSubscription(pendingTx: any, metadata: any, payload: any, traceId: string, verifyPayload?: any): Promise<void> {
  const existing = await prisma.payment.findFirst({ where: { reference: pendingTx.reference } });
  if (existing) {
    console.log(`[${traceId}] Already processed: ${existing.id}`);
    return;
  }

  const startsAt = metadata.invoiceServicePeriodStart ? new Date(metadata.invoiceServicePeriodStart) : new Date();
  const expiresAt = metadata.invoiceServicePeriodEnd ? new Date(metadata.invoiceServicePeriodEnd) : new Date(startsAt);
  if (!metadata.invoiceServicePeriodEnd) {
    if (metadata.billingCycle === 'monthly') {
      expiresAt.setMonth(expiresAt.getMonth() + 1);
    } else {
      expiresAt.setFullYear(expiresAt.getFullYear() + 1);
    }
  }

  const pkg = await prisma.package.findUnique({
    where: { id: metadata.packageId },
    include: { features: { include: { feature: true } } },
  });

  const checkoutData = getPaychanguCheckoutData(verifyPayload, payload);
  const payment = await prisma.payment.create({
    data: {
      ministryAdminId: metadata.ministryAdminId,
      packageId: metadata.packageId,
      invoiceId: metadata.invoiceId || null,
      packageName: pkg?.name || metadata.packageName || 'Unknown',
      amount: metadata.totalAmount,
      baseAmount: metadata.baseAmount,
      convenienceFee: metadata.convenienceFee,
      systemFeeAmount: metadata.systemFeeAmount,
      ceilRoundingAmount: metadata.ceilRoundingAmount || 0,
      totalAmount: metadata.totalAmount,
      currency: pendingTx.currency,
      type: 'package_subscription',
      status: 'completed',
      gateway: metadata.gateway,
      reference: pendingTx.reference,
      billingCycle: metadata.billingCycle,
      paymentMethod: checkoutData.paymentMethod,
      paidAt: new Date(),
      systemGatewayFeeRate: metadata.gatewayFeeRate || 0,
      systemFeeRate: metadata.systemFeeRate || 0,
      gatewayPayload: metadata.gatewayPayload ? JSON.stringify(metadata.gatewayPayload) : null,
      gatewayResponse: JSON.stringify({ webhookPayload: payload, verifyResponse: verifyPayload ?? null }),
      createdById: pendingTx.userId || metadata.ministryAdminId,
      expiresAt,
    },
  });

  if (metadata.invoiceId) {
    await applyPackagePaymentToInvoices(payment.id, metadata);
  } else {
    await activateSubscriptionFromInvoice({
      ministryAdminId: metadata.ministryAdminId,
      packageId: metadata.packageId,
      servicePeriodStart: startsAt,
      servicePeriodEnd: expiresAt,
    });
  }

  console.log(`[${traceId}] Subscription activated until: ${expiresAt}`);

  const user = await prisma.user.findUnique({
    where: { id: pendingTx.userId! },
    select: { firstName: true, email: true },
  });

  if (user?.email && pkg) {
    await queueEmail(user.email, 'Subscription Confirmed',
      packageSubscriptionTemplate({
        firstName: user.firstName,
        packageName: pkg.displayName,
        amount: metadata.totalAmount,
        currency: pendingTx.currency,
        billingCycle: metadata.billingCycle === 'monthly' ? 'Monthly' : 'Yearly',
        expiresAt: expiresAt.toLocaleDateString(),
        features: pkg.features.map((f: any) => f.feature.displayName),
      }), 'package_subscription');
    console.log(`[${traceId}] Subscription confirmation email queued`);
  }
}

async function processPaychanguTicket(pendingTx: any, metadata: any, payload: any, traceId: string, verifyPayload?: any): Promise<void> {
  console.log(`[${traceId}] Processing ticket for ref: ${pendingTx.reference}`);

  const existing = await prisma.transaction.findFirst({ where: { reference: pendingTx.reference } });
  if (existing) {
    console.log(`[${traceId}] Already processed: ${existing.id}`);
    return;
  }

  const checkoutData = getPaychanguCheckoutData(verifyPayload, payload);
  const gatewayTrace = buildGatewayTrace(metadata, payload, verifyPayload);
  const { effectiveUserId, effectiveIsGuest } = getEffectiveDonationDonor(pendingTx, metadata);
  const transaction = await prisma.transaction.create({
    data: {
      userId: effectiveUserId,
      churchId: pendingTx.churchId,
      eventId: metadata.eventId,
      type: 'event_ticket',
      amount: metadata.totalAmount,
      baseAmount: metadata.baseAmount,
      convenienceFee: metadata.convenienceFee,
      systemFeeAmount: metadata.systemFeeAmount,
      ceilRoundingAmount: metadata.ceilRoundingAmount || 0,
      totalAmount: metadata.totalAmount,
      currency: pendingTx.currency,
      status: 'completed',
      gateway: metadata.gateway,
      gatewayCountry: metadata.gatewayCountry,
      reference: pendingTx.reference,
      paymentMethod: checkoutData.paymentMethod,
      channel: checkoutData.channel,
      paidAt: new Date(),
      gatewayPayload: gatewayTrace.gatewayPayload,
      gatewayResponse: gatewayTrace.gatewayResponse,
      gatewayCharge: checkoutData.gatewayCharge,
      customerEmail: checkoutData.customerEmail,
      customerPhone: checkoutData.customerPhone,
      authorizationCode: checkoutData.authorizationCode,
      cardLast4: checkoutData.cardLast4,
      cardBank: checkoutData.cardBank,
      isGuest: effectiveIsGuest,
      guestName: effectiveIsGuest ? metadata.guestName : null,
      guestEmail: effectiveIsGuest ? metadata.guestEmail : null,
      guestPhone: effectiveIsGuest ? metadata.guestPhone : null,
    },
  });
  console.log(`[${traceId}] Transaction created: ${transaction.id}`);

  const quantity = metadata.quantity || 1;
  const event = await prisma.event.findUnique({ where: { id: metadata.eventId }, include: { church: true } });
  const user = metadata.isGuest ? null : await prisma.user.findUnique({ where: { id: pendingTx.userId! } });
  const isGuest = metadata.isGuest === true;

  for (let i = 0; i < quantity; i++) {
    const ticket = await createEventTicketWithUniqueNumber(event!, {
      churchId: pendingTx.churchId || metadata.churchId || event!.churchId,
      userId: isGuest ? null : pendingTx.userId,
      transactionId: transaction.id,
      status: 'confirmed',
      isGuest,
      guestName: isGuest ? metadata.guestName : null,
      guestEmail: isGuest ? metadata.guestEmail : null,
      guestPhone: isGuest ? metadata.guestPhone : null,
    });
    const ticketNumber = ticket.ticketNumber;

    const attendeeName = isGuest ? metadata.guestName : `${user!.firstName} ${user!.lastName}`;
    const emailTo = isGuest ? metadata.guestEmail : user!.email;

    if (event && emailTo) {
      const ticketPDF = await generateTicketPDF({
        ticketNumber,
        eventTitle: event.title,
        eventDate: new Date(event.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
        eventEndDate: new Date(event.endDate || event.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
        eventLocation: event.location,
        attendeeName,
        churchName: event.church.name,
        amount: metadata.baseAmount,
        currency: pendingTx.currency,
      });
      const receiptPDF = await generateReceiptPDF({
        receiptNumber: pendingTx.reference,
        type: 'event_ticket',
        customerName: attendeeName,
        customerEmail: emailTo,
        amount: metadata.baseAmount,
        currency: pendingTx.currency,
        paidAt: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
        paymentMethod: checkoutData.paymentMethod,
        description: `Event Ticket - ${event.title}`,
        itemDetails: [
          { label: 'Event', value: event.title },
          { label: 'Church', value: event.church.name },
          { label: 'Date', value: new Date(event.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) },
          { label: 'Location', value: event.location },
          { label: 'Ticket Number', value: ticketNumber },
        ],
      });
      await queueEmail(
        emailTo,
        `Ticket Confirmation - ${event.title}`,
        ticketPurchaseTemplate({
          firstName: isGuest ? metadata.guestName.split(' ')[0] : user!.firstName,
          eventTitle: event.title,
          ticketNumber,
          amount: metadata.baseAmount,
          currency: pendingTx.currency,
          eventDate: new Date(event.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
          eventEndDate: new Date(event.endDate || event.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
          eventLocation: event.location,
          churchName: event.church.name,
          ...(isGuest && {
            viewUrl: `${process.env.FRONTEND_URL || 'http://localhost:8080'}/payment/callback?status=success&type=event_ticket&isGuest=true&reference=${pendingTx.reference}&guestEmail=${encodeURIComponent(metadata.guestEmail)}&guestName=${encodeURIComponent(metadata.guestName)}&amount=${metadata.baseAmount}&currency=${pendingTx.currency}&eventId=${metadata.eventId}`,
          }),
        }),
        [
          { filename: `ticket-${ticketNumber}.pdf`, content: ticketPDF },
          { filename: `receipt-${pendingTx.reference}.pdf`, content: receiptPDF },
        ]
      );
    }
  }

  await prisma.event.update({ where: { id: metadata.eventId }, data: { ticketsSold: { increment: quantity } } });
  console.log(`[${traceId}] ✅ Ticket processing complete`);
}

async function processPaychanguDonation(pendingTx: any, metadata: any, payload: any, traceId: string, verifyPayload?: any): Promise<void> {
  console.log(`[${traceId}] Processing donation for ref: ${pendingTx.reference}`);

  const existing = await prisma.transaction.findFirst({ where: { reference: pendingTx.reference } });
  if (existing) {
    console.log(`[${traceId}] Already processed: ${existing.id}`);
    return;
  }

  const checkoutData = getPaychanguCheckoutData(verifyPayload, payload);
  const gatewayTrace = buildGatewayTrace(metadata, payload, verifyPayload);
  const donationDonor = getEffectiveDonationDonor(pendingTx, metadata);
  const transaction = await prisma.transaction.create({
    data: {
      userId: donationDonor.effectiveUserId,
      churchId: pendingTx.churchId,
      type: 'donation',
      amount: metadata.totalAmount,
      baseAmount: metadata.baseAmount,
      convenienceFee: metadata.convenienceFee,
      systemFeeAmount: metadata.systemFeeAmount,
      ceilRoundingAmount: metadata.ceilRoundingAmount || 0,
      totalAmount: metadata.totalAmount,
      currency: pendingTx.currency,
      status: 'completed',
      gateway: metadata.gateway,
      gatewayCountry: metadata.gatewayCountry,
      reference: pendingTx.reference,
      paymentMethod: checkoutData.paymentMethod,
      channel: checkoutData.channel,
      paidAt: new Date(),
      gatewayPayload: gatewayTrace.gatewayPayload,
      gatewayResponse: gatewayTrace.gatewayResponse,
      gatewayCharge: checkoutData.gatewayCharge,
      customerEmail: checkoutData.customerEmail,
      customerPhone: checkoutData.customerPhone,
      authorizationCode: checkoutData.authorizationCode,
      cardLast4: checkoutData.cardLast4,
      cardBank: checkoutData.cardBank,
      isGuest: donationDonor.effectiveIsGuest,
      guestName: donationDonor.effectiveIsGuest ? metadata.guestName : null,
      guestEmail: donationDonor.effectiveIsGuest ? metadata.guestEmail : null,
      guestPhone: donationDonor.effectiveIsGuest ? metadata.guestPhone : null,
    },
  });

  if (Array.isArray(metadata.items) && metadata.items.length > 0) {
    await createDonationRecordsForTransaction({
      pendingTx,
      metadata,
      transactionId: transaction.id,
      reference: pendingTx.reference,
      currency: pendingTx.currency,
      paymentMethod: checkoutData.paymentMethod,
    });
    console.log(`[${traceId}] âœ… Multi-line donation processing complete`);
    return;
  }

  const donationTx = await prisma.donationTransaction.create({
    data: {
      campaignId: metadata.campaignId,
      userId: donationDonor.effectiveUserId,
      churchId: pendingTx.churchId,
      amount: metadata.baseAmount,
      currency: pendingTx.currency,
      transactionId: transaction.id,
      reference: pendingTx.reference,
      status: 'completed',
      isAnonymous: metadata.isAnonymous || false,
      isGuest: donationDonor.effectiveIsGuest,
      guestName: donationDonor.effectiveIsGuest ? metadata.guestName : null,
      guestEmail: donationDonor.effectiveIsGuest ? metadata.guestEmail : null,
      guestPhone: donationDonor.effectiveIsGuest ? metadata.guestPhone : null,
      donorName: metadata.donorName,
      donorPhone: metadata.donorPhone,
      notes: metadata.notes,
      cellId: metadata.cellId || null,
      pledgeId: metadata.pledgeId || null,
    },
  });

  // Pledge auto-link
  if (metadata.pledgeId) {
    const { recalculatePledgeStatus } = await import('./pledgeController');
    await recalculatePledgeStatus(metadata.pledgeId);
  } else if (!donationDonor.effectiveIsGuest && donationDonor.effectiveUserId && metadata.campaignId) {
    const activePledge = await prisma.pledge.findFirst({
      where: { userId: donationDonor.effectiveUserId, campaignId: metadata.campaignId, status: { in: ['pending', 'partial', 'overdue'] } },
    });
    if (activePledge) {
      await prisma.donationTransaction.update({ where: { id: donationTx.id }, data: { pledgeId: activePledge.id } });
      const { recalculatePledgeStatus } = await import('./pledgeController');
      await recalculatePledgeStatus(activePledge.id);
    }
  }

  // Credit church wallet
  const { creditChurchWallet } = await import('../utils/walletOperations');
  await creditChurchWallet(pendingTx.churchId!, metadata.baseAmount, 'donation', transaction.id, `Donation - ${metadata.campaignName || metadata.campaignId}`);

  // Send receipt email
  const isGuest = metadata.isGuest === true;
  const donorEmail = isGuest ? metadata.guestEmail : (await prisma.user.findUnique({ where: { id: pendingTx.userId! }, select: { email: true } }))?.email;
  const donorFirstName = isGuest ? (metadata.guestName?.split(' ')[0] || 'Donor') : (await prisma.user.findUnique({ where: { id: pendingTx.userId! }, select: { firstName: true } }))?.firstName || 'Donor';
  const donorFullName = isGuest ? metadata.guestName : donorFirstName;

  const campaign = await prisma.givingCampaign.findUnique({
    where: { id: metadata.campaignId },
    include: { church: { select: { name: true } } },
  });

  if (donorEmail && campaign) {
    const receiptPDF = await generateReceiptPDF({
      receiptNumber: pendingTx.reference,
      type: 'donation',
      customerName: donorFullName || '',
      customerEmail: donorEmail,
      amount: metadata.baseAmount,
      currency: pendingTx.currency,
      paidAt: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
      paymentMethod: 'mobile_money',
      description: `Donation to ${campaign.name}`,
      itemDetails: [
        { label: 'Campaign', value: campaign.name },
        { label: 'Church', value: campaign.church.name },
        { label: 'Anonymous', value: metadata.isAnonymous ? 'Yes' : 'No' },
      ],
    });
    const { donationReceiptTemplate } = await import('../lib/emailTemplates');
    await queueEmail(
      donorEmail,
      `Donation Receipt - ${campaign.name}`,
      donationReceiptTemplate({
        firstName: donorFirstName,
        amount: metadata.baseAmount,
        currency: pendingTx.currency,
        campaignName: campaign.name,
        reference: pendingTx.reference,
        isAnonymous: metadata.isAnonymous || false,
        isGuest,
        churchName: campaign.church.name,
      }),
      [{ filename: `donation-receipt-${pendingTx.reference}.pdf`, content: receiptPDF }]
    );
  }

  console.log(`[${traceId}] ✅ Donation processing complete`);
}
