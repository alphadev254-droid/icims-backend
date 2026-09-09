import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';

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
  church?: { ministryAdminId?: string | null } | null;
};

type CellMeetingScheduleSource = {
  id: string;
  date: Date;
  time?: string | null;
  topic?: string | null;
  notes?: string | null;
  recurrenceRuleId?: string | null;
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
  team: {
    id: string;
    name: string;
    churchId: string;
    church?: { ministryAdminId?: string | null } | null;
  };
};

function combineDateAndTime(date: Date, time?: string | null): Date {
  const combined = new Date(date);
  const match = time?.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return combined;

  combined.setHours(Number(match[1]), Number(match[2]), 0, 0);
  return combined;
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

export async function upsertScheduledEvent(input: UpsertScheduledEventInput): Promise<void> {
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

export async function syncEventToSchedule(event: EventScheduleSource): Promise<void> {
  const ministryId = event.church?.ministryAdminId ?? event.createdById ?? event.churchId;
  const startAt = combineDateAndTime(event.date, event.time);
  const endAt = withMinimumEnd(startAt, combineDateAndTime(event.endDate, event.time), 60);

  await upsertScheduledEvent({
    ministryId,
    churchId: event.churchId,
    title: event.title,
    description: event.description,
    type: event.type || 'event',
    sourceModule: 'events',
    sourceId: event.id,
    startAt,
    endAt,
    locationText: event.location,
    status: event.status === 'upcoming' ? 'scheduled' : event.status,
    approvalStatus: 'not_required',
    organizerUserId: event.createdById,
    createdById: event.createdById,
    recurrenceRuleId: event.recurrenceRuleId,
  });
}

export async function syncCellMeetingToSchedule(meeting: CellMeetingScheduleSource, createdById?: string | null): Promise<void> {
  const ministryId = meeting.cell.church?.ministryAdminId ?? createdById ?? meeting.cell.churchId;
  const title = meeting.topic ? `${meeting.cell.name}: ${meeting.topic}` : `${meeting.cell.name} Meeting`;
  const startAt = combineDateAndTime(meeting.date, meeting.time || meeting.cell.meetingTime);
  const endAt = new Date(startAt.getTime() + 120 * 60 * 1000);

  await upsertScheduledEvent({
    ministryId,
    churchId: meeting.cell.churchId,
    title,
    description: meeting.notes,
    type: 'cell_meeting',
    sourceModule: 'cell_meetings',
    sourceId: meeting.id,
    startAt,
    endAt,
    locationText: meeting.cell.zone,
    status: 'scheduled',
    approvalStatus: 'not_required',
    organizerUserId: createdById ?? null,
    createdById: createdById ?? null,
    recurrenceRuleId: meeting.recurrenceRuleId,
  });
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
    status: 'scheduled',
    approvalStatus: 'not_required',
    organizerUserId: communication.authorId,
    createdById: communication.authorId,
    recurrenceRuleId: communication.recurrenceRuleId,
  });
}
