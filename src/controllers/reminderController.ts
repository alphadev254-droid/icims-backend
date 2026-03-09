import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { getAccessibleChurchIds } from '../lib/churchScope';

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

  let whereClause: any = { daysUntil: { lte: days, gte: 0 } };

  // Apply type filter
  if (type) whereClause.type = type;

  // Scope-based filtering
  if (roleName === 'member') {
    // Members see only their own reminders
    whereClause.userId = userId;
  } else if (roleName === 'national_admin') {
    // National admin sees reminders from their churches
    whereClause.nationalAdminId = userId;
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
    orderBy: { daysUntil: 'asc' },
    take: 100,
  });

  // Calculate stats
  const stats = {
    total: reminders.length,
    birthdays: reminders.filter(r => r.type === 'birthday').length,
    weddings: reminders.filter(r => r.type === 'wedding').length,
    memberAnniversaries: reminders.filter(r => r.type === 'member_anniversary').length,
    churchFounded: reminders.filter(r => r.type === 'church_founded').length,
    events: reminders.filter(r => r.type === 'event').length,
  };

  res.json({ success: true, data: reminders, stats });
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
    whereClause.userId = userId;
  } else if (roleName === 'national_admin') {
    whereClause.nationalAdminId = userId;
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

  res.json({ success: true, data: reminders });
}
