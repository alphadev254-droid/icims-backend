import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { queueChurchMemberEmails } from '../lib/churchMemberEmail';
import { queueEmail } from '../lib/emailQueue';
import { sendPushToUsers } from '../lib/fcm';
import { announcementCreatedTemplate } from '../lib/emailTemplates';
import { teamCommunicationNotificationTemplate } from '../lib/teamEmailTemplates';
import { normalizeTimeZone, zonedDateTimeToUtc } from '../lib/timezone';
import { queueCellPush, queueChurchPush } from '../lib/notificationQueue';

type ScheduledEventRow = {
  id: string;
  sourceModule: string;
  sourceId: string | null;
  title: string;
  startAt: Date;
  endAt: Date;
  timezone: string;
  recurrenceRuleId: string | null;
};

type RecurrenceRuleRow = {
  id: string;
  frequency: string;
  interval: number;
  daysOfWeek: string | null;
  dayOfMonth: number | null;
  monthOfYear: number | null;
  startsAt: Date;
  endsAt: Date | null;
  count: number | null;
};

type ScheduledEventOccurrenceRow = {
  id: string;
  status: string;
  occurrenceStartAt: Date;
  occurrenceEndAt: Date;
  generatedSourceId: string | null;
};

type DueCellMeetingOccurrenceRow = ScheduledEventRow & {
  occurrenceId: string;
  occurrenceStartAt: Date;
  occurrenceEndAt: Date;
  occurrenceStatus: string;
  occurrenceGeneratedSourceId: string | null;
};

type CellMeetingNotificationCandidate = {
  scheduledEventId: string;
  scheduledEventOccurrenceId: string | null;
  sourceId: string | null;
  title: string;
  startAt: Date;
  timezone: string;
  cellId: string;
  cellName: string;
  churchId: string;
  churchName: string;
  time: string | null;
  meetingTime: string | null;
};

type ChurchEventNotificationCandidate = {
  scheduledEventId: string;
  scheduledEventOccurrenceId: string | null;
  sourceId: string | null;
  sourceModule: 'events';
  title: string;
  startAt: Date;
  timezone: string;
  churchId: string;
  churchName: string;
  locationText: string | null;
};

type CellMeetingTemplateRow = {
  id: string;
  cellId: string;
  time: string | null;
  topic: string | null;
  meetingTime: string | null;
};

type PrismaExecutor = Pick<typeof prisma, '$executeRaw' | '$queryRaw'>;

const WEEK_DAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const SCHEDULED_EVENT_REMINDER_MINUTES = [...new Set(
  (process.env.SCHEDULED_EVENT_REMINDER_MINUTES || '2880,720,60')
    .split(',')
    .map(value => Number(value.trim()))
    .filter(value => Number.isFinite(value) && value > 0),
)].sort((a, b) => b - a);
const SCHEDULED_EVENT_NOTIFICATION_LOOKAHEAD_MS = Math.max(...SCHEDULED_EVENT_REMINDER_MINUTES, 60) * 60 * 1000;
const configuredReminderWindowMinutes = Number(process.env.SCHEDULED_EVENT_REMINDER_DELIVERY_WINDOW_MINUTES || 10);
const SCHEDULED_EVENT_REMINDER_DELIVERY_WINDOW_MS = (
  Number.isFinite(configuredReminderWindowMinutes) && configuredReminderWindowMinutes > 0
    ? configuredReminderWindowMinutes
    : 10
) * 60 * 1000;

function formatTimeForMeeting(date: Date, timezone = 'UTC') {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

function reminderType(minutes: number) {
  return `minutes_before_${minutes}`;
}

function reminderLabel(minutes: number) {
  if (minutes % 1440 === 0) return `Cell Meeting in ${minutes / 1440} Day${minutes === 1440 ? '' : 's'}`;
  if (minutes % 60 === 0) return `Cell Meeting in ${minutes / 60} Hour${minutes === 60 ? '' : 's'}`;
  return `Cell Meeting in ${minutes} Minutes`;
}

function getDueScheduledReminderTypes(startAt: Date, now = new Date()) {
  const msUntil = startAt.getTime() - now.getTime();
  if (msUntil <= 0 || msUntil > SCHEDULED_EVENT_NOTIFICATION_LOOKAHEAD_MS) return [];

  return SCHEDULED_EVENT_REMINDER_MINUTES
    .filter(minutes => {
      const threshold = minutes * 60 * 1000;
      return msUntil <= threshold && msUntil > threshold - SCHEDULED_EVENT_REMINDER_DELIVERY_WINDOW_MS;
    })
    .map(reminderType);
}

function truncateErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1000);
}

function zonedParts(value: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(value);
  const result: Record<string, number> = {};
  for (const part of parts) if (part.type !== 'literal') result[part.type] = Number(part.value);
  return result;
}

