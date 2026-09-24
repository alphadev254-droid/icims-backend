import cron from 'node-cron';
import prisma from '../lib/prisma';
import { processAutomaticReferrerPayouts } from '../services/referrerPayoutService';

let payoutWorkerRunning = false;
let payoutReviewRunning = false;

export function startReferrerPayoutWorker() {
  cron.schedule('0 0 * * *', async () => {
    if (payoutWorkerRunning) return;
    payoutWorkerRunning = true;
    const traceId = `MARKETER-PAYOUT-DAILY-${Date.now()}`;
    try {
      await processAutomaticReferrerPayouts({ traceId });
    } catch (error) {
      console.error(`[${traceId}] Marketer payout worker failed:`, error);
    } finally {
      payoutWorkerRunning = false;
    }
  });

  console.log('[Cron] Marketer payout worker scheduled (daily at midnight)');
}

export function startReferrerPayoutReviewWorker() {
  cron.schedule('20 * * * *', async () => {
    if (payoutReviewRunning) return;
    payoutReviewRunning = true;
    const hours = Math.max(1, Number(process.env.MARKETER_PAYOUT_PROCESSING_REVIEW_HOURS || process.env.WITHDRAWAL_PROCESSING_REVIEW_HOURS || 24));
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    try {
      const result = await (prisma as any).referrerWithdrawal.updateMany({
        where: {
          status: 'processing',
          updatedAt: { lt: cutoff },
        },
        data: {
          status: 'review_required',
          failureReason: `No final PayChangu payout webhook received within ${hours} hour(s). Manual review required.`,
        },
      });
      if (result.count) console.log(`[Cron] Marked stale marketer payouts for review: ${result.count}`);
    } catch (error) {
      console.error('[Cron] Marketer payout review failed:', error);
    } finally {
      payoutReviewRunning = false;
    }
  });

  console.log('[Cron] Marketer payout review worker scheduled (hourly at :20)');
}
