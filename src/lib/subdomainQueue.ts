/**
 * BullMQ Subdomain Creation Queue
 * Creates Cloudflare DNS records asynchronously
 */

import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { createSubdomain, toSlug } from './cloudflareDns';
import prisma from './prisma';

// Redis connection
const redisConnection = new IORedis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

// Subdomain job data
export interface SubdomainJobData {
  userId: string;
  ministryName: string;
  customSubdomain?: string;
  email: string;
  firstName: string;
}

// Create queue
export const subdomainQueue = new Queue<SubdomainJobData>('subdomains', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: 'exponential',
      delay: 10000, // 10s, 20s, 40s, 80s, 160s
    },
    removeOnComplete: {
      count: 50,
    },
    removeOnFail: {
      count: 20,
    },
  },
});

// Create worker
export const subdomainWorker = new Worker<SubdomainJobData>(
  'subdomains',
  async (job: Job<SubdomainJobData>) => {
    const { userId, ministryName, customSubdomain, email, firstName } = job.data;

    console.log(`[SubdomainWorker] Processing job ${job.id} for user ${userId}`);

    // Generate slug
    const slugSource = (customSubdomain && customSubdomain.trim())
      ? customSubdomain.trim()
      : ministryName;
    const slug = toSlug(slugSource);

    if (!slug) {
      throw new Error(`Invalid subdomain slug from: ${slugSource}`);
    }

    // Create subdomain via Cloudflare
    const fullSubdomain = await createSubdomain(slug);

    if (!fullSubdomain) {
      throw new Error(`Failed to create subdomain: ${slug}`);
    }

    // Save to database
    await prisma.user.update({
      where: { id: userId },
      data: { subdomain: fullSubdomain },
    });

    console.log(`[SubdomainWorker] ✅ Created subdomain ${fullSubdomain} for user ${userId}`);

    // Send success email with subdomain info
    const { queueEmail } = await import('./emailQueue');
    const { registrationTemplate } = await import('./emailTemplates');

    await queueEmail(
      email,
      'Welcome to ICIMS - Your Church Website is Ready',
      registrationTemplate({
        firstName,
        lastName: '',
        email,
        ministryName,
        siteUrl: `https://${fullSubdomain}`,
        roleName: 'Ministry Administrator',
      }),
      'registration'
    );

    return { 
      success: true, 
      subdomain: fullSubdomain,
      userId 
    };
  },
  {
    connection: redisConnection,
    concurrency: 2, // Limit concurrent Cloudflare API calls
  }
);

// Event handlers
subdomainWorker.on('completed', (job, result) => {
  console.log(`[SubdomainWorker] Job ${job.id} completed: ${result.subdomain}`);
});

subdomainWorker.on('failed', (job, err) => {
  console.error(`[SubdomainWorker] Job ${job?.id} failed after ${job?.attemptsMade} attempts:`, err.message);
  
  // Notify admin of failure (optional)
  if (job && job.attemptsMade >= 5) {
    console.error(`[SubdomainWorker] CRITICAL: Subdomain creation permanently failed for user ${job.data.userId}`);
    // Could send admin alert here
  }
});

console.log('[SubdomainWorker] Subdomain worker started with concurrency: 2');

/**
 * Queue subdomain creation
 */
export async function queueSubdomainCreation(data: SubdomainJobData): Promise<void> {
  const job = await subdomainQueue.add(
    'create-subdomain',
    data,
    {
      delay: 0, // Process immediately
      priority: 1,
    }
  );

  console.log(`[SubdomainQueue] 📋 Queued subdomain job ${job.id} for user ${data.userId}`);
}

/**
 * Get subdomain queue stats
 */
export async function getSubdomainQueueStats() {
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    subdomainQueue.getWaitingCount(),
    subdomainQueue.getActiveCount(),
    subdomainQueue.getCompletedCount(),
    subdomainQueue.getFailedCount(),
    subdomainQueue.getDelayedCount(),
  ]);

  return {
    waiting,
    active,
    completed,
    failed,
    delayed,
  };
}

/**
 * Retry failed subdomain job
 */
export async function retryFailedSubdomain(jobId: string): Promise<void> {
  const job = await subdomainQueue.getJob(jobId);
  if (job) {
    await job.retry();
  }
}
