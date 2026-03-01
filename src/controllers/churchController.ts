import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { getAccessibleChurchIds } from '../lib/churchScope';

export async function getChurches(req: Request, res: Response): Promise<void> {
  const role = req.user?.role ?? 'member';
  const userId = req.user?.userId;
  const churchId = req.user?.churchId;

  let churchIds: string[] = [];

  if (role === 'national_admin' && userId) {
    // National admin sees churches they own
    const churches = await prisma.church.findMany({
      where: { nationalAdminId: userId },
      select: { id: true }
    });
    churchIds = churches.map(c => c.id);
  } else {
    // Other roles use existing scope logic
    churchIds = await getAccessibleChurchIds(
      role,
      churchId ?? '',
      req.user?.districts,
      req.user?.traditionalAuthorities,
      req.user?.regions,
      userId
    );
  }

  const allChurches = await prisma.church.findMany({
    where: { id: { in: churchIds } },
    include: { _count: { select: { members: true, users: true } } },
    orderBy: { name: 'asc' },
  });

  res.json({ success: true, data: allChurches });
}

export async function getChurch(req: Request, res: Response): Promise<void> {
  const church = await prisma.church.findUnique({
    where: { id: String(req.params.id) },
    include: {
      _count: { select: { members: true, users: true, events: true } },
      children: true,
    },
  });
  if (!church) { res.status(404).json({ success: false, message: 'Church not found' }); return; }
  res.json({ success: true, data: church });
}

// ─── POST /api/churches ───────────────────────────────────────────────────────

const churchSchema = z.object({
  name: z.string().min(2, 'Name required'),
  location: z.string().optional(),
  country: z.string().default('Malawi'),
  region: z.string().min(1, 'Region is required'),
  district: z.string().min(1, 'District is required'),
  traditionalAuthority: z.string().min(1, 'Traditional Authority is required'),
  village: z.string().optional(),
  address: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  website: z.string().optional(),
  yearFounded: z.coerce.number().int().positive().optional(),
  parentId: z.string().optional(),
});

