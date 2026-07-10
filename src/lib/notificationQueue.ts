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
    const type = data?.type ?? 'unknown';

    console.log(`[PushQueue] ▶ Processing job ${job.id} | type=${type} | church=${churchId} | title="${title}"`);

    const members = await prisma.user.findMany({
      where: { churchId, status: 'active', loginEnabled: true },
      select: { id: true },
    });

    console.log(`[PushQueue] 👥 Found ${members.length} active members in church ${churchId}`);

    if (members.length === 0) {
      console.log(`[PushQueue] ⏭ Job ${job.id} skipped — no active members`);
      return;
    }

    await sendPushToUsers(members.map(m => m.id), title, body, data);
    console.log(`[PushQueue] ✅ Job ${job.id} completed — push sent to ${members.length} members | type=${type}`);
  },
  { connection: redisConnection as any, concurrency: 3 }
);

notificationWorker.on('active', (job) => {
  console.log(`[PushQueue] 🔄 Job ${job.id} picked up by worker`);
});

notificationWorker.on('completed', (job) => {
  console.log(`[PushQueue] ✅ Job ${job.id} finished successfully`);
});

notificationWorker.on('failed', (job, err) => {
  console.error(`[PushQueue] ❌ Job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`);
});

notificationWorker.on('error', (err) => {
  console.warn(`[PushQueue] 🔁 Worker error (will retry): ${err.message}`);
});

export async function queueChurchPush(
  churchId: string,
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<void> {
  const type = data?.type ?? 'unknown';
  console.log(`[PushQueue] 📥 Queuing push | type=${type} | church=${churchId} | title="${title}"`);
  const job = await notificationQueue.add('send-push', { churchId, title, body, data });
  console.log(`[PushQueue] 📬 Job ${job.id} added to queue | type=${type} | church=${churchId}`);
}
