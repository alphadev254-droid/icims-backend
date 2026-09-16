import { Request } from 'express';
import { hasFeature } from './packageChecker';

export type ScheduleAction = 'create' | 'update' | 'delete';

type RecurrenceRuleLike = {
  frequency?: string | null;
} | null | undefined;

export function hasRecurringRule(recurrenceRule?: RecurrenceRuleLike): boolean {
  return Boolean(recurrenceRule?.frequency && recurrenceRule.frequency !== 'none');
}

export async function assertScheduleAccess(
  req: Request,
  recurrenceRule?: RecurrenceRuleLike,
  _action: ScheduleAction = 'create',
  requiresRecurringFeature = false,
): Promise<{ allowed: boolean; message?: string }> {
  const userId = req.user?.userId;
  if (!userId) return { allowed: false, message: 'Not authenticated' };

  if (!(await hasFeature(userId, 'scheduler_event_creation'))) {
    return { allowed: false, message: 'This package does not include scheduling.' };
  }

  if ((requiresRecurringFeature || hasRecurringRule(recurrenceRule)) && !(await hasFeature(userId, 'scheduler_recurring_events'))) {
    return { allowed: false, message: 'This package does not include recurring schedules.' };
  }

  return { allowed: true };
}
