import cron from 'node-cron';
import { normalizeTimeZone } from '../lib/timezone';
import {
  processDueScheduledCellMeetingEvents,
  processDueScheduledCommunicationEvents,
} from './scheduledEventWorker';

function cronExpression() {
  const configured = process.env.SCHEDULED_EVENT_EXECUTION_CRON
    || process.env.SCHEDULED_EVENTS_CRON
    || '*/5 * * * *';
  return cron.validate(configured) ? configured : '*/5 * * * *';
}

function cronTimezone() {
  return normalizeTimeZone(process.env.SCHEDULED_EVENT_EXECUTION_TIMEZONE)
    ?? normalizeTimeZone(process.env.SCHEDULED_EVENTS_TIMEZONE)
    ?? normalizeTimeZone(process.env.DEFAULT_TIMEZONE)
    ?? 'UTC';
}

export async function processDueScheduledActions() {
  const results = await Promise.allSettled([
    processDueScheduledCommunicationEvents(),
    processDueScheduledCellMeetingEvents(),
  ]);

  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failures.length > 0) {
    failures.forEach(({ reason }) => console.error('[ScheduledExecution] Action processor failed:', reason));
    throw new Error(`${failures.length} scheduled action processor(s) failed`);
  }
}

export function startScheduledEventExecutionScanner() {
  const expression = cronExpression();
  const timezone = cronTimezone();

  cron.schedule(expression, async () => {
    try {
      await processDueScheduledActions();
    } catch (error) {
      console.error('[ScheduledExecution] Scanner failed:', error);
    }
  }, { timezone, noOverlap: true, name: 'scheduled-event-execution-scanner' });

  console.log(`[ScheduledExecution] Scanner initialized (${expression}, ${timezone})`);
}
