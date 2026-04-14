import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { getAccessibleChurchIds } from '../lib/churchScope';

// ─── POST /api/announcements/:id/view ────────────────────────────────────────

export async function recordAnnouncementView(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  if (!userId) { res.status(401).json({ success: false, message: 'Not authenticated' }); return; }

  const announcementId = String(req.params.id);
  const exists = await prisma.announcement.findUnique({ where: { id: announcementId }, select: { id: true } });
  if (!exists) { res.status(404).json({ success: false, message: 'Not found' }); return; }

  await (prisma as any).announcementView.upsert({
    where: { announcementId_userId: { announcementId, userId } },
    create: { announcementId, userId },
    update: { viewedAt: new Date() },
  });

  res.json({ success: true });
}

// ─── GET /api/announcements/:id/view-stats ────────────────────────────────────

export async function getAnnouncementViewStats(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const roleName = req.user?.role ?? 'member';
  const churchId = req.user?.churchId;
  if (!userId) { res.status(401).json({ success: false, message: 'Not authenticated' }); return; }
  if (roleName === 'member') { res.status(403).json({ success: false, message: 'Access denied' }); return; }

  const announcementId = String(req.params.id);
  const announcement = await prisma.announcement.findUnique({ where: { id: announcementId }, select: { id: true, churchId: true } });
  if (!announcement) { res.status(404).json({ success: false, message: 'Not found' }); return; }

  const accessibleIds = await getAccessibleChurchIds(roleName, churchId, req.user?.districts, req.user?.traditionalAuthorities, req.user?.regions, userId);
  if (!accessibleIds.includes(announcement.churchId)) { res.status(403).json({ success: false, message: 'Access denied' }); return; }

  const count = await (prisma as any).announcementView.count({ where: { announcementId } });
  res.json({ success: true, data: { count } });
}

// ─── GET /api/announcements/:id/viewers ──────────────────────────────────────

export async function getAnnouncementViewers(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const roleName = req.user?.role ?? 'member';
  const churchId = req.user?.churchId;
  if (!userId) { res.status(401).json({ success: false, message: 'Not authenticated' }); return; }
  if (roleName === 'member') { res.status(403).json({ success: false, message: 'Access denied' }); return; }

  const announcementId = String(req.params.id);
  const search = (req.query.search as string)?.trim() || '';

  const announcement = await prisma.announcement.findUnique({ where: { id: announcementId }, select: { id: true, churchId: true } });
  if (!announcement) { res.status(404).json({ success: false, message: 'Not found' }); return; }

  const accessibleIds = await getAccessibleChurchIds(roleName, churchId, req.user?.districts, req.user?.traditionalAuthorities, req.user?.regions, userId);
  if (!accessibleIds.includes(announcement.churchId)) { res.status(403).json({ success: false, message: 'Access denied' }); return; }

  const views = await (prisma as any).announcementView.findMany({
    where: {
      announcementId,
      ...(search ? {
        user: {
          OR: [
            { firstName: { contains: search } },
            { lastName: { contains: search } },
            { email: { contains: search } },
          ],
        },
      } : {}),
    },
    select: { viewedAt: true, user: { select: { firstName: true, lastName: true, email: true } } },
    orderBy: { viewedAt: 'desc' },
  });

  res.json({ success: true, data: views.map((v: any) => ({ ...v.user, viewedAt: v.viewedAt })) });
}

// ─── POST /api/resources/:id/view ────────────────────────────────────────────

export async function recordResourceView(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  if (!userId) { res.status(401).json({ success: false, message: 'Not authenticated' }); return; }

  const resourceId = String(req.params.id);
  const exists = await prisma.resource.findUnique({ where: { id: resourceId }, select: { id: true } });
  if (!exists) { res.status(404).json({ success: false, message: 'Not found' }); return; }

  await (prisma as any).resourceView.upsert({
    where: { resourceId_userId: { resourceId, userId } },
    create: { resourceId, userId },
    update: { viewedAt: new Date() },
  });

  res.json({ success: true });
}

// ─── GET /api/resources/:id/view-stats ───────────────────────────────────────

export async function getResourceViewStats(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const roleName = req.user?.role ?? 'member';
  const churchId = req.user?.churchId;
  if (!userId) { res.status(401).json({ success: false, message: 'Not authenticated' }); return; }
  if (roleName === 'member') { res.status(403).json({ success: false, message: 'Access denied' }); return; }

  const resourceId = String(req.params.id);
  const resource = await prisma.resource.findUnique({ where: { id: resourceId }, select: { id: true, churchId: true } });
  if (!resource) { res.status(404).json({ success: false, message: 'Not found' }); return; }

  const accessibleIds = await getAccessibleChurchIds(roleName, churchId, req.user?.districts, req.user?.traditionalAuthorities, req.user?.regions, userId);
  if (!accessibleIds.includes(resource.churchId)) { res.status(403).json({ success: false, message: 'Access denied' }); return; }

  const count = await (prisma as any).resourceView.count({ where: { resourceId } });
  res.json({ success: true, data: { count } });
}

// ─── GET /api/resources/:id/viewers ──────────────────────────────────────────

export async function getResourceViewers(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const roleName = req.user?.role ?? 'member';
  const churchId = req.user?.churchId;
  if (!userId) { res.status(401).json({ success: false, message: 'Not authenticated' }); return; }
  if (roleName === 'member') { res.status(403).json({ success: false, message: 'Access denied' }); return; }

  const resourceId = String(req.params.id);
  const search = (req.query.search as string)?.trim() || '';

  const resource = await prisma.resource.findUnique({ where: { id: resourceId }, select: { id: true, churchId: true } });
  if (!resource) { res.status(404).json({ success: false, message: 'Not found' }); return; }

  const accessibleIds = await getAccessibleChurchIds(roleName, churchId, req.user?.districts, req.user?.traditionalAuthorities, req.user?.regions, userId);
  if (!accessibleIds.includes(resource.churchId)) { res.status(403).json({ success: false, message: 'Access denied' }); return; }

  const views = await (prisma as any).resourceView.findMany({
    where: {
      resourceId,
      ...(search ? {
        user: {
          OR: [
            { firstName: { contains: search } },
            { lastName: { contains: search } },
            { email: { contains: search } },
          ],
        },
      } : {}),
    },
    select: { viewedAt: true, user: { select: { firstName: true, lastName: true, email: true } } },
    orderBy: { viewedAt: 'desc' },
  });

  res.json({ success: true, data: views.map((v: any) => ({ ...v.user, viewedAt: v.viewedAt })) });
}
