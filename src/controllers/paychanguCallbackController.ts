import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import axios from 'axios';
import { createDonationRecordsForTransaction } from '../lib/donationCompletion';
import { queueEmail } from '../lib/emailQueue';
import { packageSubscriptionTemplate } from '../lib/emailTemplates';
import { generateReceiptPDF } from '../lib/receiptPDF';
import { createEventTicketWithUniqueNumber } from '../lib/eventTickets';
import { activateSubscriptionFromInvoice, recalculatePackageInvoice } from '../services/packageInvoiceService';
import { getEffectiveDonationDonor } from '../lib/donationMemberMatching';

function buildGatewayTrace(metadata: any, callbackQuery: any, verifyResponse: any) {
  return {
    gatewayPayload: metadata.gatewayPayload ? JSON.stringify(metadata.gatewayPayload) : null,
    gatewayResponse: JSON.stringify({
      callbackQuery,
      verifyResponse,
    }),
  };
}

function getPaychanguCheckoutData(verifyResponse: any) {
  const data = verifyResponse?.data ?? {};
  const channel = String(data.authorization?.channel || '').toLowerCase();
  const paymentMethod = channel.includes('bank')
    ? 'bank_transfer'
    : channel.includes('card')
      ? 'card'
      : channel.includes('mobile')
        ? 'mobile_money'
        : 'mobile_money';

  return {
    paymentMethod,
    channel: data.authorization?.channel || null,
    gatewayCharge: data.charges != null ? Number(data.charges) : null,
    customerEmail: data.customer?.email || null,
    customerPhone: data.customer?.phone || data.authorization?.mobile_number || null,
    authorizationCode: data.authorization?.authorization_code || null,
    cardLast4: data.authorization?.card_number ? String(data.authorization.card_number).slice(-4) : null,
    cardBank: data.authorization?.provider || data.authorization?.brand || null,
  };
}

