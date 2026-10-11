import { Request, Response } from 'express';
import prisma from '../lib/prisma';

const campaignSelect = { id: true, title: true, summary: true, message: true, category: true, priority: true, visibilityPolicy: true, actionLabel: true, actionUrl: true, sentAt: true, createdAt: true } as const;

export async function listSystemNotifications(req: Request, res: Response) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 20));
  const where: any = { userId: req.user!.userId, inAppStatus: 'sent', ...(req.query.unread === 'true' ? { readAt: null } : {}) };
  const [items, total] = await Promise.all([
    prisma.systemCampaignRecipient.findMany({ where, include: { campaign: { select: campaignSelect } }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    prisma.systemCampaignRecipient.count({ where }),
  ]);
  res.json({ success: true, data: items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
}

export async function getUnreadSystemNotificationCount(req: Request, res: Response) {
  const [unread, urgent] = await Promise.all([
    prisma.systemCampaignRecipient.count({ where: { userId: req.user!.userId, inAppStatus: 'sent', readAt: null } }),
    prisma.systemCampaignRecipient.count({ where: { userId: req.user!.userId, inAppStatus: 'sent', readAt: null, campaign: { priority: 'urgent' } } }),
  ]);
  res.json({ success: true, data: { unread, urgent } });
}

export async function markSystemNotificationRead(req: Request, res: Response) {
  const result = await prisma.systemCampaignRecipient.updateMany({ where: { id: String(req.params.id), userId: req.user!.userId }, data: { readAt: new Date() } });
  if (!result.count) return res.status(404).json({ success: false, message: 'Notification not found' });
  res.json({ success: true });
}

export async function markAllSystemNotificationsRead(req: Request, res: Response) {
  await prisma.systemCampaignRecipient.updateMany({ where: { userId: req.user!.userId, readAt: null }, data: { readAt: new Date() } });
  res.json({ success: true });
}
