import { z } from 'zod';
import { isValidTimeZone, zonedDateTimeToUtc } from './timezone';

export const REPORT_TYPES = [
  'membership', 'giving', 'giving_by_member', 'pledges', 'attendance',
  'cell_groups', 'cell_visitors', 'church_visitors', 'transactions',
] as const;

export type ReportType = typeof REPORT_TYPES[number];

export const REPORT_DEFINITIONS: Record<ReportType, { label: string; filterKeys: readonly string[] }> = {
  membership: { label: 'Membership Report', filterKeys: ['churchId', 'status', 'cellId', 'teamId'] },
  giving: { label: 'Giving Report', filterKeys: ['churchId', 'category', 'campaignId', 'cellId'] },
  giving_by_member: { label: 'Giving by Member', filterKeys: ['churchId', 'category', 'campaignId'] },
  pledges: { label: 'Pledge Report', filterKeys: ['churchId', 'status', 'category', 'campaignId'] },
  attendance: { label: 'Attendance Report', filterKeys: ['churchId', 'serviceType'] },
  cell_groups: { label: 'Cell Groups Report', filterKeys: ['churchId', 'cellId'] },
  cell_visitors: { label: 'Cell Visitors Report', filterKeys: ['churchId', 'cellId'] },
  church_visitors: { label: 'Church Visitors Report', filterKeys: ['churchId', 'serviceType'] },
  transactions: { label: 'Transactions Report', filterKeys: ['churchId', 'type', 'campaignId'] },
};

const filtersSchema = z.record(z.union([z.string(), z.array(z.string())])).default({});
const recipientsSchema = z.object({
  includeMinistryAdmin: z.boolean().default(true),
  userIds: z.array(z.string().min(1)).default([]),
  emails: z.array(z.string().trim().email()).default([]),
});

export const reportAutomationInputSchema = z.object({
  reportType: z.enum(REPORT_TYPES),
  name: z.string().trim().min(1).max(120),
  filters: filtersSchema,
  periodPreset: z.enum(['previous_week', 'previous_month', 'current_month_to_date', 'last_30_days', 'previous_quarter']),
  frequency: z.enum(['weekly', 'monthly']),
  dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
  dayOfMonth: z.number().int().min(1).max(28).nullable().optional(),
  timeOfDay: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  timezone: z.string().refine(isValidTimeZone, 'Invalid IANA timezone'),
  format: z.literal('xlsx').default('xlsx'),
  recipients: recipientsSchema,
  isActive: z.boolean().default(true),
}).superRefine((value, ctx) => {
  if (value.frequency === 'weekly' && value.dayOfWeek == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dayOfWeek'], message: 'Day of week is required' });
  }
  if (value.frequency === 'monthly' && value.dayOfMonth == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dayOfMonth'], message: 'Day of month is required' });
  }
  const allowed = new Set(REPORT_DEFINITIONS[value.reportType].filterKeys);
  for (const key of Object.keys(value.filters)) {
    if (!allowed.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['filters', key], message: `Filter is not supported by ${value.reportType}` });
  }
  if (!value.recipients.includeMinistryAdmin && value.recipients.userIds.length === 0 && value.recipients.emails.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['recipients'], message: 'Select at least one recipient' });
  }
});

function localDateString(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const values = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function calculateNextReportRun(input: {
  frequency: 'weekly' | 'monthly'; dayOfWeek?: number | null; dayOfMonth?: number | null;
  timeOfDay: string; timezone: string; isActive: boolean;
}, now = new Date()): Date | null {
  if (!input.isActive) return null;
  const localToday = new Date(`${localDateString(now, input.timezone)}T00:00:00.000Z`);
  let candidate = new Date(localToday);
  if (input.frequency === 'weekly') {
    const delta = ((input.dayOfWeek ?? 0) - candidate.getUTCDay() + 7) % 7;
    candidate.setUTCDate(candidate.getUTCDate() + delta);
  } else {
    candidate.setUTCDate(Math.min(input.dayOfMonth ?? 1, 28));
    if (candidate < localToday) candidate.setUTCMonth(candidate.getUTCMonth() + 1);
  }
  let result = zonedDateTimeToUtc(candidate.toISOString().slice(0, 10), input.timeOfDay, input.timezone);
  if (result <= now) {
    if (input.frequency === 'weekly') candidate.setUTCDate(candidate.getUTCDate() + 7);
    else candidate.setUTCMonth(candidate.getUTCMonth() + 1);
    result = zonedDateTimeToUtc(candidate.toISOString().slice(0, 10), input.timeOfDay, input.timezone);
  }
  return result;
}
