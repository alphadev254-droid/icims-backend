/**
 * BullMQ Email Queue with Redis
 * Event-driven email processing - instant delivery
 */

import { Queue, Worker, Job } from 'bullmq';
import { sendEmail } from './email';
import prisma from './prisma';

// Redis connection options (plain object to avoid type conflicts)
const redisConnection = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD || undefined,
};

// Email attachment type
export interface EmailAttachment {
  filename: string;
  content: Buffer;
  cid?: string;
  contentType?: string;
  contentDisposition?: 'attachment' | 'inline';
}

// Email job data type
export interface EmailJobData {
  to: string;
  subject: string;
  html: string;
  attachments?: Array<{
    filename: string;
    content: string; // base64 encoded
    cid?: string;
    contentType?: string;
    contentDisposition?: 'attachment' | 'inline';
  }>;
  emailType: string;
  programNotificationId?: string;
  campaignRecipientId?: string;
}

// Create queue
export const emailQueue = new Queue<EmailJobData>('emails', {
  connection: redisConnection as any,
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
      cid: a.cid,
      contentType: a.contentType,
      contentDisposition: a.contentDisposition,
    }));

    // Send email
    await sendEmail(to, subject, html, decodedAttachments);

    if (job.data.programNotificationId) {
      try {
        await prisma.programNotification.update({
          where: { id: job.data.programNotificationId },
          data: { status: 'sent', sentAt: new Date(), error: null },
        });
      } catch (error) {
        console.error('[BullMQ] Email sent but program notification status could not be recorded:', error);
      }
    }

    if (job.data.campaignRecipientId) {
      await prisma.systemCampaignRecipient.update({
        where: { id: job.data.campaignRecipientId },
        data: { emailStatus: 'sent', lastError: null },
      });
      await prisma.systemCampaignDeliveryAttempt.create({
        data: {
          campaignRecipientId: job.data.campaignRecipientId,
          channel: 'email',
          attemptNumber: job.attemptsMade + 1,
          status: 'sent',
          completedAt: new Date(),
        },
      });
    }

    console.log(`[BullMQ] ✅ Job ${job.id} completed`);
    return { sent: true, to, subject };
  },
  {
    connection: redisConnection as any,
    concurrency: 5, // Process up to 5 emails concurrently
  }
);

// Worker event handlers
emailWorker.on('completed', (job) => {
  console.log(`[BullMQ] Job ${job.id} completed successfully`);
});

emailWorker.on('failed', async (job, err) => {
  console.error(`[BullMQ] Job ${job?.id} failed:`, err.message);
  if (job?.data.programNotificationId && job.attemptsMade >= (job.opts.attempts ?? 1)) {
    try {
      await prisma.programNotification.update({
        where: { id: job.data.programNotificationId },
        data: { status: 'failed', error: err.message },
      });
    } catch (updateError) {
      console.error('[BullMQ] Could not record program email failure:', updateError);
    }
  }
  if (job?.data.campaignRecipientId && job.attemptsMade >= (job.opts.attempts ?? 1)) {
    try {
      await prisma.systemCampaignRecipient.update({
        where: { id: job.data.campaignRecipientId },
        data: { emailStatus: 'failed', lastError: err.message },
      });
      await prisma.systemCampaignDeliveryAttempt.create({
        data: {
          campaignRecipientId: job.data.campaignRecipientId,
          channel: 'email',
          attemptNumber: job.attemptsMade,
          status: 'failed',
          errorMessage: err.message,
          completedAt: new Date(),
        },
      });
    } catch (updateError) {
      console.error('[BullMQ] Could not record campaign email failure:', updateError);
    }
  }
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
    cid: a.cid,
    contentType: a.contentType,
    contentDisposition: a.contentDisposition,
  }));

  const job = await emailQueue.add(
    'send-email' as any,
    {
      to,
      subject,
      html,
      attachments: encodedAttachments,
      emailType: type,
    },
    {
      priority: type === 'password_reset' || type === 'email_verification' ? 1 : type === 'registration' ? 2 : 5, // Higher priority = faster processing
    }
  );

  console.log(`[BullMQ] 📧 Queued email job ${job.id} - ${subject} to ${to} (priority: ${type === 'password_reset' || type === 'email_verification' ? 1 : type === 'registration' ? 2 : 5})`);
}

export async function queueProgramEmail(notificationId: string, to: string, subject: string, html: string): Promise<void> {
  await emailQueue.add('send-email', {
    to,
    subject,
    html,
    emailType: 'program_assignment',
    programNotificationId: notificationId,
  });
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
