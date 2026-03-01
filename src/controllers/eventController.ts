import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { getAccessibleChurchIds } from '../lib/churchScope';

const eventSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional().default(''),
  date: z.string(),
  time: z.string(),
  location: z.string().min(1),
  type: z.enum(['service', 'meeting', 'conference', 'outreach', 'fellowship']),
  status: z.enum(['upcoming', 'ongoing', 'completed', 'cancelled']).optional().default('upcoming'),
  attendeeCount: z.number().optional().default(0),
  churchId: z.string().min(1, 'Church ID required'),
});

export async function getEvents(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const churchId = req.user?.churchId;
  const roleName = req.user?.role ?? 'member';
  
  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  let churchIds: string[] = [];

  if (roleName === 'national_admin') {
    // National admin sees events from their churches
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

  const events = await prisma.event.findMany({
    where: { churchId: { in: churchIds } },
    orderBy: { date: 'asc' },
  });
  res.json({ success: true, data: events });
}

export async function getEvent(req: Request, res: Response): Promise<void> {
  const event = await prisma.event.findUnique({ where: { id: String(req.params.id) } });
  if (!event) { res.status(404).json({ success: false, message: 'Event not found' }); return; }
  res.json({ success: true, data: event });
}

export async function createEvent(req: Request, res: Response): Promise<void> {
  const parsed = eventSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const event = await prisma.event.create({
    data: {
      ...parsed.data,
      date: new Date(parsed.data.date),
      createdById: req.user!.userId,
    },
  });
  res.status(201).json({ success: true, data: event });
}

export async function updateEvent(req: Request, res: Response): Promise<void> {
  const parsed = eventSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const event = await prisma.event.update({
    where: { id: String(req.params.id) },
    data: {
      ...parsed.data,
      date: parsed.data.date ? new Date(parsed.data.date) : undefined,
    },
  });
  res.json({ success: true, data: event });
}

export async function deleteEvent(req: Request, res: Response): Promise<void> {
  await prisma.event.delete({ where: { id: String(req.params.id) } });
  res.json({ success: true, message: 'Event deleted' });
}
