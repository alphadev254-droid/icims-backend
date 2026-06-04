import { Request, Response } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import axios from 'axios';
import { queueEmail } from '../lib/emailQueue';
import { packageSubscriptionTemplate, ticketPurchaseTemplate, withdrawalFinalStatusTemplate } from '../lib/emailTemplates';
import { generateTicketPDF } from '../lib/ticketPDF';
import { generateReceiptPDF } from '../lib/receiptPDF';
import { refundWithdrawal } from '../utils/walletOperations';
import { queuePaymentProcessing } from '../lib/paymentQueue';

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
          data: { status: 'completed', processedAt: new Date(), gatewayResponse: JSON.stringify(payload) },
        });

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
          data: { status: 'failed', failureReason: JSON.stringify(payload) },
        });
      }
      return;
    }

    if (status !== 'success') {
      console.log(`[${traceId}] Payment not successful, skipping`);
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
      await processPaychanguSubscription(pendingTx, metadata, payload, traceId);
    } else if (pendingTx.type === 'event_ticket') {
      await processPaychanguTicket(pendingTx, metadata, payload, traceId);
    } else if (pendingTx.type === 'donation') {
      await processPaychanguDonation(pendingTx, metadata, payload, traceId);
    }

    // Update pending transaction
    await prisma.pendingTransaction.update({
      where: { id: pendingTx.id },
      data: { status: 'completed' },
    });

    console.log(`[${traceId}] ✅ Payment processed successfully`);

  } catch (error: any) {
    console.error(`[${traceId}] ERROR:`, error.message);
    throw error;
  }
}

// Helper functions for processing different payment types
async function processPaychanguSubscription(pendingTx: any, metadata: any, payload: any, traceId: string): Promise<void> {
  const existing = await prisma.payment.findFirst({ where: { reference: pendingTx.reference } });
  if (existing) {
    console.log(`[${traceId}] Already processed: ${existing.id}`);
    return;
  }

  const payment = await prisma.payment.create({
    data: {
      ministryAdminId: metadata.ministryAdminId,
      packageId: metadata.packageId,
      amount: metadata.totalAmount,
      currency: pendingTx.currency,
      type: 'subscription',
      status: 'completed',
      gateway: metadata.gateway,
      reference: pendingTx.reference,
      billingCycle: metadata.billingCycle,
      paidAt: new Date(),
      createdById: pendingTx.userId || metadata.ministryAdminId,
    },
  });

  // Activate subscription
  const startsAt = new Date();
  const expiresAt = new Date(startsAt);
  if (metadata.billingCycle === 'monthly') {
    expiresAt.setMonth(expiresAt.getMonth() + 1);
  } else {
    expiresAt.setFullYear(expiresAt.getFullYear() + 1);
  }

  await prisma.subscription.upsert({
    where: { ministryAdminId: metadata.ministryAdminId },
    create: {
      ministryAdminId: metadata.ministryAdminId,
      packageId: metadata.packageId,
      status: 'active',
      startsAt,
      expiresAt,
    },
    update: {
      packageId: metadata.packageId,
      status: 'active',
      startsAt,
      expiresAt,
    },
  });

  console.log(`[${traceId}] Subscription activated until: ${expiresAt}`);

  // Send confirmation email
  const user = await prisma.user.findUnique({
    where: { id: pendingTx.userId! },
    select: { firstName: true, email: true },
  });

  const pkg = await prisma.package.findUnique({
    where: { id: metadata.packageId },
    include: { features: { include: { feature: true } } },
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

async function processPaychanguTicket(pendingTx: any, metadata: any, payload: any, traceId: string): Promise<void> {
  console.log(`[${traceId}] Processing ticket for ref: ${pendingTx.reference}`);
  // TODO: Implement ticket processing logic
}

async function processPaychanguDonation(pendingTx: any, metadata: any, payload: any, traceId: string): Promise<void> {
  console.log(`[${traceId}] Processing donation for ref: ${pendingTx.reference}`);
  // TODO: Implement donation processing logic
}

