import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { getAccessibleChurchIds } from '../lib/churchScope';

const scheduledReminderSchema = z.object({
  churchId: z.string().min(1),
  campaignId: z.string().optional().nullable(),
  eventId: z.string().optional().nullable(),
  type: z.enum(['giving', 'pledge', 'event']),
  audience: z.enum(['all_members', 'active_pledges', 'overdue_pledges', 'not_given_this_month', 'event_members']),
  channelEmail: z.boolean().default(true),
  channelPush: z.boolean().default(true),
  title: z.string().min(1),
  message: z.string().min(1),
  scheduleKind: z.enum(['monthly_days', 'pledge_deadline']),
  scheduleDays: z.array(z.number().int().min(1).max(31)).optional(),
  deadlineOffsets: z.array(z.number().int().min(-365).max(365)).optional(),
  isActive: z.boolean().optional(),
});

async function getScopedChurchIds(req: Request): Promise<string[]> {
  return getAccessibleChurchIds(
    req.user?.role ?? 'member',
    req.user?.churchId,
    req.user?.districts,
    req.user?.traditionalAuthorities,
    req.user?.regions,
    req.user?.userId
  );
}

function parseJsonArray(value?: string | null): number[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : [];
  } catch {
    return [];
  }
}

function serializeScheduledReminder(reminder: any) {
  return {
    ...reminder,
    scheduleDays: parseJsonArray(reminder.scheduleDays),
    deadlineOffsets: parseJsonArray(reminder.deadlineOffsets),
  };
}

function serializeReminder(reminder: any) {
  const { age, years, ...safeReminder } = reminder;
  return safeReminder;
}

async function assertScheduledReminderAccess(req: Request, churchId: string): Promise<{ allowed: boolean; ministryAdminId?: string | null }> {
  if (req.user?.role === 'member') return { allowed: false };
  const scopedChurchIds = await getScopedChurchIds(req);
  if (!scopedChurchIds.includes(churchId)) return { allowed: false };
  const church = await prisma.church.findUnique({ where: { id: churchId }, select: { ministryAdminId: true } });
  return { allowed: true, ministryAdminId: church?.ministryAdminId ?? null };
}

export async function getReminders(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const churchId = req.user?.churchId;
  const roleName = req.user?.role ?? 'member';

  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const type = req.query.type as string | undefined;
  const days = parseInt(req.query.days as string) || 30;
  const filterChurchId = req.query.churchId as string | undefined;

  let whereClause: any = { daysUntil: { lte: days, gte: 0 } };

  // Apply type filter
  if (type) whereClause.type = type;

  // Apply church filter if provided
  if (filterChurchId) whereClause.churchId = filterChurchId;

  // Scope-based filtering (only if no specific church filter is applied)
  if (!filterChurchId) {
    if (roleName === 'member') {
      // Members see church-wide reminders for members in their own church.
      if (churchId) whereClause.churchId = churchId;
      else whereClause.userId = userId;
    } else if (roleName === 'ministry_admin') {
      // National admin sees reminders from their churches
      whereClause.ministryAdminId = userId;
    } else {
      // Other roles use churchScope
      const churchIds = await getAccessibleChurchIds(
        roleName,
        churchId,
        req.user?.districts,
        req.user?.traditionalAuthorities,
        req.user?.regions,
        userId
      );
      whereClause.churchId = { in: churchIds };
    }
  } else {
    // Verify user has access to the filtered church
    if (roleName === 'member') {
      // Members can only filter their own church
      if (filterChurchId !== churchId) {
        res.status(403).json({ success: false, message: 'Access denied to this church' });
        return;
      }
    } else if (roleName === 'ministry_admin') {
      // Verify church belongs to this national admin
      const church = await prisma.church.findFirst({
        where: { id: filterChurchId, ministryAdminId: userId },
      });
      if (!church) {
        res.status(403).json({ success: false, message: 'Access denied to this church' });
        return;
      }
      whereClause.ministryAdminId = userId;
    } else {
      // Verify church is in accessible scope
      const churchIds = await getAccessibleChurchIds(
        roleName,
        churchId,
        req.user?.districts,
        req.user?.traditionalAuthorities,
        req.user?.regions,
        userId
      );
      if (!churchIds.includes(filterChurchId)) {
        res.status(403).json({ success: false, message: 'Access denied to this church' });
        return;
      }
    }
  }

  const reminders = await prisma.reminderCache.findMany({
    where: whereClause,
    include: {
      user: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          avatar: true,
        },
      },
      church: {
        select: {
          id: true,
          name: true,
        },
      },
      event: {
        select: {
          id: true,
          title: true,
          date: true,
          location: true,
          contactEmail: true,
          contactPhone: true,
          imageUrl: true,
        },
      },
    },
    orderBy: { daysUntil: 'asc' },
    take: 100,
  });

  // Group event reminders by eventId to avoid duplicates and format data
  const uniqueReminders: any[] = [];
  const seenEvents = new Set<string>();

  for (const reminder of reminders) {
    if (reminder.type === 'event' && reminder.eventId) {
      if (!seenEvents.has(reminder.eventId)) {
        seenEvents.add(reminder.eventId);
        // For event reminders, exclude user object and ministryAdminId
        const { user, ministryAdminId, ...eventReminderData } = reminder;
        uniqueReminders.push(serializeReminder(eventReminderData));
      }
    } else {
      // For non-event reminders, always include the full reminder with user object
      uniqueReminders.push(serializeReminder(reminder));
    }
  }

  // Calculate stats
  const stats = {
    total: uniqueReminders.length,
    birthdays: uniqueReminders.filter(r => r.type === 'birthday').length,
    weddings: uniqueReminders.filter(r => r.type === 'wedding').length,
    memberAnniversaries: uniqueReminders.filter(r => r.type === 'member_anniversary').length,
    churchFounded: uniqueReminders.filter(r => r.type === 'church_founded').length,
    events: uniqueReminders.filter(r => r.type === 'event').length,
  };

  res.json({ success: true, data: uniqueReminders, stats });
}