export async function paychanguCallback(req: Request, res: Response): Promise<void> {
  const { tx_ref } = req.query;
  const traceId = `CALLBACK-${Date.now()}`;

  console.log(`[${traceId}] ========== PAYCHANGU CALLBACK ==========`);
  console.log(`[${traceId}] tx_ref: ${tx_ref}`);

  const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:8080';
  const PAYCHANGU_SECRET_KEY = process.env.PAYCHANGU_SECRET_KEY!;

  if (!tx_ref) {
    res.redirect(`${FRONTEND_URL}/payment/callback?status=failed`);
    return;
  }

  try {
    // 1. Check if already processed
    const completedPayment = await prisma.payment.findFirst({
      where: { reference: String(tx_ref) },
      select: { reference: true },
    });
    if (completedPayment) {
      console.log(`[${traceId}] Already processed (Payment) — redirecting`);
      res.redirect(`${FRONTEND_URL}/payment/callback?status=success&type=package_subscription&reference=${tx_ref}`);
      return;
    }

    const completedTx = await prisma.transaction.findFirst({
      where: { reference: String(tx_ref) },
      select: { type: true, isGuest: true, guestEmail: true, guestName: true, baseAmount: true, currency: true, reference: true, eventId: true },
    });
    if (completedTx) {
      console.log(`[${traceId}] Already processed (Transaction) — redirecting`);
      const params = new URLSearchParams({
        status: 'success', type: completedTx.type, reference: String(tx_ref),
        ...(completedTx.isGuest && { isGuest: 'true', guestEmail: completedTx.guestEmail || '', guestName: completedTx.guestName || '', amount: String(completedTx.baseAmount || ''), currency: completedTx.currency || '', eventId: completedTx.eventId || '' }),
      });
      res.redirect(`${FRONTEND_URL}/payment/callback?${params.toString()}`);
      return;
    }

    // 2. Not yet processed — verify with Paychangu API
    console.log(`[${traceId}] Verifying with Paychangu API...`);
    const verifyResponse = await axios.get(
      `https://api.paychangu.com/verify-payment/${tx_ref}`,
      { headers: { Authorization: `Bearer ${PAYCHANGU_SECRET_KEY}` } }
    );
    const verified = verifyResponse.data.data?.status === 'success';
    console.log(`[${traceId}] Paychangu verification: ${verified}`);

    if (!verified) {
      res.redirect(`${FRONTEND_URL}/payment/callback?status=failed&reference=${tx_ref}`);
      return;
    }

    // 3. Verified — load pending transaction
    const pendingTx = await prisma.pendingTransaction.findUnique({
      where: { reference: String(tx_ref) },
    });
    if (!pendingTx) {
      console.log(`[${traceId}] Pending transaction not found`);
      res.redirect(`${FRONTEND_URL}/payment/callback?status=failed&reference=${tx_ref}`);
      return;
    }

    const metadata = pendingTx.metadata ? JSON.parse(pendingTx.metadata) : {};
    const gatewayTrace = buildGatewayTrace(metadata, req.query, verifyResponse.data);
    const checkoutData = getPaychanguCheckoutData(verifyResponse.data);
    console.log(`[${traceId}] PendingTx type: ${pendingTx.type}, isGuest: ${metadata.isGuest}, metadata:`, metadata);

    // 4. Create records — webhook fallback
    if (pendingTx.type === 'package_subscription') {
      console.log(`[${traceId}] ========== CALLBACK FALLBACK: package_subscription ==========`);

      const pkg = await prisma.package.findUnique({ where: { id: metadata.packageId } });
      console.log(`[${traceId}] Package: ${pkg?.name}`);

      const startsAt = metadata.invoiceServicePeriodStart ? new Date(metadata.invoiceServicePeriodStart) : new Date();
      const expiresAt = metadata.invoiceServicePeriodEnd ? new Date(metadata.invoiceServicePeriodEnd) : new Date(startsAt);
      if (!metadata.invoiceServicePeriodEnd) {
        if (metadata.billingCycle === 'monthly') expiresAt.setMonth(expiresAt.getMonth() + 1);
        else expiresAt.setFullYear(expiresAt.getFullYear() + 1);
      }
      console.log(`[${traceId}] Subscription period — startsAt: ${startsAt.toISOString()}, expiresAt: ${expiresAt.toISOString()}`);

      const payment = await prisma.payment.create({
        data: {
          ministryAdminId: metadata.ministryAdminId,
          packageId: metadata.packageId,
          invoiceId: metadata.invoiceId || null,
          packageName: metadata.packageName || pkg?.name || 'Unknown',
          amount: metadata.totalAmount,
          baseAmount: metadata.baseAmount,
          convenienceFee: metadata.convenienceFee,
          systemFeeAmount: metadata.systemFeeAmount,
          totalAmount: metadata.totalAmount,
          currency: pendingTx.currency,
          type: 'package_subscription',
          status: 'completed',
          gateway: metadata.gateway,
          reference: String(tx_ref),
          billingCycle: metadata.billingCycle,
          paidAt: new Date(),
          systemGatewayFeeRate: metadata.gatewayFeeRate || 0,
          systemFeeRate: metadata.systemFeeRate || 0,
          gatewayPayload: gatewayTrace.gatewayPayload,
          gatewayResponse: gatewayTrace.gatewayResponse,
          createdById: pendingTx.userId ?? metadata.ministryAdminId,
          expiresAt,
        },
      });
      console.log(`[${traceId}] Payment record created: ${payment.id}`);

      if (metadata.invoiceId) {
        await recalculatePackageInvoice(metadata.invoiceId);
      } else {
        await activateSubscriptionFromInvoice({
          ministryAdminId: metadata.ministryAdminId,
          packageId: metadata.packageId,
          servicePeriodStart: startsAt,
          servicePeriodEnd: expiresAt,
        });
      }
      console.log(`[${traceId}] Subscription upserted — expiresAt: ${expiresAt.toISOString()}`);

      await prisma.pendingTransaction.delete({ where: { id: pendingTx.id } });
      console.log(`[${traceId}] Pending transaction deleted`);

      // Send confirmation email
      const user = await prisma.user.findUnique({ where: { id: pendingTx.userId! } });
      const packageFeatures = await prisma.packageFeatureLink.findMany({
        where: { packageId: metadata.packageId },
        include: { feature: { select: { displayName: true } } },
      });
      if (user && pkg) {
        const receiptPDF = await generateReceiptPDF({
          receiptNumber: String(tx_ref),
          type: 'package_subscription',
          customerName: `${user.firstName} ${user.lastName}`,
          customerEmail: user.email,
          amount: metadata.baseAmount,
          currency: pendingTx.currency,
          paidAt: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
          paymentMethod: checkoutData.paymentMethod,
          description: `${pkg.displayName} - ${metadata.billingCycle} subscription`,
          itemDetails: [
            { label: 'Package', value: pkg.displayName },
            { label: 'Billing Cycle', value: metadata.billingCycle },
            { label: 'Expires On', value: expiresAt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) },
          ],
        });
        queueEmail(
          user.email,
          `Subscription Confirmed - ${pkg.displayName}`,
          packageSubscriptionTemplate({
            firstName: user.firstName,
            packageName: pkg.displayName,
            amount: metadata.baseAmount,
            currency: pendingTx.currency,
            billingCycle: metadata.billingCycle,
            expiresAt: expiresAt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
            features: packageFeatures.map(pf => pf.feature.displayName),
          }),
          [{ filename: `receipt-${tx_ref}.pdf`, content: receiptPDF }]
        );
        console.log(`[${traceId}] Confirmation email queued to ${user.email}`);
      }

      res.redirect(`${FRONTEND_URL}/payment/callback?status=success&type=package_subscription&reference=${tx_ref}`);
      return;
    }

    

  // Replace the bottom "just redirect" block with full processing:

if (pendingTx.type === 'event_ticket') {
  console.log(`[${traceId}] ========== CALLBACK: event_ticket ==========`);

  const existingTx = await prisma.transaction.findFirst({
    where: { reference: String(tx_ref) },
    select: { type: true, isGuest: true, guestEmail: true, guestName: true, baseAmount: true, currency: true, eventId: true },
  });

  if (existingTx) {
    console.log(`[${traceId}] Already processed — redirecting`);
    await prisma.pendingTransaction.delete({ where: { id: pendingTx.id } }).catch(() => {});
    const params = new URLSearchParams({
      status: 'success', type: 'event_ticket', reference: String(tx_ref),
      ...(existingTx.isGuest && {
        isGuest: 'true',
        guestEmail: existingTx.guestEmail || '',
        guestName: existingTx.guestName || '',
        amount: String(existingTx.baseAmount || ''),
        currency: existingTx.currency || '',
        eventId: existingTx.eventId || '',
      }),
    });
    res.redirect(`${FRONTEND_URL}/payment/callback?${params.toString()}`);
    return;
  }

  // Not yet processed — create records
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
      reference: String(tx_ref),
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

  const quantity = metadata.quantity || 1;
  const event = await prisma.event.findUnique({ where: { id: metadata.eventId }, include: { church: true } });
  const user = metadata.isGuest ? null : await prisma.user.findUnique({ where: { id: pendingTx.userId! } });
  const isGuestTicket = metadata.isGuest === true;

  for (let i = 0; i < quantity; i++) {
    const ticket = await createEventTicketWithUniqueNumber(event!, {
      churchId: pendingTx.churchId || metadata.churchId || event!.churchId,
      userId: isGuestTicket ? null : pendingTx.userId,
      transactionId: transaction.id,
      status: 'confirmed',
      isGuest: isGuestTicket,
      guestName: isGuestTicket ? metadata.guestName : null,
      guestEmail: isGuestTicket ? metadata.guestEmail : null,
      guestPhone: isGuestTicket ? metadata.guestPhone : null,
    });
    const ticketNumber = ticket.ticketNumber;

    const attendeeName = isGuestTicket ? metadata.guestName : `${user!.firstName} ${user!.lastName}`;
    const emailTo = isGuestTicket ? metadata.guestEmail : user!.email;

    if (event && emailTo) {
      const { generateTicketPDF } = await import('../lib/ticketPDF');
      const { ticketPurchaseTemplate } = await import('../lib/emailTemplates');
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
        receiptNumber: String(tx_ref),
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
      queueEmail(
        emailTo,
        `Ticket Confirmation - ${event.title}`,
        ticketPurchaseTemplate({
          firstName: isGuestTicket ? metadata.guestName.split(' ')[0] : user!.firstName,
          eventTitle: event.title,
          ticketNumber,
          amount: metadata.baseAmount,
          currency: pendingTx.currency,
          eventDate: new Date(event.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
          eventEndDate: new Date(event.endDate || event.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
          eventLocation: event.location,
          churchName: event.church.name,
          ...(isGuestTicket && {
            viewUrl: `${FRONTEND_URL}/payment/callback?status=success&type=event_ticket&isGuest=true&reference=${tx_ref}&guestEmail=${encodeURIComponent(metadata.guestEmail)}&guestName=${encodeURIComponent(metadata.guestName)}&amount=${metadata.baseAmount}&currency=${pendingTx.currency}&eventId=${metadata.eventId}`,
          }),
        }),
        [
          { filename: `ticket-${ticketNumber}.pdf`, content: ticketPDF },
          { filename: `receipt-${tx_ref}.pdf`, content: receiptPDF },
        ]
      );
    }
  }

  await prisma.event.update({ where: { id: metadata.eventId }, data: { ticketsSold: { increment: quantity } } });
  await prisma.pendingTransaction.delete({ where: { id: pendingTx.id } }).catch(() => {});

  const params = new URLSearchParams({
    status: 'success', type: 'event_ticket', reference: String(tx_ref),
    ...(isGuestTicket && {
      isGuest: 'true',
      guestEmail: metadata.guestEmail || '',
      guestName: metadata.guestName || '',
      amount: String(metadata.baseAmount || ''),
      currency: pendingTx.currency || '',
      eventId: metadata.eventId || '',
    }),
  });
  res.redirect(`${FRONTEND_URL}/payment/callback?${params.toString()}`);
  return;
}

if (pendingTx.type === 'donation') {
  console.log(`[${traceId}] ========== CALLBACK: donation ==========`);

  // 1. Check if already fully processed (webhook got here first)
  const existingTx = await prisma.donationTransaction.findFirst({
    where: { reference: String(tx_ref) },
    select: { isGuest: true, guestEmail: true, guestName: true, amount: true, currency: true },
  });

  if (existingTx) {
    console.log(`[${traceId}] Already processed — redirecting`);
    await prisma.pendingTransaction.delete({ where: { id: pendingTx.id } }).catch(() => {});
    const params = new URLSearchParams({
      status: 'success', type: 'donation', reference: String(tx_ref),
      ...(existingTx.isGuest && {
        isGuest: 'true',
        guestEmail: existingTx.guestEmail || '',
        guestName: existingTx.guestName || '',
        amount: String(existingTx.amount || ''),
        currency: existingTx.currency || '',
      }),
    });
    res.redirect(`${FRONTEND_URL}/payment/callback?${params.toString()}`);
    return;
  }

  // 3. Verified + not processed — create records
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
      reference: String(tx_ref),
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
      reference: String(tx_ref),
      currency: pendingTx.currency,
      paymentMethod: checkoutData.paymentMethod,
    });
    console.log(`[${traceId}] Multi-line donation processed successfully`);
    await prisma.pendingTransaction.delete({ where: { id: pendingTx.id } }).catch(() => {});

    const params = new URLSearchParams({
      status: 'success', type: 'donation', reference: String(tx_ref),
      ...(metadata.isGuest && {
        isGuest: 'true',
        guestEmail: metadata.guestEmail || '',
        guestName: metadata.guestName || '',
        amount: String(metadata.baseAmount || ''),
        currency: pendingTx.currency || '',
      }),
    });
    res.redirect(`${FRONTEND_URL}/payment/callback?${params.toString()}`);
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
      reference: String(tx_ref),
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
  await creditChurchWallet(pendingTx.churchId!, metadata.baseAmount, 'donation', transaction.id, `Donation - ${metadata.campaignName}`);

  // Guest receipt email
  if (metadata.isGuest && metadata.guestEmail) {
    const campaign = await prisma.givingCampaign.findUnique({
      where: { id: metadata.campaignId },
      include: { church: { select: { name: true } } },
    });
    if (campaign) {
      const { generateReceiptPDF } = await import('../lib/receiptPDF');
      const { donationReceiptTemplate } = await import('../lib/emailTemplates');
      const receiptPDF = await generateReceiptPDF({
        receiptNumber: String(tx_ref),
        type: 'donation',
        customerName: metadata.guestName,
        customerEmail: metadata.guestEmail,
        amount: metadata.baseAmount,
        currency: pendingTx.currency,
        paidAt: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
        paymentMethod: checkoutData.paymentMethod,
        description: `Donation to ${campaign.name}`,
        itemDetails: [
          { label: 'Campaign', value: campaign.name },
          { label: 'Church', value: (campaign as any).church.name },
        ],
      });
      queueEmail(
        metadata.guestEmail,
        `Donation Receipt - ${campaign.name}`,
        donationReceiptTemplate({
          firstName: metadata.guestName.split(' ')[0],
          amount: metadata.baseAmount,
          currency: pendingTx.currency,
          campaignName: campaign.name,
          reference: String(tx_ref),
          isAnonymous: false,
          isGuest: true,
          churchName: (campaign as any).church.name,
        }),
        [{ filename: `donation-receipt-${tx_ref}.pdf`, content: receiptPDF }]
      );
    }
  }

  console.log(`[${traceId}] Donation processed successfully`);
  await prisma.pendingTransaction.delete({ where: { id: pendingTx.id } }).catch(() => {});

  const params = new URLSearchParams({
    status: 'success', type: 'donation', reference: String(tx_ref),
    ...(metadata.isGuest && {
      isGuest: 'true',
      guestEmail: metadata.guestEmail || '',
      guestName: metadata.guestName || '',
      amount: String(metadata.baseAmount || ''),
      currency: pendingTx.currency || '',
    }),
  });
  res.redirect(`${FRONTEND_URL}/payment/callback?${params.toString()}`);
  return;
}


  } catch (error: any) {
    console.error(`[${traceId}] Callback error:`, error.message);
    res.redirect(`${FRONTEND_URL}/payment/callback?status=failed&reference=${tx_ref}`);
  }
}
