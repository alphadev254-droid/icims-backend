import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import axios from 'axios';
import { queueEmail } from '../lib/emailQueue';
import { packageSubscriptionTemplate } from '../lib/emailTemplates';
import { generateReceiptPDF } from '../lib/receiptPDF';

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
    console.log(`[${traceId}] PendingTx type: ${pendingTx.type}, isGuest: ${metadata.isGuest}, metadata:`, metadata);

    // 4. Create records — webhook fallback
    if (pendingTx.type === 'package_subscription') {
      console.log(`[${traceId}] ========== CALLBACK FALLBACK: package_subscription ==========`);

      const pkg = await prisma.package.findUnique({ where: { id: metadata.packageId } });
      console.log(`[${traceId}] Package: ${pkg?.name}`);

      const startsAt = new Date();
      const expiresAt = new Date(startsAt);
      if (metadata.billingCycle === 'monthly') expiresAt.setMonth(expiresAt.getMonth() + 1);
      else expiresAt.setFullYear(expiresAt.getFullYear() + 1);
      console.log(`[${traceId}] Subscription period — startsAt: ${startsAt.toISOString()}, expiresAt: ${expiresAt.toISOString()}`);

      const payment = await prisma.payment.create({
        data: {
          ministryAdminId: metadata.ministryAdminId,
          packageId: metadata.packageId,
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
          createdById: pendingTx.userId ?? metadata.ministryAdminId,
          expiresAt,
        },
      });
      console.log(`[${traceId}] Payment record created: ${payment.id}`);

      await prisma.subscription.upsert({
        where: { ministryAdminId: metadata.ministryAdminId },
        create: { ministryAdminId: metadata.ministryAdminId, packageId: metadata.packageId, status: 'active', startsAt, expiresAt, lastEmailDay: null },
        update: { packageId: metadata.packageId, status: 'active', startsAt, expiresAt, lastEmailDay: null },
      });
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
          paymentMethod: 'mobile_money',
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

if (pendingTx.type === 'donation') {
  console.log(`[${traceId}] ========== CALLBACK: donation ==========`);

  // 1. Check if already fully processed (webhook got here first)
 const existingTx = await prisma.transaction.findFirst({
    where: { reference: String(tx_ref) },
    select: { type: true, isGuest: true, guestEmail: true, guestName: true, baseAmount: true, currency: true },
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
        amount: String(existingTx.baseAmount || ''),
        currency: existingTx.currency || '',
      }),
    });
    res.redirect(`${FRONTEND_URL}/payment/callback?${params.toString()}`);
    return;
  }

  // 3. Verified + not processed — create records
  const transaction = await prisma.transaction.create({
    data: {
      userId: metadata.isGuest ? null : pendingTx.userId,
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
      paymentMethod: 'mobile_money',
      paidAt: new Date(),
      isGuest: metadata.isGuest === true,
      guestName: metadata.isGuest ? metadata.guestName : null,
      guestEmail: metadata.isGuest ? metadata.guestEmail : null,
      guestPhone: metadata.isGuest ? metadata.guestPhone : null,
    },
  });

  const donationTx = await prisma.donationTransaction.create({
    data: {
      campaignId: metadata.campaignId,
      userId: metadata.isGuest ? null : pendingTx.userId,
      churchId: pendingTx.churchId,
      amount: metadata.baseAmount,
      currency: pendingTx.currency,
      transactionId: transaction.id,
      reference: String(tx_ref),
      status: 'completed',
      isAnonymous: metadata.isAnonymous || false,
      isGuest: metadata.isGuest === true,
      guestName: metadata.isGuest ? metadata.guestName : null,
      guestEmail: metadata.isGuest ? metadata.guestEmail : null,
      guestPhone: metadata.isGuest ? metadata.guestPhone : null,
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
  } else if (!metadata.isGuest && pendingTx.userId && metadata.campaignId) {
    const activePledge = await prisma.pledge.findFirst({
      where: { userId: pendingTx.userId, campaignId: metadata.campaignId, status: { in: ['pending', 'partial', 'overdue'] } },
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
        paymentMethod: 'mobile_money',
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
