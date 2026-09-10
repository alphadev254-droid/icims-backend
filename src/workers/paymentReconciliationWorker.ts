import cron from 'node-cron';
import {
  abandonVeryStalePendingTransactions,
  reconcilePendingTransactionsBatch,
} from '../services/paymentReconciliationService';

let reconciliationRunning = false;
let staleCleanupRunning = false;

export function startPaymentReconciliationWorker() {
  cron.schedule('*/5 * * * *', async () => {
    if (reconciliationRunning) return;
    reconciliationRunning = true;
    const traceId = `RECON-AUTO-${Date.now()}`;
    try {
      await reconcilePendingTransactionsBatch({ traceId });
    } catch (error) {
      console.error(`[${traceId}] Payment reconciliation worker failed:`, error);
    } finally {
      reconciliationRunning = false;
    }
  });

  cron.schedule('17 * * * *', async () => {
    if (staleCleanupRunning) return;
    staleCleanupRunning = true;
    const traceId = `RECON-STALE-${Date.now()}`;
    try {
      await abandonVeryStalePendingTransactions({ traceId });
    } catch (error) {
      console.error(`[${traceId}] Stale pending cleanup failed:`, error);
    } finally {
      staleCleanupRunning = false;
    }
  });

  console.log('[Cron] Payment reconciliation scheduled (every 5 minutes)');
  console.log('[Cron] Stale pending cleanup scheduled (hourly at :17)');
}
