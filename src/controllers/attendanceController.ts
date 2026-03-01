import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { getAccessibleChurchIds } from '../lib/churchScope';

const schema = z.object({
  date: z.string().min(1, 'Date required'),
  totalAttendees: z.number().int().positive(),
  newVisitors: z.number().int().min(0).default(0),
  serviceType: z.string().default('Sunday Service'),
  notes: z.string().optional(),
  eventId: z.string().optional(),
  churchId: z.string().min(1, 'Church ID required'),
});

export async function getAttendance(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const churchId = req.user?.churchId;
  const roleName = req.user?.role ?? 'member';
  
  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  let churchIds: string[] = [];

  if (roleName === 'national_admin') {
    // National admin sees attendance from their churches
    const churches = await prisma.church.findMany({
      where: { nationalAdminId: userId },
      select: { id: true }
    });
    churchIds = churches.map(c => c.id);
  } else {
    // Other roles use existing scope logic
    if (!churchId) {
      res.status(400).json({ success: false, message: 'churchId required' });
      return;
    }
    churchIds = await getAccessibleChurchIds(roleName, churchId, req.user?.districts, req.user?.traditionalAuthorities, req.user?.regions, userId);
  }

  const records = await prisma.attendance.findMany({
    where: { churchId: { in: churchIds } },
    orderBy: { date: 'desc' },
    take: 50,
  });
  res.json({ success: true, data: records });
}

export async function createAttendance(req: Request, res: Response): Promise<void> {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const record = await prisma.attendance.create({
    data: {
      ...parsed.data,
      date: new Date(parsed.data.date),
    },
  });
  res.status(201).json({ success: true, data: record });
}

export async function deleteAttendance(req: Request, res: Response): Promise<void> {
  await prisma.attendance.delete({ where: { id: String(req.params.id) } });
  res.json({ success: true, message: 'Record deleted' });
}
