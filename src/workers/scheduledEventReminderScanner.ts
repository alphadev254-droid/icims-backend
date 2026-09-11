import cron from 'node-cron';
import { normalizeTimeZone } from '../lib/timezone';
import { processScheduledEventNotifications } from './scheduledEventWorker';

function cronExpression() {
  const configured = process.env.SCHEDULED_EVENT_REMINDER_CRON
    || process.env.SCHEDULED_EVENTS_CRON
    || '*/5 * * * *';
  return cron.validate(configured) ? configured : '*/5 * * * *';
}

function cronTimezone() {
  return normalizeTimeZone(process.env.SCHEDULED_EVENT_REMINDER_TIMEZONE)
    ?? normalizeTimeZone(process.env.SCHEDULED_EVENTS_TIMEZONE)
    ?? normalizeTimeZone(process.env.DEFAULT_TIMEZONE)
    ?? 'UTC';
}

export function startScheduledEventReminderScanner() {
  const expression = cronExpression();
  const timezone = cronTimezone();

  cron.schedule(expression, async () => {
    try {
      await processScheduledEventNotifications();
    } catch (error) {
      console.error('[ScheduledReminders] Scanner failed:', error);
    }
  }, { timezone, noOverlap: true, name: 'scheduled-event-reminder-scanner' });

  console.log(`[ScheduledReminders] Scanner initialized (${expression}, ${timezone})`);
}