function shiftInTimeZone(value: Date, timezone: string, unit: 'day' | 'month' | 'year', amount: number) {
  const parts = zonedParts(value, timezone);
  const local = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second));
  if (unit === 'day') local.setUTCDate(local.getUTCDate() + amount);
  if (unit === 'month') local.setUTCMonth(local.getUTCMonth() + amount);
  if (unit === 'year') local.setUTCFullYear(local.getUTCFullYear() + amount);
  const date = local.toISOString().slice(0, 10);
  const time = local.toISOString().slice(11, 19);
  return zonedDateTimeToUtc(date, time, timezone);
}

function parseDaysOfWeek(value?: string | null): number[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(day => WEEK_DAY_INDEX[String(day).toLowerCase()])
      .filter((day): day is number => Number.isInteger(day));
  } catch {
    return value
      .split(',')
      .map(day => WEEK_DAY_INDEX[day.trim().toLowerCase()])
      .filter((day): day is number => Number.isInteger(day));
  }
}

function daysBetween(start: Date, end: Date, timezone: string) {
  const startParts = zonedParts(start, timezone);
  const endParts = zonedParts(end, timezone);
  const startDay = Date.UTC(startParts.year, startParts.month - 1, startParts.day);
  const endDay = Date.UTC(endParts.year, endParts.month - 1, endParts.day);
  return Math.floor((endDay - startDay) / 86_400_000);
}

function isWeeklyMatch(rule: RecurrenceRuleRow, candidate: Date, timezone: string) {
  const selectedDays = parseDaysOfWeek(rule.daysOfWeek);
  const weekday = Number(new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(candidate)
    .replace(/^Sun$/, '0').replace(/^Mon$/, '1').replace(/^Tue$/, '2').replace(/^Wed$/, '3')
    .replace(/^Thu$/, '4').replace(/^Fri$/, '5').replace(/^Sat$/, '6'));
  if (selectedDays.length > 0 && !selectedDays.includes(weekday)) return false;
  const weekOffset = Math.floor(Math.max(0, daysBetween(rule.startsAt, candidate, timezone)) / 7);
  return weekOffset % Math.max(1, rule.interval || 1) === 0;
}

function isMonthlyMatch(rule: RecurrenceRuleRow, candidate: Date, timezone: string) {
  const candidateParts = zonedParts(candidate, timezone);
  const startParts = zonedParts(rule.startsAt, timezone);
  const targetDay = rule.dayOfMonth || startParts.day;
  if (candidateParts.day !== targetDay) return false;
  const monthOffset = (candidateParts.year - startParts.year) * 12 + candidateParts.month - startParts.month;
  return monthOffset >= 0 && monthOffset % Math.max(1, rule.interval || 1) === 0;
}

function isYearlyMatch(rule: RecurrenceRuleRow, candidate: Date, timezone: string) {
  const candidateParts = zonedParts(candidate, timezone);
  const startParts = zonedParts(rule.startsAt, timezone);
  const targetMonth = rule.monthOfYear || startParts.month;
  const targetDay = rule.dayOfMonth || startParts.day;
  if (candidateParts.month !== targetMonth || candidateParts.day !== targetDay) return false;
  const yearOffset = candidateParts.year - startParts.year;
  return yearOffset >= 0 && yearOffset % Math.max(1, rule.interval || 1) === 0;
}

function matchesRule(rule: RecurrenceRuleRow, candidate: Date, timezone: string) {
  if (candidate < rule.startsAt) return false;
  if (rule.endsAt && candidate > rule.endsAt) return false;

  if (rule.frequency === 'daily') {
    return daysBetween(rule.startsAt, candidate, timezone) % Math.max(1, rule.interval || 1) === 0;
  }
  if (rule.frequency === 'weekly') return isWeeklyMatch(rule, candidate, timezone);
  if (rule.frequency === 'monthly') return isMonthlyMatch(rule, candidate, timezone);
  if (rule.frequency === 'yearly') return isYearlyMatch(rule, candidate, timezone);
  return false;
}

function getNextOccurrence(rule: RecurrenceRuleRow, after: Date, timezone: string) {
  const interval = Math.max(1, rule.interval || 1);
  let candidate = new Date(after);

  if (rule.frequency === 'daily') {
    candidate = shiftInTimeZone(candidate, timezone, 'day', interval);
    return rule.endsAt && candidate > rule.endsAt ? null : candidate;
  }

  if (rule.frequency === 'monthly') {
    candidate = shiftInTimeZone(candidate, timezone, 'month', interval);
    return rule.endsAt && candidate > rule.endsAt ? null : candidate;
  }

  if (rule.frequency === 'yearly') {
    candidate = shiftInTimeZone(candidate, timezone, 'year', interval);
    return rule.endsAt && candidate > rule.endsAt ? null : candidate;
  }

  if (rule.frequency === 'weekly') {
    candidate = shiftInTimeZone(candidate, timezone, 'day', 1);
    for (let i = 0; i < 3660; i += 1) {
      if (matchesRule(rule, candidate, timezone)) return candidate;
      candidate = shiftInTimeZone(candidate, timezone, 'day', 1);
    }
  }

  return null;
}

