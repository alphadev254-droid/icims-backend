import cron from 'node-cron';
import { claimDueReportAutomations, executeReportAutomation } from '../services/reportAutomationExecution';

let running = false;
export function startReportAutomationWorker() {
  cron.schedule('*/5 * * * *', async () => {
    if (running) return;
    running = true;
    try {
      const ids = await claimDueReportAutomations();
      for (const id of ids) {
        try { await executeReportAutomation(id); }
        catch (error) { console.error(`[report-automation] ${id} failed`, error); }
      }
    } catch (error) { console.error('[report-automation] scanner failed', error); }
    finally { running = false; }
  });
}
