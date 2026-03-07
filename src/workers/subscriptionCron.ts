import cron from 'node-cron';
import { runSubscriptionChecks } from './subscriptionWorker';

/**
 * Schedule subscription checks to run daily at 2 AM
 */
export function startSubscriptionCron() {
  // Run every day at 2:00 AM
  cron.schedule('0 2 * * *', async () => {
    console.log('[Cron] Running daily subscription checks...');
    try {
      await runSubscriptionChecks();
    } catch (error) {
      console.error('[Cron] Subscription check failed:', error);
    }
  });

  console.log('[Cron] Subscription checker scheduled (daily at 2:00 AM)');
}
