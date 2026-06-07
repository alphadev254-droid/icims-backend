import { Queue, Worker, Job } from 'bullmq';
import prisma from './prisma';
import { sendPushToUsers } from './fcm';

const redisConnection = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD || undefined,
};

export interface PushJobData {
  churchId: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}

export const notificationQueue = new Queue<PushJobData>('push-notifications', {
  connection: redisConnection as any,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  },
});

export const notificationWorker = new Worker<PushJobData>(
  'push-notifications',
  async (job: Job<PushJobData>) => {
    const { churchId, title, body, data } = job.data;

    const members = await prisma.user.findMany({
      where: { churchId, status: 'active' },
      select: { id: true },
    });

    if (members.length === 0) return;

    await sendPushToUsers(members.map(m => m.id), title, body, data);
    console.log(`[PushQueue] Job ${job.id} sent to ${members.length} members — "${title}"`);
  },
  { connection: redisConnection as any, concurrency: 3 }
);

notificationWorker.on('failed', (job, err) => {
  console.error(`[PushQueue] Job ${job?.id} failed:`, err.message);
});

export async function queueChurchPush(
  churchId: string,
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<void> {
  const job = await notificationQueue.add('send-push', { churchId, title, body, data });
  console.log(`[PushQueue] Queued job ${job.id} for church ${churchId} — "${title}"`);
}
