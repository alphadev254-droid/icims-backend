/**
 * BullMQ Email Queue with Redis
 * Event-driven email processing - instant delivery
 */

import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { sendEmail } from './email';

// Redis connection for external server
const redisConnection = new IORedis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null, // Required for BullMQ
  enableReadyCheck: false,    // Required for BullMQ
});

// Email attachment type
export interface EmailAttachment {
  filename: string;
  content: Buffer;
}

// Email job data type
export interface EmailJobData {
  to: string;
  subject: string;
  html: string;
  attachments?: Array<{
    filename: string;
    content: string; // base64 encoded
  }>;
  emailType: string;
}

// Create queue
export const emailQueue = new Queue<EmailJobData>('emails', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000, // 5s, 10s, 20s
    },
    removeOnComplete: {
      count: 100, // Keep last 100 completed jobs
    },
    removeOnFail: {
      count: 50,  // Keep last 50 failed jobs for debugging
    },
  },
});

// Create worker to process emails
export const emailWorker = new Worker<EmailJobData>(
  'emails',
  async (job: Job<EmailJobData>) => {
    const { to, subject, html, attachments } = job.data;

    console.log(`[BullMQ] Processing job ${job.id} - ${subject} to ${to}`);

    // Decode attachments
    const decodedAttachments = attachments?.map(a => ({
      filename: a.filename,
      content: Buffer.from(a.content, 'base64'),
    }));

    // Send email
    await sendEmail(to, subject, html, decodedAttachments);

    console.log(`[BullMQ] ✅ Job ${job.id} completed`);
    return { sent: true, to, subject };
  },
  {
    connection: redisConnection,
    concurrency: 5, // Process up to 5 emails concurrently
  }
);

// Worker event handlers
emailWorker.on('completed', (job) => {
  console.log(`[BullMQ] Job ${job.id} completed successfully`);
});

emailWorker.on('failed', (job, err) => {
  console.error(`[BullMQ] Job ${job?.id} failed:`, err.message);
});

emailWorker.on('error', (err) => {
  console.error('[BullMQ] Worker error:', err);
});

console.log('[BullMQ] Email worker started with concurrency: 5');

/**
 * Add email to queue - instant processing
 */
export async function queueEmailBull(
  to: string,
  subject: string,
  html: string,
  attachmentsOrType?: any[] | string,
  emailType?: string
): Promise<void> {
  // Handle overloaded parameters (match old API)
  let attachments: any[] | undefined;
  let type: string = 'notification';

  if (typeof attachmentsOrType === 'string') {
    type = attachmentsOrType;
  } else {
    attachments = attachmentsOrType;
    type = emailType || 'notification';
  }

  // Encode attachments for JSON serialization
  const encodedAttachments = attachments?.map(a => ({
    filename: a.filename,
    content: a.content.toString('base64'),
  }));

  const job = await emailQueue.add(
    'send-email',
    {
      to,
      subject,
      html,
      attachments: encodedAttachments,
      emailType: type,
    },
    {
      priority: type === 'password_reset' ? 1 : type === 'registration' ? 2 : 5, // Higher priority = faster processing
    }
  );

  console.log(`[BullMQ] 📧 Queued email job ${job.id} - ${subject} to ${to} (priority: ${type === 'password_reset' ? 1 : type === 'registration' ? 2 : 5})`);
}

/**
 * Get queue stats
 */
export async function getEmailQueueStats() {
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    emailQueue.getWaitingCount(),
    emailQueue.getActiveCount(),
    emailQueue.getCompletedCount(),
    emailQueue.getFailedCount(),
    emailQueue.getDelayedCount(),
  ]);

  return {
    waiting,
    active,
    completed,
    failed,
    delayed,
    total: waiting + active + delayed,
  };
}

/**
 * Retry failed job
 */
export async function retryFailedEmail(jobId: string): Promise<void> {
  const job = await emailQueue.getJob(jobId);
  if (job) {
    await job.retry();
  }
}

/**
 * Clean old jobs
 */
export async function cleanEmailQueue(): Promise<void> {
  await emailQueue.clean(24 * 3600 * 1000, 100, 'completed'); // Remove completed older than 24h
  await emailQueue.clean(7 * 24 * 3600 * 1000, 100, 'failed'); // Remove failed older than 7d
}
