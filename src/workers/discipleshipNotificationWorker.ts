import cron from 'node-cron';
import { dispatchDiscipleshipNotifications } from '../services/discipleshipNotificationService';

let running = false;

async function scan() {
  if (running) return;
  running = true;
  try {
    const result = await dispatchDiscipleshipNotifications();
    if (result.deliveries) console.log(`[discipleship-reminders] Queued ${result.deliveries} delivery attempt(s)`);
  } catch (error) {
    console.error('[discipleship-reminders] Reminder dispatch failed', error);
  } finally {
    running = false;
  }
}

export function startDiscipleshipNotificationWorker() {
  void scan();
  cron.schedule(process.env.DISCIPLESHIP_REMINDER_CRON || '15 * * * *', () => { void scan(); });
}
