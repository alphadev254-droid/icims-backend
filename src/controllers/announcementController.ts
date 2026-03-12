import { Request, Response } from 'express';
import { z } from 'zod';
import path from 'path';
import fs from 'fs';
import prisma from '../lib/prisma';
import { getAccessibleChurchIds } from '../lib/churchScope';

const schema = z.object({
  title: z.string().min(1, 'Title required'),
  content: z.string().min(1, 'Content required'),
  type: z.enum(['announcement', 'prayer_request', 'newsletter']).default('announcement'),
  priority: z.enum(['normal', 'urgent']).default('normal'),
  churchId: z.string().min(1, 'Church ID required'),
  attachments: z.string().optional(),
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

export async function getAnnouncements(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const churchId = req.user?.churchId;
  const roleName = req.user?.role ?? 'member';
  const filterChurchId = req.query.churchId as string | undefined;
  
  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  // Parse JSON fields for role-based access
  let districts: string[] | undefined;
  let traditionalAuthorities: string[] | undefined;
  let regions: string[] | undefined;

  if (roleName === 'district_overseer') {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { districts: true } });
    districts = user?.districts ? JSON.parse(user.districts) : undefined;
  } else if (roleName === 'local_admin') {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { traditionalAuthorities: true } });
    traditionalAuthorities = user?.traditionalAuthorities ? JSON.parse(user.traditionalAuthorities) : undefined;
  } else if (roleName === 'regional_leader') {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { regions: true } });
    regions = user?.regions ? JSON.parse(user.regions) : undefined;
  }

  const churchIds = await getAccessibleChurchIds(roleName, churchId, districts, traditionalAuthorities, regions, userId);
  
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
  res.json({ success: true, data: items });
}

export async function createAnnouncement(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const roleName = req.user?.role;
  
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const { churchId } = parsed.data;

  // Verify user has access to this church
  let hasAccess = false;
  if (roleName === 'national_admin') {
    const church = await prisma.church.findUnique({ where: { id: churchId }, select: { nationalAdminId: true } });
    hasAccess = church?.nationalAdminId === userId;
  } else if (roleName === 'local_admin') {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { traditionalAuthorities: true } });
    const church = await prisma.church.findUnique({ where: { id: churchId }, select: { traditionalAuthority: true } });
    if (user?.traditionalAuthorities && church) {
      const tas = JSON.parse(user.traditionalAuthorities);
      hasAccess = tas.includes('__all__') || tas.includes(church.traditionalAuthority);
    }
  } else if (roleName === 'district_overseer') {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { districts: true } });
    const church = await prisma.church.findUnique({ where: { id: churchId }, select: { district: true } });
    if (user?.districts && church) {
      const districts = JSON.parse(user.districts);
      hasAccess = districts.includes('__all__') || districts.includes(church.district);
    }
  } else if (roleName === 'regional_leader') {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { regions: true } });
    const church = await prisma.church.findUnique({ where: { id: churchId }, select: { region: true } });
    if (user?.regions && church) {
      const regions = JSON.parse(user.regions);
      hasAccess = regions.includes('__all__') || regions.includes(church.region);
    }
  }

  if (!hasAccess) {
    res.status(403).json({ success: false, message: 'Access denied to this church' });
    return;
  }

  const item = await prisma.announcement.create({
    data: {
      ...parsed.data,
      createdById: userId!,
    },
  });
  res.status(201).json({ success: true, data: item });
}

export async function updateAnnouncement(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
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
  let hasAccess = false;
  if (roleName === 'national_admin') {
    hasAccess = item.church.nationalAdminId === userId;
  } else if (roleName === 'local_admin') {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { traditionalAuthorities: true } });
    if (user?.traditionalAuthorities) {
      const tas = JSON.parse(user.traditionalAuthorities);
      hasAccess = tas.includes('__all__') || tas.includes(item.church.traditionalAuthority);
    }
  } else if (roleName === 'district_overseer') {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { districts: true } });
    if (user?.districts) {
      const districts = JSON.parse(user.districts);
      hasAccess = districts.includes('__all__') || districts.includes(item.church.district);
    }
  } else if (roleName === 'regional_leader') {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { regions: true } });
    if (user?.regions) {
      const regions = JSON.parse(user.regions);
      hasAccess = regions.includes('__all__') || regions.includes(item.church.region);
    }
  }

  if (!hasAccess) {
    res.status(403).json({ success: false, message: 'Access denied' });
    return;
  }
  
  const parsed = schema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const updated = await prisma.announcement.update({
    where: { id },
    data: parsed.data,
  });
  res.json({ success: true, data: updated });
}

export async function deleteAnnouncement(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
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
  let hasAccess = false;
  if (roleName === 'national_admin') {
    hasAccess = item.church.nationalAdminId === userId;
  } else if (roleName === 'local_admin') {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { traditionalAuthorities: true } });
    if (user?.traditionalAuthorities) {
      const tas = JSON.parse(user.traditionalAuthorities);
      hasAccess = tas.includes('__all__') || tas.includes(item.church.traditionalAuthority);
    }
  } else if (roleName === 'district_overseer') {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { districts: true } });
    if (user?.districts) {
      const districts = JSON.parse(user.districts);
      hasAccess = districts.includes('__all__') || districts.includes(item.church.district);
    }
  } else if (roleName === 'regional_leader') {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { regions: true } });
    if (user?.regions) {
      const regions = JSON.parse(user.regions);
      hasAccess = regions.includes('__all__') || regions.includes(item.church.region);
    }
  }

  if (!hasAccess) {
    res.status(403).json({ success: false, message: 'Access denied' });
    return;
  }

  // Delete all attached files
  for (const url of parseAttachments(item.attachments)) deleteUploadedFile(url);

  await prisma.announcement.delete({ where: { id } });
  res.json({ success: true, message: 'Deleted' });
}
