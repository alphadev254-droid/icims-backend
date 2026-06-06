/**
 * BullMQ Payment Processing Queue
 * Just the queue setup - processing logic is in controllers
 */

import { Queue, Worker, Job } from 'bullmq';
import prisma from '../lib/prisma';

// Redis connection options (plain object to avoid type conflicts)
const redisConnection = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD || undefined,
};

export interface PaymentJobData {
  gateway: 'paychangu' | 'paystack';
  payload: any;
}

export const paymentQueue = new Queue<PaymentJobData>('payments', {
  connection: redisConnection as any,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  },
});

export async function queuePaymentProcessing(data: PaymentJobData): Promise<void> {
  const job = await paymentQueue.add('process-payment' as any, data);
  console.log(`[PaymentQueue] Queued ${data.gateway} job ${job.id}`);
}

export const paymentWorker = new Worker<PaymentJobData>(
  'payments',
  async (job: Job<PaymentJobData>) => {
    const { gateway, payload } = job.data;
    const traceId = `PAY-${gateway.toUpperCase()}-${Date.now()}`;
    console.log(`[${traceId}] Processing ${gateway} - ${payload.tx_ref || payload.reference || payload.data?.reference}`);

    try {
      if (gateway === 'paychangu') {
        const { processPaychanguPayment } = await import('../controllers/paychanguWebhookController');
        await processPaychanguPayment(payload, traceId);
      } else if (gateway === 'paystack') {
        const { processPaystackPayment } = await import('../controllers/paystackWebhookController');
        await processPaystackPayment(payload, traceId);
      }
      console.log(`[${traceId}] ✅ Completed`);
      return { success: true, gateway };
    } catch (error: any) {
      console.error(`[${traceId}] ❌ Error:`, error.message);

      // On final attempt, mark the PendingTransaction as 'failed' so it is:
      // 1. Preserved in DB for investigation (not cleaned up by cron)
      // 2. Distinguishable from abandoned/never-paid records (status: 'pending')
      // This covers: payment succeeded at gateway but our system crashed while processing.
      const isLastAttempt = job.attemptsMade >= (job.opts.attempts ?? 3) - 1;
      if (isLastAttempt) {
        const ref = payload.tx_ref || payload.reference || payload.data?.reference;
        if (ref) {
          await prisma.pendingTransaction.updateMany({
            where: { reference: ref, status: 'pending' },
            data: { status: 'failed' },
          }).catch((e) => console.error(`[${traceId}] Could not mark pendingTx as failed:`, e.message));
          console.error(`[${traceId}] ⚠️  Marked PendingTransaction ref=${ref} as failed — payment may have succeeded at ${gateway}. Manual review required.`);
        }
      }

      throw error;
    }
  },
  { connection: redisConnection as any, concurrency: 10 }
);

console.log('[PaymentWorker] Payment worker started with concurrency: 10');