export async function createChurch(req: Request, res: Response): Promise<void> {
  const adminUserId = req.user?.userId;
  const role = req.user?.role ?? 'member';
  if (!adminUserId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const parsed = churchSchema.safeParse(req.body);
  if (!parsed.success) { 
    res.status(400).json({ success: false, message: parsed.error.errors[0].message }); 
    return; 
  }

  // Get the national admin user and their package
  const adminUser = await prisma.user.findUnique({
    where: { id: adminUserId },
    include: { 
      package: true,
      ownedChurches: true 
    }
  });

  if (!adminUser) {
    res.status(404).json({ success: false, message: 'User not found' });
    return;
  }

  if (role !== 'national_admin') {
    res.status(403).json({ success: false, message: 'Only national admins can create churches' });
    return;
  }

  if (!adminUser.package) {
    res.status(400).json({ success: false, message: 'No package assigned to your account' });
    return;
  }

  // Check if package allows creating more churches
  const currentChurchCount = adminUser.ownedChurches.length;
  if (currentChurchCount >= adminUser.package.maxChurches) {
    res.status(403).json({ 
      success: false, 
      message: `Your ${adminUser.package.displayName} package allows maximum ${adminUser.package.maxChurches} churches. Upgrade your package to create more churches.` 
    });
    return;
  }

  const { name, country, region, district, traditionalAuthority, village, address, phone, email, website, yearFounded, parentId } = parsed.data;

  // Build location string
  const locParts = [traditionalAuthority, district, region].filter(Boolean);
  const location = parsed.data.location || locParts.join(', ') || 'Malawi';

  const branchCode = `${name.replace(/\s+/g, '').substring(0, 6).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;

  const church = await prisma.church.create({
    data: {
      name, location, country,
      region, district, traditionalAuthority, village,
      address, phone, email: email || undefined, website, yearFounded,
      parentId: parentId || undefined,
      branchCode,
      nationalAdminId: adminUserId, // Link to national admin
    },
    include: { _count: { select: { members: true, users: true } } },
  });

  res.status(201).json({ success: true, data: church });
}

// ─── PUT /api/churches/:id ────────────────────────────────────────────────────

const updateChurchSchema = z.object({
  name: z.string().min(2, 'Name required').optional(),
  location: z.string().optional(),
  country: z.string().optional(),
  region: z.string().min(1, 'Region is required').optional(),
  district: z.string().min(1, 'District is required').optional(),
  traditionalAuthority: z.string().min(1, 'Traditional Authority is required').optional(),
  village: z.string().optional(),
  address: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  website: z.string().optional(),
  yearFounded: z.coerce.number().int().positive().optional(),
  parentId: z.string().optional(),
});

export async function updateChurch(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const role = req.user?.role ?? 'member';
  
  if (!userId) { 
    res.status(401).json({ success: false, message: 'Not authenticated' }); 
    return; 
  }

  const church = await prisma.church.findUnique({ where: { id: String(req.params.id) } });
  if (!church) { 
    res.status(404).json({ success: false, message: 'Church not found' }); 
    return; 
  }

  // Check access permissions
  let hasAccess = false;
  
  if (role === 'national_admin') {
    // National admin can update churches they own
    hasAccess = church.nationalAdminId === userId;
  } else {
    // Other roles use the existing scope logic
    const churchId = req.user?.churchId;
    if (!churchId) {
      res.status(401).json({ success: false, message: 'Church ID required for this role' });
      return;
    }
    
    const churchIds = await getAccessibleChurchIds(
      role,
      churchId,
      req.user?.districts,
      req.user?.traditionalAuthorities,
      req.user?.regions,
      userId
    );
    hasAccess = churchIds.includes(church.id);
  }
  
  if (!hasAccess) { 
    res.status(403).json({ success: false, message: 'Access denied' }); 
    return; 
  }

  const parsed = updateChurchSchema.safeParse(req.body);
  if (!parsed.success) { 
    res.status(400).json({ success: false, message: parsed.error.errors[0].message }); 
    return; 
  }

  const updateData: Record<string, unknown> = { ...parsed.data };
  if (updateData.email === '') updateData.email = null;

  const updated = await prisma.church.update({
    where: { id: String(req.params.id) },
    data: updateData,
    include: { _count: { select: { members: true, users: true } } },
  });

  res.json({ success: true, data: updated });
}

// ─── DELETE /api/churches/:id ─────────────────────────────────────────────────

export async function deleteChurch(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const role = req.user?.role ?? 'member';
  
  if (!userId) { 
    res.status(401).json({ success: false, message: 'Not authenticated' }); 
    return; 
  }

  const church = await prisma.church.findUnique({ where: { id: String(req.params.id) } });
  if (!church) { 
    res.status(404).json({ success: false, message: 'Church not found' }); 
    return; 
  }

  // Check access permissions
  let hasAccess = false;
  
  if (role === 'national_admin') {
    // National admin can delete churches they own
    hasAccess = church.nationalAdminId === userId;
  } else {
    // Other roles use the existing scope logic
    const churchId = req.user?.churchId;
    if (!churchId) {
      res.status(401).json({ success: false, message: 'Church ID required for this role' });
      return;
    }
    
    const churchIds = await getAccessibleChurchIds(
      role,
      churchId,
      req.user?.districts,
      req.user?.traditionalAuthorities,
      req.user?.regions,
      userId
    );
    hasAccess = churchIds.includes(church.id);
  }
  
  if (!hasAccess) { 
    res.status(403).json({ success: false, message: 'Access denied' }); 
    return; 
  }

  // Delete related records first to avoid foreign key constraint violations
  await prisma.$transaction(async (tx) => {
    // Delete all related records
    await tx.member.deleteMany({ where: { churchId: church.id } });
    await tx.event.deleteMany({ where: { churchId: church.id } });
    await tx.donation.deleteMany({ where: { churchId: church.id } });
    await tx.attendance.deleteMany({ where: { churchId: church.id } });
    await tx.meeting.deleteMany({ where: { churchId: church.id } });
    await tx.announcement.deleteMany({ where: { churchId: church.id } });
    await tx.resource.deleteMany({ where: { churchId: church.id } });
    await tx.payment.deleteMany({ where: { churchId: church.id } });
    
    // Update users to remove church association (but don't delete the users)
    await tx.user.updateMany({ 
      where: { churchId: church.id }, 
      data: { churchId: null } 
    });
    
    // Finally delete the church
    await tx.church.delete({ where: { id: church.id } });
  });
  
  res.json({ success: true, message: 'Church deleted successfully' });
}
