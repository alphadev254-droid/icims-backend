import { Request, Response } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import { queueEmail } from '../lib/emailQueue';
import { packageSubscriptionTemplate, ticketPurchaseTemplate, donationReceiptTemplate } from '../lib/emailTemplates';
import { generateTicketPDF } from '../lib/ticketPDF';
import { generateReceiptPDF } from '../lib/receiptPDF';
import { queuePaymentProcessing } from '../lib/paymentQueue';
import { createDonationRecordsForTransaction } from '../lib/donationCompletion';
import { createEventTicketWithUniqueNumber } from '../lib/eventTickets';
import { activateSubscriptionFromInvoice, applyPackagePaymentToInvoices } from '../services/packageInvoiceService';
import { getEffectiveDonationDonor } from '../lib/donationMemberMatching';

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY!;
const PAYSTACK_BASE_URL = process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co';
const SYSTEM_SUBACCOUNT_CODE = process.env.SYSTEM_SUBACCOUNT_CODE!;

function verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
  const hash = crypto
    .createHmac('sha512', PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

export async function paystackWebhook(req: Request, res: Response): Promise<void> {
  const traceId = `PAYSTACK-${Date.now()}`;

  console.log(`[${traceId}] WEBHOOK HIT - Queuing for async processing`);

  // Verify signature
  const signature = req.headers['x-paystack-signature'] as string;
  if (!signature || !req.rawBody || !verifyWebhookSignature(req.rawBody, signature)) {
    console.error(`[${traceId}] Invalid signature`);
    res.status(401).json({ received: false });
    return;
  }

  const { event, data } = req.body;
  if (event !== 'charge.success') {
    res.json({ received: true });
    return;
  }

  // Queue for processing - return 200 immediately
  await queuePaymentProcessing({
    gateway: 'paystack',
    payload: req.body,
  });

  console.log(`[${traceId}] ✅ Queued, returning 200`);
  res.json({ received: true, queued: true });
}

// Process Paystack payment (called by worker)
export async function processPaystackPayment(payload: any, traceId: string): Promise<void> {
  try {
  const { data } = payload;
  const reference = data.reference;

  console.log(`[${traceId}] Processing Paystack payment - ref: ${reference}`);

  // Verify with Paystack API
  const axios = (await import('axios')).default;
  const verifyResponse = await axios.get(
    `${process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co'}/transaction/verify/${reference}`,
    { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
  );

  if (verifyResponse.data.data?.status !== 'success') {
    console.log(`[${traceId}] Verification failed`);
    return;
  }

  const txData = verifyResponse.data.data;
  const { metadata } = txData;
  const type = metadata?.type || 'event_ticket';

  console.log(`[${traceId}] Verified - type: ${type}`);
  // Continue processing...

    if (type === 'package_subscription') {
      console.log(`[${traceId}] ========== PACKAGE SUBSCRIPTION ==========`);
      console.log(`[${traceId}] ministryAdminId: ${metadata.ministryAdminId}`);
      console.log(`[${traceId}] packageId: ${metadata.packageId}`);
      console.log(`[${traceId}] billingCycle: ${metadata.billingCycle}`);
      console.log(`[${traceId}] pendingTxId: ${metadata.pendingTxId}`);
      console.log(`[${traceId}] initiatedBy: ${metadata.initiatedBy}`);

      const existingPayment = await prisma.payment.findFirst({ where: { reference: txData.reference } });
      if (existingPayment) {
        console.log(`[${traceId}] Already processed: ${existingPayment.id}`);
        return;
      }
      console.log(`[${traceId}] No duplicate found — proceeding`);

      const amount = txData.amount / 100;

      const pendingTx = await prisma.pendingTransaction.findUnique({ where: { id: metadata.pendingTxId } });
      console.log(`[${traceId}] PendingTransaction found: ${pendingTx ? pendingTx.id : 'NOT FOUND'}`);
      const pendingMetadata = pendingTx?.metadata ? JSON.parse(pendingTx.metadata) : {};
      console.log(`[${traceId}] PendingMetadata:`, pendingMetadata);

      const baseAmount = pendingMetadata.baseAmount || (txData.amount / 100);
      const convenienceFee = pendingMetadata.convenienceFee || 0;
      const systemFeeAmount = pendingMetadata.systemFeeAmount || 0;
      const ceilRoundingAmount = pendingMetadata.ceilRoundingAmount || 0;
      const totalAmount = pendingMetadata.totalAmount || amount;
      const gateway = pendingMetadata.gateway || 'paystack';
      const systemGatewayFeeRate = pendingMetadata.gatewayFeeRate || 0;
      const systemFeeRate = pendingMetadata.systemFeeRate || 0;

      console.log(`[${traceId}] Fee breakdown — base: ${baseAmount}, convenience: ${convenienceFee}, systemFee: ${systemFeeAmount}, total: ${totalAmount}`);

      const startsAt = metadata.invoiceServicePeriodStart ? new Date(metadata.invoiceServicePeriodStart) : new Date(txData.paid_at);
      const expiresAt = metadata.invoiceServicePeriodEnd ? new Date(metadata.invoiceServicePeriodEnd) : new Date(startsAt);
      if (!metadata.invoiceServicePeriodEnd) {
        if (metadata.billingCycle === 'monthly') {
          expiresAt.setMonth(expiresAt.getMonth() + 1);
        } else {
          expiresAt.setFullYear(expiresAt.getFullYear() + 1);
        }
      }
      console.log(`[${traceId}] Subscription period — startsAt: ${startsAt.toISOString()}, expiresAt: ${expiresAt.toISOString()}`);

      const pkg = await prisma.package.findUnique({ where: { id: metadata.packageId } });
      console.log(`[${traceId}] Package: ${pkg ? pkg.name : 'NOT FOUND'}`);

      const payment = await prisma.payment.create({
        data: {
          ministryAdminId: metadata.ministryAdminId,
          packageId: metadata.packageId,
          invoiceId: metadata.invoiceId || null,
          amount,
          currency: txData.currency,
          type: 'package_subscription',
          status: 'completed',
          packageName: pkg?.name || 'Unknown',
          reference: txData.reference,
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
      console.log(`[${traceId}] Payment record created: ${payment.id}`);

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

      if (pendingTx) await prisma.pendingTransaction.delete({ where: { id: pendingTx.id } });

      const subscriberUser = await prisma.user.findUnique({ where: { id: metadata.initiatedBy } });
      const packageFeatures = await prisma.packageFeatureLink.findMany({
        where: { packageId: metadata.packageId },
        include: { feature: { select: { displayName: true } } }
      });

      if (subscriberUser && pkg) {
        const receiptPDF = await generateReceiptPDF({
          receiptNumber: txData.reference,
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
            currency: txData.currency,
            billingCycle: metadata.billingCycle,
            expiresAt: expiresAt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
            features: packageFeatures.map(pf => pf.feature.displayName)
          }),
          [{ filename: `receipt-${txData.reference}.pdf`, content: receiptPDF }]
        );
      }

    } else if (type === 'event_ticket') {
      const existingTransaction = await prisma.transaction.findFirst({ where: { reference: txData.reference } });
      if (existingTransaction) {
        console.log(`[${traceId}] Already processed: ${existingTransaction.id}`);
        return;
      }

      const pendingTx = await prisma.pendingTransaction.findUnique({ where: { reference: txData.reference } });
      if (!pendingTx) {
        console.log(`[${traceId}] Pending transaction not found`);
        return;
      }

      const pendingMetadata = pendingTx.metadata ? JSON.parse(pendingTx.metadata) : {};
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
          reference: txData.reference,
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
        }
      });
      console.log(`[${traceId}] Transaction created: ${transaction.id}`);

      const quantity = pendingMetadata.quantity || 1;
      const event = await prisma.event.findUnique({ where: { id: pendingMetadata.eventId }, include: { church: true } });
      const user = pendingMetadata.isGuest ? null : await prisma.user.findUnique({ where: { id: pendingTx.userId! } });
      const isGuest = pendingMetadata.isGuest === true;

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
        const ticketNumber = ticket.ticketNumber;

        const attendeeName = isGuest
          ? pendingMetadata.guestName
          : `${user!.firstName} ${user!.lastName}`;
        const emailTo = isGuest ? pendingMetadata.guestEmail : user!.email;

        if (event && emailTo) {
          const ticketPDF = await generateTicketPDF({
            ticketNumber,
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
            receiptNumber: txData.reference,
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
              { label: 'Ticket Number', value: ticketNumber }
            ]
          });
          queueEmail(
            emailTo,
            `Ticket Confirmation - ${event.title}`,
            ticketPurchaseTemplate({
              firstName: isGuest ? pendingMetadata.guestName.split(' ')[0] : user!.firstName,
              eventTitle: event.title,
              ticketNumber,
              amount: pendingMetadata.baseAmount,
              currency: txData.currency,
              eventDate: new Date(event.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
              eventEndDate: new Date(event.endDate || event.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
              eventLocation: event.location,
              churchName: event.church.name,
              ...(isGuest && {
                viewUrl: `${process.env.FRONTEND_URL || 'http://localhost:8080'}/payment/callback?status=success&type=event_ticket&isGuest=true&reference=${txData.reference}&guestEmail=${encodeURIComponent(pendingMetadata.guestEmail)}&guestName=${encodeURIComponent(pendingMetadata.guestName)}&amount=${pendingMetadata.baseAmount}&currency=${txData.currency}&eventId=${pendingMetadata.eventId}`,
              }),
            }),
            [
              { filename: `ticket-${ticketNumber}.pdf`, content: ticketPDF },
              { filename: `receipt-${txData.reference}.pdf`, content: receiptPDF }
            ]
          );
        }
      }

      await prisma.event.update({ where: { id: pendingMetadata.eventId }, data: { ticketsSold: { increment: quantity } } });
      await prisma.pendingTransaction.delete({ where: { id: pendingTx.id } });

    } else if (type === 'donation') {
      const existingTransaction = await prisma.transaction.findFirst({ where: { reference: txData.reference } });
      if (existingTransaction) {
        console.log(`[${traceId}] Already processed: ${existingTransaction.id}`);
        return;
      }

      const pendingTx = await prisma.pendingTransaction.findUnique({ where: { reference: txData.reference } });
      if (!pendingTx) {
        console.log(`[${traceId}] Pending transaction not found`);
        return;
      }

      const pendingMetadata = pendingTx.metadata ? JSON.parse(pendingTx.metadata) : {};
      const amount = txData.amount / 100;
      const donationDonor = getEffectiveDonationDonor(pendingTx, pendingMetadata);

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
          reference: txData.reference,
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
        }
      });
      console.log(`[${traceId}] Transaction created: ${transaction.id}`);

      await createDonationRecordsForTransaction({
        pendingTx,
        metadata: pendingMetadata,
        transactionId: transaction.id,
        reference: txData.reference,
        currency: txData.currency,
        paymentMethod: txData.channel || 'card',
        gatewayCustomerEmail: txData.customer?.email,
      });

      await prisma.pendingTransaction.delete({ where: { id: pendingTx.id } });
    }

    console.log(`[${traceId}] Webhook processed successfully`);

  } catch (error: any) {
    console.error(`[${traceId}] ERROR:`, error.message);
    throw error;
  }
}
