import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import axios from 'axios';

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
    // 1. Check if webhook already processed this
    // package_subscription → Payment table, event_ticket/donation → Transaction table
    const completedPayment = await prisma.payment.findFirst({
      where: { reference: String(tx_ref) },
      select: { reference: true },
    });

    if (completedPayment) {
      console.log(`[${traceId}] Webhook already processed (Payment record found) — redirecting to success`);
      res.redirect(`${FRONTEND_URL}/payment/callback?status=success&type=package_subscription&reference=${tx_ref}`);
      return;
    }

    const completedTx = await prisma.transaction.findFirst({
      where: { reference: String(tx_ref) },
      select: {
        type: true,
        isGuest: true,
        guestEmail: true,
        guestName: true,
        baseAmount: true,
        currency: true,
        reference: true,
        eventId: true,
      },
    });

    if (completedTx) {
      console.log(`[${traceId}] Webhook already processed (Transaction record found) — redirecting to success`);
      const params = new URLSearchParams({
        status: 'success',
        type: completedTx.type,
        reference: String(tx_ref),
        ...(completedTx.isGuest && {
          isGuest: 'true',
          guestEmail: completedTx.guestEmail || '',
          guestName: completedTx.guestName || '',
          amount: String(completedTx.baseAmount || ''),
          currency: completedTx.currency || '',
          eventId: completedTx.eventId || '',
        }),
      });
      res.redirect(`${FRONTEND_URL}/payment/callback?${params.toString()}`);
      return;
    }

    // 2. Webhook hasn't fired yet — verify with Paychangu API
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

    // 3. Verified — get guest info from pending transaction metadata
    const pendingTx = await prisma.pendingTransaction.findUnique({
      where: { reference: String(tx_ref) },
      select: { type: true, metadata: true, eventId: true },
    });

    const type = pendingTx?.type || 'event_ticket';
    const metadata = pendingTx?.metadata ? JSON.parse(pendingTx.metadata) : {};
    const isGuest = metadata.isGuest === true;
    console.log(`[${traceId}] PendingTx type: ${type}, isGuest: ${isGuest}, pendingTx found: ${!!pendingTx}`);

    const params = new URLSearchParams({
      status: 'success',
      type,
      reference: String(tx_ref),
      ...(isGuest && {
        isGuest: 'true',
        guestEmail: metadata.guestEmail || '',
        guestName: metadata.guestName || '',
        amount: String(metadata.baseAmount || ''),
        currency: metadata.currency || '',
        eventId: pendingTx?.eventId || '',
      }),
    });

    res.redirect(`${FRONTEND_URL}/payment/callback?${params.toString()}`);

  } catch (error: any) {
    console.error(`[${traceId}] Callback error:`, error.message);
    res.redirect(`${FRONTEND_URL}/payment/callback?status=failed&reference=${tx_ref}`);
  }
}