function occurrenceNumberThrough(rule: RecurrenceRuleRow, through: Date, timezone: string) {
  let count = 0;
  let cursor = new Date(rule.startsAt);

  for (let i = 0; i < 2000; i += 1) {
    if (cursor > through) break;
    if (matchesRule(rule, cursor, timezone)) count += 1;
    const next = getNextOccurrence(rule, cursor, timezone);
    if (!next || next <= cursor) break;
    cursor = next;
  }

  return count;
}

async function getRecurrenceRule(id: string) {
  const rows = await prisma.$queryRaw<RecurrenceRuleRow[]>`
    SELECT id, frequency, \`interval\`, daysOfWeek, dayOfMonth, monthOfYear, startsAt, endsAt, \`count\`
    FROM schedule_recurrence_rules
    WHERE id = ${id}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

function communicationTypeLabel(type: string) {
  return type === 'newsletter' ? 'Newsletter' : type === 'prayer_request' ? 'Prayer Request' : 'Announcement';
}

async function sendAnnouncement(sourceId: string) {
  const announcement = await prisma.announcement.findUnique({
    where: { id: sourceId },
    include: { church: { select: { name: true } } },
  });
  if (!announcement) return false;

  const churchMembers = await prisma.user.findMany({
    where: { churchId: announcement.churchId, status: 'active' },
    select: { id: true },
  });
  const memberIds = churchMembers.map(member => member.id);
  const prefix = announcement.priority === 'urgent' ? 'URGENT - ' : '';

  if (memberIds.length > 0) {
    await sendPushToUsers(
      memberIds,
      `${announcement.church?.name || 'Your Church'} · ${prefix}${communicationTypeLabel(announcement.type)}`,
      announcement.title,
      { type: 'announcement', id: announcement.id, churchId: announcement.churchId }
    );
  }

  await queueChurchMemberEmails({
    churchId: announcement.churchId,
    subject: `${announcement.church?.name || 'Your Church'} - ${prefix}${communicationTypeLabel(announcement.type)}: ${announcement.title}`,
    buildHtml: member => announcementCreatedTemplate({
      firstName: member.firstName,
      title: announcement.title,
      content: announcement.content,
      type: announcement.type,
      priority: announcement.priority,
      churchName: announcement.church?.name || 'Your Church',
    }),
    emailType: 'notification',
  });

  return true;
}

async function sendTeamCommunication(sourceId: string) {
  const communication = await prisma.teamCommunication.findUnique({
    where: { id: sourceId },
    include: {
      team: {
        include: {
          church: { select: { name: true } },
          members: {
            include: {
              user: { select: { id: true, firstName: true, email: true } },
            },
          },
        },
      },
    },
  });
  if (!communication) return false;

  const author = await prisma.user.findUnique({
    where: { id: communication.authorId },
    select: { firstName: true, lastName: true },
  });
  const authorName = `${author?.firstName ?? ''} ${author?.lastName ?? ''}`.trim() || 'Team';
  const teamMembers = communication.team.members.filter(member => member.userId !== communication.authorId);
  const recipientEmails = teamMembers.map(member => member.user.email).filter(Boolean).join(',');

  if (recipientEmails) {
    await queueEmail(
      recipientEmails,
      `New Team Communication - ${communication.team.name}`,
      teamCommunicationNotificationTemplate({
        firstName: 'Team Member',
        teamName: communication.team.name,
        churchName: communication.team.church.name,
        postTitle: communication.title,
        postContent: communication.content,
        authorName,
      })
    );
  }

  const teamMemberIds = teamMembers.map(member => member.userId);
  if (teamMemberIds.length > 0) {
    await sendPushToUsers(
      teamMemberIds,
      `${communication.team.church.name} · ${communication.team.name}`,
      `${authorName}: ${communication.title}`,
      { type: 'team_communication', id: communication.id, teamId: communication.teamId }
    );
  }

  return true;
}

async function claimScheduledEvent(eventId: string) {
  const updated = await prisma.$executeRaw`
    UPDATE scheduled_events
    SET status = 'processing', updatedAt = NOW(3)
    WHERE id = ${eventId} AND status = 'scheduled'
  `;
  return updated > 0;
}

async function restoreScheduledEvent(eventId: string) {
  await prisma.$executeRaw`
    UPDATE scheduled_events
    SET status = 'scheduled', updatedAt = NOW(3)
    WHERE id = ${eventId} AND status = 'processing'
  `;
}

async function markScheduledEventCancelled(eventId: string) {
  await prisma.$executeRaw`
    UPDATE scheduled_events
    SET status = 'cancelled', updatedAt = NOW(3)
    WHERE id = ${eventId}
  `;
}

async function ensureProcessingOccurrence(db: PrismaExecutor, event: ScheduledEventRow) {
  const occurrenceId = randomUUID();
  await db.$executeRaw`
    INSERT INTO scheduled_event_occurrences (
      id, scheduledEventId, occurrenceStartAt, occurrenceEndAt, status,
      generatedSourceModule, generatedSourceId, errorMessage, createdAt, updatedAt
    ) VALUES (
      ${occurrenceId}, ${event.id}, ${event.startAt}, ${event.endAt}, 'processing',
      NULL, NULL, NULL, NOW(3), NOW(3)
    )
    ON DUPLICATE KEY UPDATE
      status = IF(status = 'generated', status, 'processing'),
      errorMessage = IF(status = 'generated', errorMessage, NULL),
      updatedAt = NOW(3)
  `;

  const rows = await db.$queryRaw<ScheduledEventOccurrenceRow[]>`
    SELECT id, status, occurrenceStartAt, occurrenceEndAt, generatedSourceId
    FROM scheduled_event_occurrences
    WHERE scheduledEventId = ${event.id} AND occurrenceStartAt = ${event.startAt}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function claimScheduledEventOccurrence(occurrenceId: string) {
  const updated = await prisma.$executeRaw`
    UPDATE scheduled_event_occurrences
    SET status = 'processing', errorMessage = NULL, updatedAt = NOW(3)
    WHERE id = ${occurrenceId} AND status IN ('pending', 'failed')
  `;
  return updated > 0;
}

async function countGeneratedOccurrences(db: PrismaExecutor, scheduledEventId: string) {
  const rows = await db.$queryRaw<Array<{ count: bigint | number }>>`
    SELECT COUNT(*) AS count
    FROM scheduled_event_occurrences
    WHERE scheduledEventId = ${scheduledEventId} AND status = 'generated'
  `;
  return Number(rows[0]?.count ?? 0);
}

async function getCellMeetingTemplate(db: PrismaExecutor, sourceId: string) {
  const rows = await db.$queryRaw<CellMeetingTemplateRow[]>`
    SELECT cm.id, cm.cellId, cm.time, cm.topic, c.meetingTime
    FROM cell_meetings cm
    JOIN cells c ON c.id = cm.cellId
    WHERE cm.id = ${sourceId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function createNotificationLogIfNew(
  candidate: CellMeetingNotificationCandidate,
  reminderType: string,
  recipientCount: number,
) {
  const id = randomUUID();
  const inserted = await prisma.$executeRaw`
    INSERT IGNORE INTO scheduled_event_notification_logs (
      id, scheduledEventId, scheduledEventOccurrenceId, reminderType, channel,
      sourceModule, sourceId, recipientCount, scheduledFor, sentAt, errorMessage
    ) VALUES (
      ${id}, ${candidate.scheduledEventId}, ${candidate.scheduledEventOccurrenceId}, ${reminderType}, 'push',
      'cell_meetings', ${candidate.sourceId}, ${recipientCount}, ${candidate.startAt}, NOW(3), NULL
    )
  `;
  return inserted > 0;
}

async function markNotificationLogFailed(
  candidate: CellMeetingNotificationCandidate,
  reminderType: string,
  error: unknown,
) {
  const message = truncateErrorMessage(error);
  console.error(`[ScheduledEvents] Cell meeting reminder send failed: ${message}`);
  await prisma.$executeRaw`
    DELETE FROM scheduled_event_notification_logs
    WHERE scheduledEventId = ${candidate.scheduledEventId}
      AND scheduledFor = ${candidate.startAt}
      AND reminderType = ${reminderType}
      AND channel = 'push'
  `;
}

async function sendCellMeetingReminder(candidate: CellMeetingNotificationCandidate, reminderType: string) {
  const members = await prisma.cellMember.findMany({
    where: { cellId: candidate.cellId, status: 'active' },
    select: { userId: true },
  });
  const memberIds = members.map(member => member.userId);
  if (memberIds.length === 0) return false;

  const createdLog = await createNotificationLogIfNew(candidate, reminderType, memberIds.length);
  if (!createdLog) return false;

  const time = candidate.time || candidate.meetingTime || formatTimeForMeeting(candidate.startAt, candidate.timezone);
  const minutes = Number(reminderType.replace('minutes_before_', ''));
  try {
    await queueCellPush(
      candidate.cellId,
      candidate.churchId,
      `${candidate.churchName} · ${reminderLabel(minutes)}`,
      `${candidate.title || candidate.cellName} at ${time}`,
      {
        type: 'cell_meeting_reminder',
        cellId: candidate.cellId,
        scheduledEventId: candidate.scheduledEventId,
        occurrenceId: candidate.scheduledEventOccurrenceId ?? '',
        reminderType,
      },
      `scheduled-reminder-${candidate.scheduledEventId}-${candidate.scheduledEventOccurrenceId ?? 'base'}-${reminderType}-push`,
    );
    return true;
  } catch (error) {
    await markNotificationLogFailed(candidate, reminderType, error);
    throw error;
  }
}

async function getUpcomingCellMeetingNotificationCandidates() {
  const now = new Date();
  const until = new Date(now.getTime() + SCHEDULED_EVENT_NOTIFICATION_LOOKAHEAD_MS);
  const customOccurrences = await prisma.$queryRaw<CellMeetingNotificationCandidate[]>`
    SELECT
      se.id AS scheduledEventId,
      seo.id AS scheduledEventOccurrenceId,
      se.sourceId,
      se.title,
      se.timezone,
      seo.occurrenceStartAt AS startAt,
      cm.cellId,
      c.name AS cellName,
      c.churchId,
      ch.name AS churchName,
      cm.time,
      c.meetingTime
    FROM scheduled_event_occurrences seo
    JOIN scheduled_events se ON se.id = seo.scheduledEventId
    JOIN cell_meetings cm ON cm.id = se.sourceId
    JOIN cells c ON c.id = cm.cellId
    JOIN churches ch ON ch.id = c.churchId
    WHERE se.status = 'scheduled'
      AND se.sourceModule = 'cell_meetings'
      AND se.recurrenceRuleId IS NULL
      AND seo.status IN ('pending', 'failed')
      AND seo.occurrenceStartAt > ${now}
      AND seo.occurrenceStartAt <= ${until}
    ORDER BY seo.occurrenceStartAt ASC
  `;

  const scheduledEvents = await prisma.$queryRaw<CellMeetingNotificationCandidate[]>`
    SELECT
      se.id AS scheduledEventId,
      NULL AS scheduledEventOccurrenceId,
      se.sourceId,
      se.title,
      se.timezone,
      se.startAt,
      cm.cellId,
      c.name AS cellName,
      c.churchId,
      ch.name AS churchName,
      cm.time,
      c.meetingTime
    FROM scheduled_events se
    JOIN cell_meetings cm ON cm.id = se.sourceId
    JOIN cells c ON c.id = cm.cellId
    JOIN churches ch ON ch.id = c.churchId
    WHERE se.status = 'scheduled'
      AND se.sourceModule = 'cell_meetings'
      AND se.startAt > ${now}
      AND se.startAt <= ${until}
      AND (
        se.recurrenceRuleId IS NOT NULL
        OR NOT EXISTS (
          SELECT 1 FROM scheduled_event_occurrences seo
          WHERE seo.scheduledEventId = se.id
        )
      )
    ORDER BY se.startAt ASC
  `;

  return [...customOccurrences, ...scheduledEvents];
}

async function getUpcomingChurchEventNotificationCandidates() {
  const now = new Date();
  const until = new Date(now.getTime() + SCHEDULED_EVENT_NOTIFICATION_LOOKAHEAD_MS);
  const exactOccurrences = await prisma.$queryRaw<ChurchEventNotificationCandidate[]>`
    SELECT
      se.id AS scheduledEventId,
      seo.id AS scheduledEventOccurrenceId,
      se.sourceId,
      se.sourceModule,
      se.title,
      seo.occurrenceStartAt AS startAt,
      se.timezone,
      se.churchId,
      ch.name AS churchName,
      se.locationText
    FROM scheduled_event_occurrences seo
    JOIN scheduled_events se ON se.id = seo.scheduledEventId
    JOIN churches ch ON ch.id = se.churchId
    WHERE se.status = 'scheduled'
      AND se.sourceModule = 'events'
      AND se.recurrenceRuleId IS NULL
      AND seo.status IN ('pending', 'generated')
      AND seo.occurrenceStartAt > ${now}
      AND seo.occurrenceStartAt <= ${until}
    ORDER BY seo.occurrenceStartAt ASC
  `;
  const scheduledEvents = await prisma.$queryRaw<ChurchEventNotificationCandidate[]>`
    SELECT
      se.id AS scheduledEventId,
      NULL AS scheduledEventOccurrenceId,
      se.sourceId,
      se.sourceModule,
      se.title,
      se.startAt,
      se.timezone,
      se.churchId,
      ch.name AS churchName,
      se.locationText
    FROM scheduled_events se
    JOIN churches ch ON ch.id = se.churchId
    WHERE se.status = 'scheduled'
      AND se.sourceModule = 'events'
      AND se.startAt > ${now}
      AND se.startAt <= ${until}
      AND NOT EXISTS (
        SELECT 1 FROM scheduled_event_occurrences seo
        WHERE seo.scheduledEventId = se.id
      )
    ORDER BY se.startAt ASC
  `;
  return [...exactOccurrences, ...scheduledEvents];
}

async function queueChurchEventReminder(candidate: ChurchEventNotificationCandidate, type: string) {
  const id = randomUUID();
  const inserted = await prisma.$executeRaw`
    INSERT IGNORE INTO scheduled_event_notification_logs (
      id, scheduledEventId, scheduledEventOccurrenceId, reminderType, channel,
      sourceModule, sourceId, recipientCount, scheduledFor, sentAt, errorMessage
    ) VALUES (
      ${id}, ${candidate.scheduledEventId}, ${candidate.scheduledEventOccurrenceId}, ${type}, 'push',
      'events', ${candidate.sourceId}, 0, ${candidate.startAt}, NOW(3), NULL
    )
  `;
  if (inserted === 0) return false;

  const eventChurches = candidate.sourceId
    ? await prisma.eventChurch.findMany({ where: { eventId: candidate.sourceId }, select: { churchId: true } })
    : [];
  const churchIds = [...new Set([candidate.churchId, ...eventChurches.map(item => item.churchId)].filter(Boolean))];
  const minutes = Number(type.replace('minutes_before_', ''));
  const time = formatTimeForMeeting(candidate.startAt, candidate.timezone);

  try {
    await Promise.all(churchIds.map(churchId => queueChurchPush(
      churchId,
      `${candidate.churchName} · ${reminderLabel(minutes)}`,
      `${candidate.title} at ${time}${candidate.locationText ? ` · ${candidate.locationText}` : ''}`,
      {
        type: 'event_reminder',
        eventId: candidate.sourceId ?? '',
        scheduledEventId: candidate.scheduledEventId,
        reminderType: type,
      },
      `scheduled-reminder-${candidate.scheduledEventId}-${candidate.scheduledEventOccurrenceId ?? 'base'}-${type}-push-${churchId}`,
    )));
    return true;
  } catch (error) {
    await prisma.$executeRaw`
      DELETE FROM scheduled_event_notification_logs
      WHERE scheduledEventId = ${candidate.scheduledEventId}
        AND scheduledFor = ${candidate.startAt}
        AND reminderType = ${type}
        AND channel = 'push'
    `;
    throw error;
  }
}

async function createCellMeetingOccurrence(
  event: ScheduledEventRow,
  selectedOccurrence?: ScheduledEventOccurrenceRow,
) {
  if (!event.sourceId) return null;

  return prisma.$transaction(async tx => {
    const occurrence = selectedOccurrence ?? await ensureProcessingOccurrence(tx, event);
    if (!occurrence) return null;
    if (occurrence.status === 'generated' && occurrence.generatedSourceId) return occurrence.generatedSourceId;

    const generatedCount = await countGeneratedOccurrences(tx, event.id);
    const template = await getCellMeetingTemplate(tx, event.sourceId!);
    if (!template) return null;

    const occurrenceStartAt = occurrence.occurrenceStartAt ?? event.startAt;
    const generatedMeetingId = generatedCount === 0 ? event.sourceId! : randomUUID();

    if (generatedCount > 0) {
      await tx.$executeRaw`
        INSERT INTO cell_meetings (
          id, cellId, date, time, topic, notes, recurrenceRuleId,
          recordType, sourceMeetingId, scheduledOccurrenceId, createdAt, updatedAt
        ) VALUES (
          ${generatedMeetingId}, ${template.cellId}, ${occurrenceStartAt},
          ${template.time || template.meetingTime || formatTimeForMeeting(occurrenceStartAt)},
          ${template.topic}, NULL, NULL,
          'scheduled_occurrence', ${event.sourceId}, ${occurrence.id}, NOW(3), NOW(3)
        )
      `;
    } else {
      await tx.$executeRaw`
        UPDATE cell_meetings
        SET recordType = 'scheduled_source',
            sourceMeetingId = NULL,
            scheduledOccurrenceId = ${occurrence.id},
            updatedAt = NOW(3)
        WHERE id = ${event.sourceId}
      `;
    }

    await tx.$executeRaw`
      UPDATE scheduled_event_occurrences
      SET status = 'generated',
          generatedSourceModule = 'cell_meetings',
          generatedSourceId = ${generatedMeetingId},
          errorMessage = NULL,
          updatedAt = NOW(3)
      WHERE id = ${occurrence.id}
    `;

    return generatedMeetingId;
  });
}

async function markOccurrenceFailed(event: ScheduledEventRow, error: unknown) {
  await prisma.$executeRaw`
    UPDATE scheduled_event_occurrences
    SET status = 'failed',
        errorMessage = ${truncateErrorMessage(error)},
        updatedAt = NOW(3)
    WHERE scheduledEventId = ${event.id} AND occurrenceStartAt = ${event.startAt}
  `;
}

async function markOccurrenceRowFailed(occurrenceId: string, error: unknown) {
  await prisma.$executeRaw`
    UPDATE scheduled_event_occurrences
    SET status = 'failed',
        errorMessage = ${truncateErrorMessage(error)},
        updatedAt = NOW(3)
    WHERE id = ${occurrenceId}
  `;
}

async function completeCustomScheduleIfDone(eventId: string) {
  const rows = await prisma.$queryRaw<Array<{ remaining: bigint | number }>>`
    SELECT COUNT(*) AS remaining
    FROM scheduled_event_occurrences
    WHERE scheduledEventId = ${eventId}
      AND status IN ('pending', 'failed', 'processing')
  `;
  if (Number(rows[0]?.remaining ?? 0) === 0) {
    await prisma.$executeRaw`
      UPDATE scheduled_events
      SET status = 'completed', updatedAt = NOW(3)
      WHERE id = ${eventId} AND status = 'scheduled'
    `;
  }
}

async function advanceOrCompleteSchedule(event: ScheduledEventRow) {
  if (!event.recurrenceRuleId) {
    await prisma.$executeRaw`
      UPDATE scheduled_events
      SET status = 'completed', updatedAt = NOW(3)
      WHERE id = ${event.id}
    `;
    return;
  }

  const rule = await getRecurrenceRule(event.recurrenceRuleId);
  if (!rule) {
    await prisma.$executeRaw`
      UPDATE scheduled_events
      SET status = 'completed', updatedAt = NOW(3)
      WHERE id = ${event.id}
    `;
    return;
  }

  const sentCount = occurrenceNumberThrough(rule, event.startAt, event.timezone || 'UTC');
  const nextStartAt = rule.count && sentCount >= rule.count ? null : getNextOccurrence(rule, event.startAt, event.timezone || 'UTC');
  if (!nextStartAt) {
    await prisma.$executeRaw`
      UPDATE scheduled_events
      SET status = 'completed', updatedAt = NOW(3)
      WHERE id = ${event.id}
    `;
    return;
  }

  const durationMs = Math.max(60_000, event.endAt.getTime() - event.startAt.getTime());
  const nextEndAt = new Date(nextStartAt.getTime() + durationMs);
  await prisma.$executeRaw`
    UPDATE scheduled_events
    SET startAt = ${nextStartAt}, endAt = ${nextEndAt}, updatedAt = NOW(3)
    WHERE id = ${event.id}
  `;
}

export async function processDueScheduledCommunicationEvents() {
  const limit = Number(process.env.SCHEDULED_EVENTS_BATCH_SIZE || 25);
  const events = await prisma.$queryRaw<ScheduledEventRow[]>`
    SELECT id, sourceModule, sourceId, title, startAt, endAt, timezone, recurrenceRuleId
    FROM scheduled_events
    WHERE status = 'scheduled'
      AND startAt <= NOW(3)
      AND sourceModule IN (${Prisma.join(['announcements', 'team_communications'])})
    ORDER BY startAt ASC
    LIMIT ${limit}
  `;

  for (const event of events) {
    if (!event.sourceId) continue;

    try {
      const claimed = await claimScheduledEvent(event.id);
      if (!claimed) continue;

      const sent = event.sourceModule === 'announcements'
        ? await sendAnnouncement(event.sourceId)
        : await sendTeamCommunication(event.sourceId);

      if (!sent) {
        await markScheduledEventCancelled(event.id);
        continue;
      }

      await restoreScheduledEvent(event.id);
      await advanceOrCompleteSchedule(event);
    } catch (error) {
      console.error(`[ScheduledEvents] Failed to process ${event.sourceModule}:${event.sourceId}`, error);
      await restoreScheduledEvent(event.id);
    }
  }

  if (events.length > 0) {
    console.log(`[ScheduledEvents] Processed ${events.length} due communication schedule(s)`);
  }
}

export async function processDueScheduledCellMeetingEvents() {
  const limit = Number(process.env.SCHEDULED_EVENTS_BATCH_SIZE || 25);
  const customOccurrences = await prisma.$queryRaw<DueCellMeetingOccurrenceRow[]>`
    SELECT
      se.id, se.sourceModule, se.sourceId, se.title, se.startAt, se.endAt, se.timezone, se.recurrenceRuleId,
      seo.id AS occurrenceId, seo.occurrenceStartAt, seo.occurrenceEndAt,
      seo.status AS occurrenceStatus, seo.generatedSourceId AS occurrenceGeneratedSourceId
    FROM scheduled_event_occurrences seo
    JOIN scheduled_events se ON se.id = seo.scheduledEventId
    WHERE se.status = 'scheduled'
      AND se.sourceModule = 'cell_meetings'
      AND se.recurrenceRuleId IS NULL
      AND seo.status IN ('pending', 'failed')
      AND seo.occurrenceStartAt <= NOW(3)
    ORDER BY seo.occurrenceStartAt ASC
    LIMIT ${limit}
  `;

  for (const occurrenceEvent of customOccurrences) {
    if (!occurrenceEvent.sourceId) {
      await markScheduledEventCancelled(occurrenceEvent.id);
      continue;
    }

    try {
      const claimed = await claimScheduledEventOccurrence(occurrenceEvent.occurrenceId);
      if (!claimed) continue;

      const generatedMeetingId = await createCellMeetingOccurrence(occurrenceEvent, {
        id: occurrenceEvent.occurrenceId,
        status: 'processing',
        occurrenceStartAt: occurrenceEvent.occurrenceStartAt,
        occurrenceEndAt: occurrenceEvent.occurrenceEndAt,
        generatedSourceId: occurrenceEvent.occurrenceGeneratedSourceId,
      });
      if (!generatedMeetingId) {
        await markScheduledEventCancelled(occurrenceEvent.id);
        continue;
      }

      await completeCustomScheduleIfDone(occurrenceEvent.id);
    } catch (error) {
      console.error(`[ScheduledEvents] Failed to generate custom-date cell meeting for ${occurrenceEvent.sourceId}`, error);
      await markOccurrenceRowFailed(occurrenceEvent.occurrenceId, error);
    }
  }

  const events = await prisma.$queryRaw<ScheduledEventRow[]>`
    SELECT se.id, se.sourceModule, se.sourceId, se.title, se.startAt, se.endAt, se.timezone, se.recurrenceRuleId
    FROM scheduled_events se
    WHERE se.status = 'scheduled'
      AND se.startAt <= NOW(3)
      AND se.sourceModule = 'cell_meetings'
      AND (
        se.recurrenceRuleId IS NOT NULL
        OR NOT EXISTS (
          SELECT 1 FROM scheduled_event_occurrences seo
          WHERE seo.scheduledEventId = se.id
        )
      )
    ORDER BY se.startAt ASC
    LIMIT ${limit}
  `;

  for (const event of events) {
    if (!event.sourceId) {
      await markScheduledEventCancelled(event.id);
      continue;
    }

    try {
      const claimed = await claimScheduledEvent(event.id);
      if (!claimed) continue;

      const generatedMeetingId = await createCellMeetingOccurrence(event);
      if (!generatedMeetingId) {
        await markScheduledEventCancelled(event.id);
        continue;
      }

      await restoreScheduledEvent(event.id);
      await advanceOrCompleteSchedule(event);
    } catch (error) {
      console.error(`[ScheduledEvents] Failed to generate cell meeting for ${event.sourceId}`, error);
      await markOccurrenceFailed(event, error);
      await restoreScheduledEvent(event.id);
    }
  }

  if (customOccurrences.length > 0 || events.length > 0) {
    console.log(`[ScheduledEvents] Processed ${customOccurrences.length + events.length} due cell meeting schedule(s)`);
  }
}

export async function processScheduledEventNotifications() {
  const [cellCandidates, eventCandidates] = await Promise.all([
    getUpcomingCellMeetingNotificationCandidates(),
    getUpcomingChurchEventNotificationCandidates(),
  ]);
  let queuedCount = 0;

  for (const candidate of cellCandidates) {
    for (const type of getDueScheduledReminderTypes(candidate.startAt)) {
      try {
        if (await sendCellMeetingReminder(candidate, type)) queuedCount += 1;
      } catch (error) {
        console.error(`[ScheduledEvents] Failed to queue ${type} reminder for ${candidate.scheduledEventId}`, error);
      }
    }
  }

  for (const candidate of eventCandidates) {
    for (const type of getDueScheduledReminderTypes(candidate.startAt)) {
      try {
        if (await queueChurchEventReminder(candidate, type)) queuedCount += 1;
      } catch (error) {
        console.error(`[ScheduledEvents] Failed to queue ${type} reminder for ${candidate.scheduledEventId}`, error);
      }
    }
  }

  if (queuedCount > 0) console.log(`[ScheduledEvents] Queued ${queuedCount} scheduled event reminder(s)`);
}
