/**
 * BullMQ Payment Processing Queue
 * Just the queue setup - processing logic is in controllers
 */

import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';

const redisConnection = new IORedis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

export interface PaymentJobData {
  gateway: 'paychangu' | 'paystack';
  payload: any;
}

export const paymentQueue = new Queue<PaymentJobData>('payments', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  },
});

export async function queuePaymentProcessing(data: PaymentJobData): Promise<void> {
  const job = await paymentQueue.add('process-payment', data);
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
      throw error;
    }
  },
  { connection: redisConnection, concurrency: 10 }
);

console.log('[PaymentWorker] Payment worker started with concurrency: 10');
