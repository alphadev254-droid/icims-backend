import { randomUUID } from 'crypto';
import cron from 'node-cron';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { queueChurchMemberEmails } from '../lib/churchMemberEmail';
import { queueEmail } from '../lib/emailQueue';
import { sendPushToUsers } from '../lib/fcm';
import { announcementCreatedTemplate } from '../lib/emailTemplates';
import { teamCommunicationNotificationTemplate } from '../lib/teamEmailTemplates';

type ScheduledEventRow = {
  id: string;
  sourceModule: string;
  sourceId: string | null;
  title: string;
  startAt: Date;
  endAt: Date;
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
  generatedSourceId: string | null;
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

function formatTimeForMeeting(date: Date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function truncateErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1000);
}

function addDays(value: Date, days: number) {
  const date = new Date(value);
  date.setDate(date.getDate() + days);
  return date;
}

function addMonths(value: Date, months: number) {
  const date = new Date(value);
  date.setMonth(date.getMonth() + months);
  return date;
}

function addYears(value: Date, years: number) {
  const date = new Date(value);
  date.setFullYear(date.getFullYear() + years);
  return date;
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

function daysBetween(start: Date, end: Date) {
  const startDay = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const endDay = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
  return Math.floor((endDay - startDay) / 86_400_000);
}

function isWeeklyMatch(rule: RecurrenceRuleRow, candidate: Date) {
  const selectedDays = parseDaysOfWeek(rule.daysOfWeek);
  if (selectedDays.length > 0 && !selectedDays.includes(candidate.getDay())) return false;
  const weekOffset = Math.floor(Math.max(0, daysBetween(rule.startsAt, candidate)) / 7);
  return weekOffset % Math.max(1, rule.interval || 1) === 0;
}

function isMonthlyMatch(rule: RecurrenceRuleRow, candidate: Date) {
  const targetDay = rule.dayOfMonth || rule.startsAt.getDate();
  if (candidate.getDate() !== targetDay) return false;
  const monthOffset = (candidate.getFullYear() - rule.startsAt.getFullYear()) * 12 + candidate.getMonth() - rule.startsAt.getMonth();
  return monthOffset >= 0 && monthOffset % Math.max(1, rule.interval || 1) === 0;
}

function isYearlyMatch(rule: RecurrenceRuleRow, candidate: Date) {
  const targetMonth = (rule.monthOfYear || rule.startsAt.getMonth() + 1) - 1;
  const targetDay = rule.dayOfMonth || rule.startsAt.getDate();
  if (candidate.getMonth() !== targetMonth || candidate.getDate() !== targetDay) return false;
  const yearOffset = candidate.getFullYear() - rule.startsAt.getFullYear();
  return yearOffset >= 0 && yearOffset % Math.max(1, rule.interval || 1) === 0;
}

function matchesRule(rule: RecurrenceRuleRow, candidate: Date) {
  if (candidate < rule.startsAt) return false;
  if (rule.endsAt && candidate > rule.endsAt) return false;

  if (rule.frequency === 'daily') {
    return daysBetween(rule.startsAt, candidate) % Math.max(1, rule.interval || 1) === 0;
  }
  if (rule.frequency === 'weekly') return isWeeklyMatch(rule, candidate);
  if (rule.frequency === 'monthly') return isMonthlyMatch(rule, candidate);
  if (rule.frequency === 'yearly') return isYearlyMatch(rule, candidate);
  return false;
}

function copyTime(source: Date, target: Date) {
  const next = new Date(target);
  next.setHours(source.getHours(), source.getMinutes(), source.getSeconds(), source.getMilliseconds());
  return next;
}

function getNextOccurrence(rule: RecurrenceRuleRow, after: Date) {
  const interval = Math.max(1, rule.interval || 1);
  let candidate = new Date(after);

  if (rule.frequency === 'daily') {
    candidate = addDays(candidate, interval);
    return rule.endsAt && candidate > rule.endsAt ? null : candidate;
  }

  if (rule.frequency === 'monthly') {
    candidate = addMonths(candidate, interval);
    candidate.setDate(rule.dayOfMonth || rule.startsAt.getDate());
    return rule.endsAt && candidate > rule.endsAt ? null : candidate;
  }

  if (rule.frequency === 'yearly') {
    candidate = addYears(candidate, interval);
    candidate.setMonth((rule.monthOfYear || rule.startsAt.getMonth() + 1) - 1);
    candidate.setDate(rule.dayOfMonth || rule.startsAt.getDate());
    return rule.endsAt && candidate > rule.endsAt ? null : candidate;
  }

  if (rule.frequency === 'weekly') {
    candidate = addDays(candidate, 1);
    for (let i = 0; i < 3660; i += 1) {
      const possible = copyTime(after, candidate);
      if (matchesRule(rule, possible)) return possible;
      candidate = addDays(candidate, 1);
    }
  }

  return null;
}

function occurrenceNumberThrough(rule: RecurrenceRuleRow, through: Date) {
  let count = 0;
  let cursor = new Date(rule.startsAt);

  for (let i = 0; i < 2000; i += 1) {
    if (cursor > through) break;
    if (matchesRule(rule, cursor)) count += 1;
    const next = getNextOccurrence(rule, cursor);
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
    SELECT id, status, generatedSourceId
    FROM scheduled_event_occurrences
    WHERE scheduledEventId = ${event.id} AND occurrenceStartAt = ${event.startAt}
    LIMIT 1
  `;
  return rows[0] ?? null;
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

async function createCellMeetingOccurrence(event: ScheduledEventRow) {
  if (!event.sourceId) return null;

  return prisma.$transaction(async tx => {
    const occurrence = await ensureProcessingOccurrence(tx, event);
    if (!occurrence) return null;
    if (occurrence.status === 'generated' && occurrence.generatedSourceId) return occurrence.generatedSourceId;

    const generatedCount = await countGeneratedOccurrences(tx, event.id);
    const template = await getCellMeetingTemplate(tx, event.sourceId!);
    if (!template) return null;

    const generatedMeetingId = generatedCount === 0 ? event.sourceId! : randomUUID();

    if (generatedCount > 0) {
      await tx.$executeRaw`
        INSERT INTO cell_meetings (
          id, cellId, date, time, topic, notes, recurrenceRuleId, createdAt, updatedAt
        ) VALUES (
          ${generatedMeetingId}, ${template.cellId}, ${event.startAt},
          ${template.time || template.meetingTime || formatTimeForMeeting(event.startAt)},
          ${template.topic}, NULL, NULL, NOW(3), NOW(3)
        )
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

  const sentCount = occurrenceNumberThrough(rule, event.startAt);
  const nextStartAt = rule.count && sentCount >= rule.count ? null : getNextOccurrence(rule, event.startAt);
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
    SELECT id, sourceModule, sourceId, title, startAt, endAt, recurrenceRuleId
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
  const events = await prisma.$queryRaw<ScheduledEventRow[]>`
    SELECT id, sourceModule, sourceId, title, startAt, endAt, recurrenceRuleId
    FROM scheduled_events
    WHERE status = 'scheduled'
      AND startAt <= NOW(3)
      AND sourceModule = 'cell_meetings'
    ORDER BY startAt ASC
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

  if (events.length > 0) {
    console.log(`[ScheduledEvents] Processed ${events.length} due cell meeting schedule(s)`);
  }
}

export function startScheduledEventWorker() {
  const expression = process.env.SCHEDULED_EVENTS_CRON || '* * * * *';
  cron.schedule(expression, () => {
    Promise.all([
      processDueScheduledCommunicationEvents(),
      processDueScheduledCellMeetingEvents(),
    ]).catch(error => {
      console.error('[ScheduledEvents] Worker failed:', error);
    });
  });
  console.log(`[ScheduledEvents] Scheduler initialized (${expression})`);
}
