import app from './app';
import prisma from './lib/prisma';
import { emailQueue, emailWorker } from './lib/bullQueue';
import { subdomainQueue, subdomainWorker } from './lib/subdomainQueue';
import { paymentQueue, paymentWorker } from './lib/paymentQueue';
import { notificationQueue, notificationWorker } from './lib/notificationQueue';
import './workers/reminderCacheWorker';
import './workers/scheduledReminderWorker';
import { startSubscriptionCron, startKPICron, startPendingTransactionCleanup } from './workers/subscriptionCron';
import { startEventStatusWorker } from './workers/eventStatusWorker';

const PORT = process.env.PORT || 5000;
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = process.env.REDIS_PORT || '6379';
const FCM_READY = !!(process.env.GOOGLE_APPLICATION_CREDENTIALS && process.env.FIREBASE_PROJECT_ID);

async function main() {
  await prisma.$connect();
  console.log('✅ Database connected');

  // Redis / BullMQ workers
  console.log(`🔴 Redis: ${REDIS_HOST}:${REDIS_PORT}`);
  console.log('📧 BullMQ email worker initialized (Redis)');
  console.log('🌐 BullMQ subdomain worker initialized (Redis)');
  console.log('💳 BullMQ payment worker initialized (Redis)');
  console.log('🔔 BullMQ push notification worker initialized (Redis)');

  // FCM
  if (FCM_READY) {
    console.log(`🔥 FCM push notifications enabled (project: ${process.env.FIREBASE_PROJECT_ID})`);
  } else {
    console.warn('⚠️  FCM push notifications disabled — GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_PROJECT_ID not set');
  }

  console.log('📅 Reminder cache worker initialized');

  // Cron jobs
  startSubscriptionCron();
  startKPICron();
  startEventStatusWorker();
  startPendingTransactionCleanup();
  console.log('⏰ Cron jobs initialized');

  app.listen(PORT, () => {
    console.log(`🚀 ICIMS API running on http://localhost:${PORT}`);
    console.log(`   Health: http://localhost:${PORT}/api/health`);
    console.log(`   Auth:   http://localhost:${PORT}/api/auth`);
    console.log(`   Env:    ${process.env.NODE_ENV}`);
  });
}

main().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
