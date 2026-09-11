import { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import path from 'path';
import fs from 'fs';
import prisma from '../lib/prisma';
import { getAccessibleChurchIds } from '../lib/churchScope';
import { assertScheduleAccess, hasRecurringRule } from '../lib/scheduleAccess';
import {
  deleteScheduledEventForSource,
  getRecurrenceRulesById,
  parseRecurrenceRuleForApi,
  saveRecurrenceRule,
  syncAnnouncementToSchedule,
} from '../services/schedulerService';
import { isValidTimeZone, resolveTimeZone } from '../lib/timezone';

const recurrenceRuleSchema = z.object({
  frequency: z.enum(['none', 'daily', 'weekly', 'monthly', 'yearly']).optional().nullable(),
  interval: z.coerce.number().int().min(1).max(365).optional().nullable(),
  daysOfWeek: z.array(z.string()).optional().nullable(),
  dayOfMonth: z.coerce.number().int().min(1).max(31).optional().nullable(),
  monthOfYear: z.coerce.number().int().min(1).max(12).optional().nullable(),
  startsAt: z.string().datetime().optional().nullable(),
  endsAt: z.string().datetime().optional().nullable(),
  count: z.coerce.number().int().min(1).max(1000).optional().nullable(),
}).optional().nullable();

const schema = z.object({
  title: z.string().min(1, 'Title required'),
  content: z.string().min(1, 'Content required'),
  type: z.enum(['announcement', 'prayer_request', 'newsletter']).default('announcement'),
  priority: z.enum(['normal', 'urgent']).default('normal'),
  churchId: z.string().min(1, 'Church ID required'),
  attachments: z.string().optional(),
  deliveryMode: z.enum(['now', 'scheduled']).default('now').optional(),
  scheduledAt: z.string().datetime().optional().nullable(),
  timezone: z.string().refine(isValidTimeZone, 'Invalid IANA timezone').optional(),
  recurrenceRule: recurrenceRuleSchema,
});

function deleteUploadedFile(url: string) {
  if (url.startsWith('/uploads/')) {
    const p = path.join(process.cwd(), url.replace(/^\//,''));
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

function parseAttachments(json: unknown): string[] {
  if (!json) return [];
  try { return JSON.parse(json as string) as string[]; } catch { return []; }
}

async function attachAnnouncementSchedules<T extends Array<{ id: string }>>(announcements: T) {
  const ids = announcements.map(item => item.id);
  if (ids.length === 0) return announcements.map(item => ({ ...item, scheduledEvent: null }));

  const rows = await prisma.$queryRaw<Array<{
    sourceId: string;
    startAt: Date;
    endAt: Date;
    status: string;
    timezone: string;
    recurrenceRuleId: string | null;
  }>>`
    SELECT sourceId, startAt, endAt, status, timezone, recurrenceRuleId
    FROM scheduled_events
    WHERE sourceModule = 'announcements' AND sourceId IN (${Prisma.join(ids)})
  `;
  const recurrenceRulesById = await getRecurrenceRulesById(rows.map(row => row.recurrenceRuleId).filter((id): id is string => Boolean(id)));
  const schedulesBySourceId = new Map(rows.map(row => [row.sourceId, row]));

  return announcements.map(item => {
    const schedule = schedulesBySourceId.get(item.id);
    return {
      ...item,
      scheduledEvent: schedule
        ? {
          startAt: schedule.startAt,
          endAt: schedule.endAt,
          status: schedule.status,
          timezone: schedule.timezone,
          recurrenceRuleId: schedule.recurrenceRuleId,
          recurrenceRule: schedule.recurrenceRuleId ? parseRecurrenceRuleForApi(recurrenceRulesById.get(schedule.recurrenceRuleId)) : null,
        }
        : null,
    };
  });
}

export async function getAnnouncements(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const churchId = req.user?.churchId;
  const roleName = req.user?.role ?? 'member';
  const filterChurchId = req.query.churchId as string | undefined;
  
  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const churchIds = await getAccessibleChurchIds(
    roleName,
    churchId,
    req.user?.districts,
    req.user?.traditionalAuthorities,
    req.user?.regions,
    userId,
  );
  
  const whereClause: any = { churchId: { in: churchIds } };
  
  // Apply church filter if provided
  if (filterChurchId) {
    // Verify user has access to this church
    if (!churchIds.includes(filterChurchId)) {
      res.status(403).json({ success: false, message: 'Access denied to this church' });
      return;
    }
    whereClause.churchId = filterChurchId;
  }
  
  const items = await prisma.announcement.findMany({
    where: whereClause,
    include: {
      church: {
        select: {
          id: true,
          name: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
  const itemsWithSchedules = await attachAnnouncementSchedules(items);
  const visibleItems = roleName === 'member'
    ? itemsWithSchedules.filter(item => !item.scheduledEvent || item.scheduledEvent.status === 'completed')
    : itemsWithSchedules;
  res.json({ success: true, data: visibleItems });
}

export async function createAnnouncement(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const churchId = req.user?.churchId;
  const roleName = req.user?.role;
  
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const { churchId: targetChurchId, deliveryMode, scheduledAt, recurrenceRule, timezone: requestedTimezone, ...announcementData } = parsed.data;
  const mode = deliveryMode ?? 'now';

  if (mode !== 'scheduled' && hasRecurringRule(recurrenceRule)) {
    res.status(400).json({ success: false, message: 'Recurrence is only available when delivery mode is Schedule.' });
    return;
  }

  if (mode === 'scheduled') {
    if (!scheduledAt) {
      res.status(400).json({ success: false, message: 'Scheduled date and time required' });
      return;
    }
    const scheduleAccess = await assertScheduleAccess(req, recurrenceRule ?? null, 'create');
    if (!scheduleAccess.allowed) {
      res.status(403).json({ success: false, message: scheduleAccess.message });
      return;
    }
  }

  // Verify user has access to this church
  const accessibleChurchIds = await getAccessibleChurchIds(
    roleName!,
    churchId,
    req.user?.districts,
    req.user?.traditionalAuthorities,
    req.user?.regions,
    userId
  );

  if (!accessibleChurchIds.includes(targetChurchId)) {
    res.status(403).json({ success: false, message: 'Access denied to this church' });
    return;
  }
  const timezone = await resolveTimeZone({ req, explicit: requestedTimezone, churchId: targetChurchId });

  const item = await prisma.announcement.create({
    data: {
      ...announcementData,
      churchId: targetChurchId,
      createdById: userId!,
    },
    include: { church: { select: { ministryAdminId: true } } },
  });

  const startAt = mode === 'scheduled' ? new Date(scheduledAt!) : new Date();
  const recurrenceRuleId = mode === 'scheduled'
    ? await saveRecurrenceRule(recurrenceRule ?? null, startAt)
    : null;
  await syncAnnouncementToSchedule({
    ...item,
    scheduledAt: startAt,
    recurrenceRuleId,
    timezone,
  });

  const [itemWithSchedule] = await attachAnnouncementSchedules([item]);
  res.status(201).json({ success: true, data: itemWithSchedule });
}

export async function updateAnnouncement(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const churchId = req.user?.churchId;
  const roleName = req.user?.role;
  const id = String(req.params.id);

  const item = await prisma.announcement.findUnique({ 
    where: { id },
    include: { church: true }
  });
  if (!item) {
    res.status(404).json({ success: false, message: 'Not found' });
    return;
  }
  
  // Verify user has access to this church
  const accessibleChurchIds = await getAccessibleChurchIds(
    roleName!,
    churchId,
    req.user?.districts,
    req.user?.traditionalAuthorities,
    req.user?.regions,
    userId
  );

  if (!accessibleChurchIds.includes(item.churchId)) {
    res.status(403).json({ success: false, message: 'Access denied' });
    return;
  }
  
  const parsed = schema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const { deliveryMode, scheduledAt, recurrenceRule, timezone: requestedTimezone, ...announcementData } = parsed.data;
  const mode = deliveryMode ?? undefined;

  if (mode !== 'scheduled' && hasRecurringRule(recurrenceRule)) {
    res.status(400).json({ success: false, message: 'Recurrence is only available when delivery mode is Schedule.' });
    return;
  }
  const existingTimezoneRows = await prisma.$queryRaw<Array<{ timezone: string }>>`
    SELECT timezone FROM scheduled_events
    WHERE sourceModule = 'announcements' AND sourceId = ${id} LIMIT 1
  `;
  const timezone = requestedTimezone
    ? await resolveTimeZone({ req, explicit: requestedTimezone, churchId: item.churchId })
    : existingTimezoneRows[0]?.timezone ?? await resolveTimeZone({ req, churchId: item.churchId });

  const updated = await prisma.announcement.update({
    where: { id },
    data: announcementData,
    include: { church: { select: { ministryAdminId: true } } },
  });

  const existingSchedule = await prisma.$queryRaw<Array<{ recurrenceRuleId: string | null }>>`
    SELECT recurrenceRuleId
    FROM scheduled_events
    WHERE sourceModule = 'announcements' AND sourceId = ${id}
    LIMIT 1
  `;

  if (mode === 'scheduled') {
    if (!scheduledAt) {
      res.status(400).json({ success: false, message: 'Scheduled date and time required' });
      return;
    }
    const scheduleAction = existingSchedule.length > 0 ? 'update' : 'create';
    const scheduleAccess = await assertScheduleAccess(req, recurrenceRule ?? null, scheduleAction);
    if (!scheduleAccess.allowed) {
      res.status(403).json({ success: false, message: scheduleAccess.message });
      return;
    }

    const startAt = new Date(scheduledAt);
    const recurrenceRuleId = await saveRecurrenceRule(recurrenceRule ?? null, startAt, existingSchedule[0]?.recurrenceRuleId);
    await syncAnnouncementToSchedule({
      ...updated,
      scheduledAt: startAt,
      recurrenceRuleId,
      timezone,
    });
  } else if (mode === 'now') {
    if (existingSchedule.length > 0) {
      const scheduleAccess = await assertScheduleAccess(req, null, 'update');
      if (!scheduleAccess.allowed) {
        res.status(403).json({ success: false, message: scheduleAccess.message });
        return;
      }
    }
    await syncAnnouncementToSchedule({
      ...updated,
      scheduledAt: new Date(),
      recurrenceRuleId: null,
      timezone,
    });
  }

  const [updatedWithSchedule] = await attachAnnouncementSchedules([updated]);
  res.json({ success: true, data: updatedWithSchedule });
}

export async function deleteAnnouncement(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const churchId = req.user?.churchId;
  const roleName = req.user?.role;
  const id = String(req.params.id);

  const item = await prisma.announcement.findUnique({ 
    where: { id },
    include: { church: true }
  });
  if (!item) {
    res.status(404).json({ success: false, message: 'Not found' });
    return;
  }
  
  // Verify user has access to delete
  const accessibleChurchIds = await getAccessibleChurchIds(
    roleName!,
    churchId,
    req.user?.districts,
    req.user?.traditionalAuthorities,
    req.user?.regions,
    userId
  );

  if (!accessibleChurchIds.includes(item.churchId)) {
    res.status(403).json({ success: false, message: 'Access denied' });
    return;
  }

  // Delete all attached files
  for (const url of parseAttachments(item.attachments)) deleteUploadedFile(url);

  await deleteScheduledEventForSource('announcements', id);
  await prisma.announcement.delete({ where: { id } });
  res.json({ success: true, message: 'Deleted' });
}
