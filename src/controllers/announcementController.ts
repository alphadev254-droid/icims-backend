import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { getAccessibleChurchIds } from '../lib/churchScope';

const schema = z.object({
  title: z.string().min(1, 'Title required'),
  content: z.string().min(1, 'Content required'),
  type: z.enum(['announcement', 'prayer_request', 'newsletter']).default('announcement'),
  priority: z.enum(['normal', 'urgent']).default('normal'),
  churchId: z.string().min(1, 'Church ID required'),
});

export async function getAnnouncements(req: Request, res: Response): Promise<void> {
  const churchId = req.user?.churchId;
  const roleName = req.user?.role ?? 'member';
  if (!churchId) { res.status(400).json({ success: false, message: 'churchId required' }); return; }

  const churchIds = await getAccessibleChurchIds(roleName, churchId, req.user?.districts, req.user?.traditionalAuthorities);
  const items = await prisma.announcement.findMany({
    where: { churchId: { in: churchIds } },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ success: true, data: items });
}

export async function createAnnouncement(req: Request, res: Response): Promise<void> {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const item = await prisma.announcement.create({
    data: {
      ...parsed.data,
      createdById: req.user!.userId,
    },
  });
  res.status(201).json({ success: true, data: item });
}

export async function updateAnnouncement(req: Request, res: Response): Promise<void> {
  const item = await prisma.announcement.findUnique({ where: { id: String(req.params.id) } });
  if (!item) { res.status(404).json({ success: false, message: 'Not found' }); return; }
  
  const parsed = schema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const updated = await prisma.announcement.update({
    where: { id: String(req.params.id) },
    data: parsed.data,
  });
  res.json({ success: true, data: updated });
}

export async function deleteAnnouncement(req: Request, res: Response): Promise<void> {
  const item = await prisma.announcement.findUnique({ where: { id: String(req.params.id) } });
  if (!item) { res.status(404).json({ success: false, message: 'Not found' }); return; }
  if (item.churchId !== req.user?.churchId) {
    res.status(403).json({ success: false, message: 'Forbidden' }); return;
  }
  await prisma.announcement.delete({ where: { id: String(req.params.id) } });
  res.json({ success: true, message: 'Deleted' });
}
