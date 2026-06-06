import cron from 'node-cron';
import { runSubscriptionChecks } from './subscriptionWorker';
import { processKPIRecurrence } from './kpiWorker';
import prisma from '../lib/prisma';

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

/**
 * Schedule KPI recurrence to run daily at 1 AM
 */
export function startKPICron() {
  cron.schedule('0 1 * * *', async () => {
    console.log('[Cron] Running daily KPI recurrence...');
    try {
      await processKPIRecurrence();
    } catch (error) {
      console.error('[Cron] KPI recurrence failed:', error);
    }
  });

  console.log('[Cron] KPI recurrence scheduled (daily at 1:00 AM)');
}

/**
 * Clean up expired pending transactions every hour.
 * These are created when a payment is initiated but:
 *   - User closed the tab / abandoned checkout
 *   - User cancelled on the payment gateway
 *   - Webhook/callback never fired
 * Each PendingTransaction has an expiresAt set to 30 min from creation.
 */
export function startPendingTransactionCleanup() {
  cron.schedule('0 * * * *', async () => {
    try {
      // Only delete truly abandoned pending transactions:
      // - status is still 'pending' (never completed, never processed)
      // - expired more than 2 hours ago (extra buffer beyond the 30-min window)
      // Completed ones are already deleted by webhook/callback handlers.
      // Real payment history lives in Transaction, Payment, DonationTransaction.
      const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
      const result = await prisma.pendingTransaction.deleteMany({
        where: {
          status: 'pending',
          expiresAt: { lt: cutoff },
        },
      });
      if (result.count > 0) {
        console.log(`[Cron] Cleaned up ${result.count} abandoned pending transactions`);
      }
    } catch (error) {
      console.error('[Cron] Pending transaction cleanup failed:', error);
    }
  });

  console.log('[Cron] Pending transaction cleanup scheduled (hourly)');
}
