import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { zonedDateTimeToUtc } from '../lib/timezone';

type SourceModule = 'events' | 'cell_meetings' | 'announcements' | 'team_communications';

export type RecurrenceRuleInput = {
  frequency?: string | null;
  interval?: number | null;
  daysOfWeek?: string[] | string | null;
  dayOfMonth?: number | null;
  monthOfYear?: number | null;
  startsAt?: Date | string | null;
  endsAt?: Date | string | null;
  count?: number | null;
} | null;

export type ScheduleRecurrenceRuleRow = {
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

export type ExactScheduleOccurrenceInput = Date | string;

export function buildExactScheduleOccurrenceStarts(
  dates: string[] | undefined,
  time?: string | null,
  timezone = 'UTC',
): Date[] {
  return [...new Set(dates ?? [])]
    .map(date => zonedDateTimeToUtc(date, time, timezone))
    .filter(date => !Number.isNaN(date.getTime()))
    .sort((left, right) => left.getTime() - right.getTime());
}

type UpsertScheduledEventInput = {
  ministryId: string;
  churchId?: string | null;
  title: string;
  description?: string | null;
  type: string;
  sourceModule: SourceModule;
  sourceId: string;
  startAt: Date;
  endAt: Date;
  timezone?: string | null;
  locationText?: string | null;
  status?: string | null;
  approvalStatus?: string | null;
  organizerUserId?: string | null;
  createdById?: string | null;
  recurrenceRuleId?: string | null;
};

type EventScheduleSource = {
  id: string;
  title: string;
  description?: string | null;
  type?: string | null;
  date: Date;
  endDate: Date;
  time?: string | null;
  location?: string | null;
  status?: string | null;
  churchId: string;
  createdById?: string | null;
  recurrenceRuleId?: string | null;
  timezone?: string | null;
  church?: { ministryAdminId?: string | null } | null;
};

type CellMeetingScheduleSource = {
  id: string;
  date: Date;
  time?: string | null;
  topic?: string | null;
  notes?: string | null;
  recurrenceRuleId?: string | null;
  timezone?: string | null;
  cellId: string;
  cell: {
    id: string;
    name: string;
    zone?: string | null;
    meetingTime?: string | null;
    churchId: string;
    church?: { ministryAdminId?: string | null } | null;
  };
};

type AnnouncementScheduleSource = {
  id: string;
  title: string;
  content: string;
  type: string;
  priority?: string | null;
  churchId: string;
  createdById?: string | null;
  recurrenceRuleId?: string | null;
  scheduledAt: Date;
  timezone?: string | null;
  church?: { ministryAdminId?: string | null } | null;
};

type TeamCommunicationScheduleSource = {
  id: string;
  title: string;
  content: string;
  teamId: string;
  authorId?: string | null;
  recurrenceRuleId?: string | null;
  scheduledAt: Date;
  timezone?: string | null;
  team: {
    id: string;
    name: string;
    churchId: string;
    church?: { ministryAdminId?: string | null } | null;
  };
};

function combineDateAndTime(date: Date, time?: string | null, timezone = 'UTC'): Date {
  return zonedDateTimeToUtc(date, time, timezone);
}

function withMinimumEnd(startAt: Date, endAt: Date, fallbackMinutes: number): Date {
  if (endAt > startAt) return endAt;
  return new Date(startAt.getTime() + fallbackMinutes * 60 * 1000);
}

function serializeDaysOfWeek(daysOfWeek?: string[] | string | null): string | null {
  if (!daysOfWeek) return null;
  if (Array.isArray(daysOfWeek)) return JSON.stringify(daysOfWeek);
  return daysOfWeek;
}

function normalizeRecurrenceRule(input: RecurrenceRuleInput, fallbackStartsAt: Date) {
  if (!input?.frequency || input.frequency === 'none') return null;

  return {
    frequency: input.frequency,
    interval: Math.max(1, Number(input.interval || 1)),
    daysOfWeek: serializeDaysOfWeek(input.daysOfWeek),
    dayOfMonth: input.dayOfMonth ?? null,
    monthOfYear: input.monthOfYear ?? null,
    startsAt: input.startsAt ? new Date(input.startsAt) : fallbackStartsAt,
    endsAt: input.endsAt ? new Date(input.endsAt) : null,
    count: input.count ?? null,
  };
}

export async function saveRecurrenceRule(input: RecurrenceRuleInput, fallbackStartsAt: Date, existingId?: string | null): Promise<string | null> {
  const rule = normalizeRecurrenceRule(input, fallbackStartsAt);

  if (!rule) {
    if (existingId) {
      await prisma.$executeRaw`DELETE FROM schedule_recurrence_rules WHERE id = ${existingId}`;
    }
    return null;
  }

  const id = existingId ?? randomUUID();

  await prisma.$executeRaw`
    INSERT INTO schedule_recurrence_rules (
      id, frequency, \`interval\`, daysOfWeek, dayOfMonth, monthOfYear,
      startsAt, endsAt, \`count\`, createdAt, updatedAt
    ) VALUES (
      ${id}, ${rule.frequency}, ${rule.interval}, ${rule.daysOfWeek},
      ${rule.dayOfMonth}, ${rule.monthOfYear}, ${rule.startsAt}, ${rule.endsAt},
      ${rule.count}, NOW(3), NOW(3)
    )
    ON DUPLICATE KEY UPDATE
      frequency = VALUES(frequency),
      \`interval\` = VALUES(\`interval\`),
      daysOfWeek = VALUES(daysOfWeek),
      dayOfMonth = VALUES(dayOfMonth),
      monthOfYear = VALUES(monthOfYear),
      startsAt = VALUES(startsAt),
      endsAt = VALUES(endsAt),
      \`count\` = VALUES(\`count\`),
      updatedAt = NOW(3)
  `;

  return id;
}

export async function getRecurrenceRulesById(ids: string[]): Promise<Map<string, ScheduleRecurrenceRuleRow>> {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (uniqueIds.length === 0) return new Map();

  const rows = await prisma.$queryRaw<ScheduleRecurrenceRuleRow[]>`
    SELECT id, frequency, \`interval\`, daysOfWeek, dayOfMonth, monthOfYear, startsAt, endsAt, \`count\`
    FROM schedule_recurrence_rules
    WHERE id IN (${Prisma.join(uniqueIds)})
  `;

  return new Map(rows.map(row => [row.id, row]));
}

export function parseRecurrenceRuleForApi(rule?: ScheduleRecurrenceRuleRow | null) {
  if (!rule) return null;

  let daysOfWeek: string[] = [];
  try {
    daysOfWeek = rule.daysOfWeek ? JSON.parse(rule.daysOfWeek) : [];
  } catch {
    daysOfWeek = rule.daysOfWeek ? rule.daysOfWeek.split(',').map(day => day.trim()).filter(Boolean) : [];
  }

  return {
    id: rule.id,
    frequency: rule.frequency,
    interval: rule.interval,
    daysOfWeek,
    dayOfMonth: rule.dayOfMonth,
    monthOfYear: rule.monthOfYear,
    startsAt: rule.startsAt,
    endsAt: rule.endsAt,
    count: rule.count,
  };
}

export async function upsertScheduledEvent(input: UpsertScheduledEventInput): Promise<string> {
  await prisma.$executeRaw`
    INSERT INTO scheduled_events (
      id, ministryId, churchId, title, description, type, sourceModule, sourceId,
      startAt, endAt, timezone, locationText, status, approvalStatus,
      organizerUserId, createdById, recurrenceRuleId, createdAt, updatedAt
    ) VALUES (
      ${randomUUID()}, ${input.ministryId}, ${input.churchId ?? null}, ${input.title},
      ${input.description ?? null}, ${input.type}, ${input.sourceModule}, ${input.sourceId},
      ${input.startAt}, ${input.endAt}, ${input.timezone ?? 'UTC'}, ${input.locationText ?? null},
      ${input.status ?? 'scheduled'}, ${input.approvalStatus ?? 'not_required'},
      ${input.organizerUserId ?? null}, ${input.createdById ?? null}, ${input.recurrenceRuleId ?? null},
      NOW(3), NOW(3)
    )
    ON DUPLICATE KEY UPDATE
      ministryId = VALUES(ministryId),
      churchId = VALUES(churchId),
      title = VALUES(title),
      description = VALUES(description),
      type = VALUES(type),
      startAt = VALUES(startAt),
      endAt = VALUES(endAt),
      timezone = VALUES(timezone),
      locationText = VALUES(locationText),
      status = VALUES(status),
      approvalStatus = VALUES(approvalStatus),
      organizerUserId = VALUES(organizerUserId),
      createdById = VALUES(createdById),
      recurrenceRuleId = VALUES(recurrenceRuleId),
      updatedAt = NOW(3)
  `;

  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id
    FROM scheduled_events
    WHERE sourceModule = ${input.sourceModule} AND sourceId = ${input.sourceId}
    LIMIT 1
  `;

  if (!rows[0]?.id) {
    throw new Error(`Scheduled event was not saved for ${input.sourceModule}:${input.sourceId}`);
  }

  return rows[0].id;
}

export async function replaceScheduledEventOccurrences(
  scheduledEventId: string,
  occurrenceStarts: ExactScheduleOccurrenceInput[],
  durationMs: number,
): Promise<void> {
  const uniqueStarts = [...new Set(
    occurrenceStarts
      .map(value => new Date(value))
      .filter(date => !Number.isNaN(date.getTime()))
      .map(date => date.toISOString()),
  )].map(value => new Date(value)).sort((a, b) => a.getTime() - b.getTime());

  await prisma.$transaction(async tx => {
    await tx.$executeRaw`
      DELETE FROM scheduled_event_occurrences
      WHERE scheduledEventId = ${scheduledEventId}
        AND status <> 'generated'
    `;

    for (const startAt of uniqueStarts) {
      const endAt = new Date(startAt.getTime() + Math.max(60_000, durationMs));
      await tx.$executeRaw`
        INSERT INTO scheduled_event_occurrences (
          id, scheduledEventId, occurrenceStartAt, occurrenceEndAt, status,
          generatedSourceModule, generatedSourceId, errorMessage, createdAt, updatedAt
        ) VALUES (
          ${randomUUID()}, ${scheduledEventId}, ${startAt}, ${endAt}, 'pending',
          NULL, NULL, NULL, NOW(3), NOW(3)
        )
        ON DUPLICATE KEY UPDATE
          occurrenceEndAt = VALUES(occurrenceEndAt),
          status = IF(status = 'generated', status, VALUES(status)),
          errorMessage = NULL,
          updatedAt = NOW(3)
      `;
    }
  });
}

export async function clearPendingScheduledEventOccurrences(scheduledEventId: string): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM scheduled_event_occurrences
    WHERE scheduledEventId = ${scheduledEventId}
      AND status <> 'generated'
  `;
}

export async function cancelScheduledEventForSource(sourceModule: SourceModule, sourceId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE scheduled_events
    SET status = 'cancelled', updatedAt = NOW(3)
    WHERE sourceModule = ${sourceModule} AND sourceId = ${sourceId}
  `;
}

export async function deleteScheduledEventForSource(sourceModule: SourceModule, sourceId: string): Promise<void> {
  const existing = await prisma.$queryRaw<Array<{ recurrenceRuleId: string | null }>>`
    SELECT recurrenceRuleId
    FROM scheduled_events
    WHERE sourceModule = ${sourceModule} AND sourceId = ${sourceId}
    LIMIT 1
  `;

  await prisma.$executeRaw`
    DELETE FROM scheduled_events
    WHERE sourceModule = ${sourceModule} AND sourceId = ${sourceId}
  `;

  if (existing[0]?.recurrenceRuleId) {
    await prisma.$executeRaw`
      DELETE FROM schedule_recurrence_rules
      WHERE id = ${existing[0].recurrenceRuleId}
    `;
  }
}

export async function syncEventToSchedule(
  event: EventScheduleSource,
  exactOccurrences?: ExactScheduleOccurrenceInput[],
): Promise<void> {
  const ministryId = event.church?.ministryAdminId ?? event.createdById ?? event.churchId;
  const timezone = event.timezone || 'UTC';
  const startAt = combineDateAndTime(event.date, event.time, timezone);
  const endAt = withMinimumEnd(startAt, combineDateAndTime(event.endDate, event.time, timezone), 60);

  const scheduledEventId = await upsertScheduledEvent({
    ministryId,
    churchId: event.churchId,
    title: event.title,
    description: event.description,
    type: event.type || 'event',
    sourceModule: 'events',
    sourceId: event.id,
    startAt,
    endAt,
    timezone,
    locationText: event.location,
    status: event.status === 'upcoming' ? 'scheduled' : event.status,
    approvalStatus: 'not_required',
    organizerUserId: event.createdById,
    createdById: event.createdById,
    recurrenceRuleId: event.recurrenceRuleId,
  });

  const durationMs = Math.max(60 * 60 * 1000, endAt.getTime() - startAt.getTime());
  if (exactOccurrences) {
    await replaceScheduledEventOccurrences(scheduledEventId, exactOccurrences, durationMs);
  } else {
    await clearPendingScheduledEventOccurrences(scheduledEventId);
  }
}

export async function syncCellMeetingToSchedule(
  meeting: CellMeetingScheduleSource,
  createdById?: string | null,
  exactOccurrences?: ExactScheduleOccurrenceInput[],
): Promise<void> {
  const ministryId = meeting.cell.church?.ministryAdminId ?? createdById ?? meeting.cell.churchId;
  const title = meeting.topic ? `${meeting.cell.name}: ${meeting.topic}` : `${meeting.cell.name} Meeting`;
  const timezone = meeting.timezone || 'UTC';
  const startAt = combineDateAndTime(meeting.date, meeting.time || meeting.cell.meetingTime, timezone);
  const endAt = new Date(startAt.getTime() + 120 * 60 * 1000);
  const durationMs = endAt.getTime() - startAt.getTime();

  const scheduledEventId = await upsertScheduledEvent({
    ministryId,
    churchId: meeting.cell.churchId,
    title,
    description: meeting.notes,
    type: 'cell_meeting',
    sourceModule: 'cell_meetings',
    sourceId: meeting.id,
    startAt,
    endAt,
    timezone,
    locationText: meeting.cell.zone,
    status: 'scheduled',
    approvalStatus: 'not_required',
    organizerUserId: createdById ?? null,
    createdById: createdById ?? null,
    recurrenceRuleId: meeting.recurrenceRuleId,
  });

  if (exactOccurrences) {
    await replaceScheduledEventOccurrences(scheduledEventId, exactOccurrences, durationMs);
  } else {
    await clearPendingScheduledEventOccurrences(scheduledEventId);
  }
}

export async function syncAnnouncementToSchedule(announcement: AnnouncementScheduleSource): Promise<void> {
  const ministryId = announcement.church?.ministryAdminId ?? announcement.createdById ?? announcement.churchId;
  const endAt = new Date(announcement.scheduledAt.getTime() + 5 * 60 * 1000);

  await upsertScheduledEvent({
    ministryId,
    churchId: announcement.churchId,
    title: announcement.title,
    description: announcement.content,
    type: 'communication',
    sourceModule: 'announcements',
    sourceId: announcement.id,
    startAt: announcement.scheduledAt,
    endAt,
    timezone: announcement.timezone,
    status: 'scheduled',
    approvalStatus: 'not_required',
    organizerUserId: announcement.createdById,
    createdById: announcement.createdById,
    recurrenceRuleId: announcement.recurrenceRuleId,
  });
}

export async function syncTeamCommunicationToSchedule(communication: TeamCommunicationScheduleSource): Promise<void> {
  const ministryId = communication.team.church?.ministryAdminId ?? communication.authorId ?? communication.team.churchId;
  const endAt = new Date(communication.scheduledAt.getTime() + 5 * 60 * 1000);

  await upsertScheduledEvent({
    ministryId,
    churchId: communication.team.churchId,
    title: communication.title,
    description: communication.content,
    type: 'team_communication',
    sourceModule: 'team_communications',
    sourceId: communication.id,
    startAt: communication.scheduledAt,
    endAt,
    timezone: communication.timezone,
    status: 'scheduled',
    approvalStatus: 'not_required',
    organizerUserId: communication.authorId,
    createdById: communication.authorId,
    recurrenceRuleId: communication.recurrenceRuleId,
  });
}
