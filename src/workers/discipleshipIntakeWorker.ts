import cron from 'node-cron';
import { syncFirstTimerAttendanceCandidates } from '../services/discipleshipIntakeService';

let running = false;

async function scan() {
  if (running) return;
  running = true;
  try {
    const result = await syncFirstTimerAttendanceCandidates({
      since: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      take: 5000,
    });
    if (result.created > 0) console.log(`[discipleship-intake] Added ${result.created} First Timer candidate(s)`);
  } catch (error) {
    console.error('[discipleship-intake] Automatic First Timer sync failed', error);
  } finally {
    running = false;
  }
}

export function startDiscipleshipIntakeWorker() {
  void scan();
  cron.schedule(process.env.DISCIPLESHIP_INTAKE_CRON || '*/2 * * * *', () => { void scan(); });
}
