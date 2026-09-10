import cron from 'node-cron';
import { reconcilePaystackSettlements } from '../services/settlementReconciliationService';

let running = false;

export function startSettlementReconciliationWorker() {
  if (process.env.PAYSTACK_SETTLEMENT_RECONCILIATION_ENABLED !== 'true') {
    console.log('[Cron] Paystack settlement reconciliation disabled');
    return;
  }
  cron.schedule(process.env.PAYSTACK_SETTLEMENT_RECONCILIATION_CRON || '23 * * * *', async () => {
    if (running) return;
    running = true;
    try {
      const result = await reconcilePaystackSettlements();
      console.log('[Cron] Paystack settlement reconciliation finished', result);
    } catch (error) {
      console.error('[Cron] Paystack settlement reconciliation failed', error);
    } finally {
      running = false;
    }
  });
  console.log('[Cron] Paystack settlement reconciliation scheduled');
}