export async function getTodayReminders(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const churchId = req.user?.churchId;
  const roleName = req.user?.role ?? 'member';

  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  let whereClause: any = { daysUntil: 0 };

  // Scope-based filtering
  if (roleName === 'member') {
    if (churchId) whereClause.churchId = churchId;
    else whereClause.userId = userId;
  } else if (roleName === 'ministry_admin') {
    whereClause.ministryAdminId = userId;
  } else {
    const churchIds = await getAccessibleChurchIds(
      roleName,
      churchId,
      req.user?.districts,
      req.user?.traditionalAuthorities,
      req.user?.regions,
      userId
    );
    whereClause.churchId = { in: churchIds };
  }

  const reminders = await prisma.reminderCache.findMany({
    where: whereClause,
    include: {
      user: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          avatar: true,
        },
      },
      church: {
        select: {
          id: true,
          name: true,
        },
      },
    },
    orderBy: { type: 'asc' },
  });

  res.json({ success: true, data: reminders.map(serializeReminder) });
}

export async function getScheduledReminders(req: Request, res: Response): Promise<void> {
  if (req.user?.role === 'member') {
    res.status(403).json({ success: false, message: 'Members cannot manage scheduled reminders' });
    return;
  }

  const churchIds = await getScopedChurchIds(req);
  const filterChurchId = req.query.churchId as string | undefined;
  if (filterChurchId && !churchIds.includes(filterChurchId)) {
    res.status(403).json({ success: false, message: 'Access denied to this church' });
    return;
  }

  const reminders = await prisma.scheduledReminder.findMany({
    where: {
      churchId: filterChurchId ? filterChurchId : { in: churchIds },
    },
    include: {
      _count: { select: { logs: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  res.json({ success: true, data: reminders.map(serializeScheduledReminder) });
}

export async function createScheduledReminder(req: Request, res: Response): Promise<void> {
  if (req.user?.role === 'member') {
    res.status(403).json({ success: false, message: 'Members cannot manage scheduled reminders' });
    return;
  }

  const parsed = scheduledReminderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  if (!parsed.data.channelEmail && !parsed.data.channelPush) {
    res.status(400).json({ success: false, message: 'Select at least one delivery channel' });
    return;
  }
  if (parsed.data.scheduleKind === 'monthly_days' && !parsed.data.scheduleDays?.length) {
    res.status(400).json({ success: false, message: 'Select at least one monthly day' });
    return;
  }
  if (parsed.data.scheduleKind === 'pledge_deadline' && !parsed.data.deadlineOffsets?.length) {
    res.status(400).json({ success: false, message: 'Select at least one pledge deadline offset' });
    return;
  }

  const access = await assertScheduledReminderAccess(req, parsed.data.churchId);
  if (!access.allowed) {
    res.status(403).json({ success: false, message: 'Access denied to this church' });
    return;
  }

  if (parsed.data.campaignId) {
    const campaign = await prisma.givingCampaign.findFirst({
      where: { id: parsed.data.campaignId, churchId: parsed.data.churchId },
      select: { id: true },
    });
    if (!campaign) {
      res.status(400).json({ success: false, message: 'Campaign must belong to the selected church' });
      return;
    }
  }
  if (parsed.data.eventId) {
    const event = await prisma.event.findFirst({
      where: { id: parsed.data.eventId, churchId: parsed.data.churchId },
      select: { id: true },
    });
    if (!event) {
      res.status(400).json({ success: false, message: 'Event must belong to the selected church' });
      return;
    }
  }

  const reminder = await prisma.scheduledReminder.create({
    data: {
      ministryAdminId: access.ministryAdminId,
      churchId: parsed.data.churchId,
      campaignId: parsed.data.campaignId || null,
      eventId: parsed.data.eventId || null,
      type: parsed.data.type,
      audience: parsed.data.audience,
      channelEmail: parsed.data.channelEmail,
      channelPush: parsed.data.channelPush,
      title: parsed.data.title,
      message: parsed.data.message,
      scheduleKind: parsed.data.scheduleKind,
      scheduleDays: parsed.data.scheduleDays ? JSON.stringify(parsed.data.scheduleDays) : null,
      deadlineOffsets: parsed.data.deadlineOffsets ? JSON.stringify(parsed.data.deadlineOffsets) : null,
      isActive: parsed.data.isActive ?? true,
      createdById: req.user?.userId,
    } as any,
    include: { _count: { select: { logs: true } } },
  });

  res.status(201).json({ success: true, data: serializeScheduledReminder(reminder) });
}

export async function updateScheduledReminder(req: Request, res: Response): Promise<void> {
  if (req.user?.role === 'member') {
    res.status(403).json({ success: false, message: 'Members cannot manage scheduled reminders' });
    return;
  }

  const existing = await prisma.scheduledReminder.findUnique({ where: { id: String(req.params.id) } });
  if (!existing) {
    res.status(404).json({ success: false, message: 'Scheduled reminder not found' });
    return;
  }
  const access = await assertScheduledReminderAccess(req, existing.churchId);
  if (!access.allowed) {
    res.status(403).json({ success: false, message: 'Access denied' });
    return;
  }

  const parsed = scheduledReminderSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const updated = await prisma.scheduledReminder.update({
    where: { id: existing.id },
    data: {
      campaignId: parsed.data.campaignId === undefined ? undefined : parsed.data.campaignId || null,
      eventId: parsed.data.eventId === undefined ? undefined : parsed.data.eventId || null,
      type: parsed.data.type,
      audience: parsed.data.audience,
      channelEmail: parsed.data.channelEmail,
      channelPush: parsed.data.channelPush,
      title: parsed.data.title,
      message: parsed.data.message,
      scheduleKind: parsed.data.scheduleKind,
      scheduleDays: parsed.data.scheduleDays === undefined ? undefined : JSON.stringify(parsed.data.scheduleDays),
      deadlineOffsets: parsed.data.deadlineOffsets === undefined ? undefined : JSON.stringify(parsed.data.deadlineOffsets),
      isActive: parsed.data.isActive,
    } as any,
    include: { _count: { select: { logs: true } } },
  });

  res.json({ success: true, data: serializeScheduledReminder(updated) });
}

export async function deleteScheduledReminder(req: Request, res: Response): Promise<void> {
  if (req.user?.role === 'member') {
    res.status(403).json({ success: false, message: 'Members cannot manage scheduled reminders' });
    return;
  }

  const existing = await prisma.scheduledReminder.findUnique({ where: { id: String(req.params.id) } });
  if (!existing) {
    res.status(404).json({ success: false, message: 'Scheduled reminder not found' });
    return;
  }
  const access = await assertScheduledReminderAccess(req, existing.churchId);
  if (!access.allowed) {
    res.status(403).json({ success: false, message: 'Access denied' });
    return;
  }

  await prisma.scheduledReminder.delete({ where: { id: existing.id } });
  res.json({ success: true, message: 'Scheduled reminder deleted' });
}

export async function getScheduledReminderLogs(req: Request, res: Response): Promise<void> {
  if (req.user?.role === 'member') {
    res.status(403).json({ success: false, message: 'Members cannot view scheduled reminder logs' });
    return;
  }

  const churchIds = await getScopedChurchIds(req);
  const page = Math.max(parseInt(String(req.query.page ?? '1'), 10) || 1, 1);
  const limit = Math.min(parseInt(String(req.query.limit ?? '25'), 10) || 25, 100);
  const skip = (page - 1) * limit;
  const status = typeof req.query.status === 'string' && req.query.status !== 'all' ? req.query.status : undefined;
  const channel = typeof req.query.channel === 'string' && req.query.channel !== 'all' ? req.query.channel : undefined;
  const reminderId = typeof req.query.reminderId === 'string' && req.query.reminderId !== 'all' ? req.query.reminderId : undefined;
  const startDate = typeof req.query.startDate === 'string' ? req.query.startDate : undefined;
  const endDate = typeof req.query.endDate === 'string' ? req.query.endDate : undefined;

  const scheduledFor: any = {};
  if (startDate) scheduledFor.gte = new Date(startDate);
  if (endDate) {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    scheduledFor.lte = end;
  }

  const where: any = {
    reminder: { churchId: { in: churchIds } },
    ...(status ? { status } : {}),
    ...(channel ? { channel } : {}),
    ...(reminderId ? { reminderId } : {}),
    ...(Object.keys(scheduledFor).length ? { scheduledFor } : {}),
  };

  const [logs, total] = await Promise.all([
    prisma.scheduledReminderLog.findMany({
      where,
      include: {
        reminder: true,
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.scheduledReminderLog.count({ where }),
  ]);

  res.json({
    success: true,
    data: logs.map(log => ({ ...log, reminder: serializeScheduledReminder(log.reminder) })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
}
