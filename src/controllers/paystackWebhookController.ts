import { Request, Response } from 'express';
import crypto from 'crypto';
import { queuePaymentProcessing } from '../lib/paymentQueue';
import { completePaystackPayment } from '../services/paystackCompletionService';

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY!;
const PAYSTACK_BASE_URL = process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co';

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

    const axios = (await import('axios')).default;
    const verifyResponse = await axios.get(
      `${PAYSTACK_BASE_URL}/transaction/verify/${reference}`,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } },
    );

    if (verifyResponse.data.data?.status !== 'success') {
      console.log(`[${traceId}] Verification failed`);
      return;
    }

    const result = await completePaystackPayment(verifyResponse.data.data, traceId);
    console.log(`[${traceId}] Webhook processed successfully`, result);
  } catch (error: any) {
    console.error(`[${traceId}] ERROR:`, error.message);
    throw error;
  }
}
