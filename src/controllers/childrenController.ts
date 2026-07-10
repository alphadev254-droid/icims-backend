import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { getAccessibleChurchIds } from '../lib/churchScope';
import { hashPassword } from '../lib/password';

const childSchema = z.object({
  churchId: z.string().min(1),
  firstName: z.string().min(1, 'First name required'),
  lastName: z.string().min(1, 'Last name required'),
  dateOfBirth: z.string().optional().nullable(),
  age: z.number().int().min(0).max(120).optional().nullable(),
  gender: z.enum(['male', 'female', 'other']).optional().nullable(),
  phone: z.string().optional().nullable(),
  status: z.enum(['active', 'inactive']).optional(),
  notes: z.string().optional().nullable(),
  guardianId: z.string().optional(),
  relationship: z.string().optional(),
  isPrimary: z.boolean().optional(),
  canPickup: z.boolean().optional(),
  emergencyContact: z.boolean().optional(),
});

const childUpdateSchema = childSchema.omit({ guardianId: true }).partial();

const guardianSchema = z.object({
  guardianId: z.string().min(1),
  relationship: z.string().optional().default('guardian'),
  isPrimary: z.boolean().optional().default(false),
  canPickup: z.boolean().optional().default(true),
  emergencyContact: z.boolean().optional().default(false),
});

async function getScope(req: Request): Promise<string[]> {
  return getAccessibleChurchIds(
    req.user?.role ?? 'member',
    req.user?.churchId,
    req.user?.districts,
    req.user?.traditionalAuthorities,
    req.user?.regions,
    req.user?.userId
  );
}

function childInclude() {
  return {
    user: { select: { id: true, memberType: true, loginEnabled: true } },
    church: { select: { id: true, name: true } },
    guardians: {
      include: {
        guardian: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, churchId: true } },
      },
      orderBy: [{ isPrimary: 'desc' as const }, { createdAt: 'asc' as const }],
    },
  };
}

async function getMemberRoleId() {
  const role = await prisma.role.findUnique({ where: { name: 'member' }, select: { id: true } });
  if (!role) throw new Error('Member role not found');
  return role.id;
}

function childIdentityEmail(childId: string) {
  return `child.${childId}@children.icims.local`;
}

async function createChildIdentityUser(child: {
  id: string;
  churchId: string;
  firstName: string;
  lastName: string;
  phone?: string | null;
  gender?: string | null;
  dateOfBirth?: Date | null;
  status?: string | null;
}) {
  const [roleId, password] = await Promise.all([
    getMemberRoleId(),
    hashPassword(`child-${child.id}-${Date.now()}-${Math.random()}`),
  ]);
  return prisma.user.create({
    data: {
      email: childIdentityEmail(child.id),
      password,
      firstName: child.firstName,
      lastName: child.lastName,
      phone: child.phone || null,
      gender: child.gender || null,
      dateOfBirth: child.dateOfBirth || null,
      churchId: child.churchId,
      roleId,
      membershipType: 'member',
      memberType: 'child',
      loginEnabled: false,
      status: child.status || 'active',
    },
    select: { id: true },
  });
}

async function syncChildIdentityUser(child: any) {
  if (!child.userId) return;
  await prisma.user.update({
    where: { id: child.userId },
    data: {
      firstName: child.firstName,
      lastName: child.lastName,
      phone: child.phone || null,
      gender: child.gender || null,
      dateOfBirth: child.dateOfBirth || null,
      churchId: child.churchId,
      status: child.status || 'active',
      memberType: 'child',
      loginEnabled: false,
    },
  });
}

function calculateAgeFromDate(value?: Date | string | null): number | null {
  if (!value) return null;
  const dob = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(dob.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const hasBirthdayPassed =
    today.getMonth() > dob.getMonth() ||
    (today.getMonth() === dob.getMonth() && today.getDate() >= dob.getDate());
  if (!hasBirthdayPassed) age -= 1;
  return age >= 0 ? age : null;
}

function withComputedAge(child: any) {
  return {
    ...child,
    age: child.dateOfBirth ? calculateAgeFromDate(child.dateOfBirth) : child.age,
  };
}

function isMemberRequest(req: Request): boolean {
  return req.user?.role === 'member';
}

function isLinkedToCurrentMember(child: any, userId?: string): boolean {
  return !!userId && child.guardians?.some((link: any) => link.guardianId === userId);
}

async function ensureChildInScope(childId: string, churchIds: string[], req?: Request): Promise<any | false | null> {
  const child = await prisma.child.findUnique({ where: { id: childId }, include: childInclude() });
  if (!child) return null;
  if (!churchIds.includes(child.churchId)) return false;
  if (req && isMemberRequest(req) && !isLinkedToCurrentMember(child, req.user?.userId)) return false;
  return child;
}

async function ensureGuardianInChurch(guardianId: string, churchId: string): Promise<boolean> {
  const guardian = await prisma.user.findUnique({ where: { id: guardianId }, select: { id: true, churchId: true } });
  return !!guardian && guardian.churchId === churchId;
}

async function setPrimaryIfNeeded(childId: string, guardianId: string, isPrimary?: boolean) {
  if (!isPrimary) return;
  await prisma.childGuardian.updateMany({
    where: { childId, guardianId: { not: guardianId } },
    data: { isPrimary: false },
  });
}

export async function getChildren(req: Request, res: Response): Promise<void> {
  const churchIds = await getScope(req);
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const guardianId = typeof req.query.guardianId === 'string' ? req.query.guardianId : undefined;
  const unlinked = req.query.unlinked === 'true';
  const filterChurchId = typeof req.query.churchId === 'string' ? req.query.churchId : undefined;
  const page = Math.max(parseInt(String(req.query.page ?? '1'), 10) || 1, 1);
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
  const skip = (page - 1) * limit;

  let scopedChurchIds = churchIds;
  if (filterChurchId) {
    if (!churchIds.includes(filterChurchId)) {
      res.json({ success: true, data: [], pagination: { page, limit, total: 0, totalPages: 0 } });
      return;
    }
    scopedChurchIds = [filterChurchId];
  }

  const where: any = {
    churchId: { in: scopedChurchIds },
    ...(search ? {
      OR: [
        { firstName: { contains: search } },
        { lastName: { contains: search } },
        { phone: { contains: search } },
      ],
    } : {}),
    ...(guardianId ? { guardians: { some: { guardianId } } } : {}),
    ...(unlinked ? { guardians: { none: {} } } : {}),
  };

  if (isMemberRequest(req)) {
    where.guardians = { some: { guardianId: req.user?.userId } };
    delete where.guardianId;
    delete where.unlinked;
  }

  const [children, total] = await Promise.all([
    prisma.child.findMany({
      where,
      include: childInclude(),
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.child.count({ where }),
  ]);

  res.json({ success: true, data: children.map(withComputedAge), pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
}

export async function getChild(req: Request, res: Response): Promise<void> {
  const child = await ensureChildInScope(String(req.params.id), await getScope(req), req);
  if (!child) { res.status(404).json({ success: false, message: 'Child not found' }); return; }
  if (child === false) { res.status(403).json({ success: false, message: 'Access denied' }); return; }
  res.json({ success: true, data: withComputedAge(child) });
}

export async function createChild(req: Request, res: Response): Promise<void> {
  const parsed = childSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const scope = await getScope(req);
  const churchId = isMemberRequest(req) ? req.user?.churchId : parsed.data.churchId;
  if (!churchId || !scope.includes(churchId)) {
    res.status(403).json({ success: false, message: 'Access denied to this church' });
    return;
  }

  const guardianId = isMemberRequest(req) ? req.user?.userId : parsed.data.guardianId;
  if (guardianId && !(await ensureGuardianInChurch(guardianId, churchId))) {
    res.status(400).json({ success: false, message: 'Guardian must belong to the same church as the child' });
    return;
  }

  const child = await prisma.child.create({
    data: {
      churchId,
      firstName: parsed.data.firstName,
      lastName: parsed.data.lastName,
      dateOfBirth: parsed.data.dateOfBirth ? new Date(parsed.data.dateOfBirth) : null,
      age: parsed.data.dateOfBirth ? calculateAgeFromDate(parsed.data.dateOfBirth) : parsed.data.age ?? null,
      gender: parsed.data.gender ?? null,
      phone: parsed.data.phone || null,
      status: parsed.data.status ?? 'active',
      notes: parsed.data.notes || null,
      createdById: req.user?.userId,
      ...(guardianId ? {
        guardians: {
          create: {
            guardianId,
            relationship: parsed.data.relationship || 'guardian',
            isPrimary: parsed.data.isPrimary ?? true,
            canPickup: parsed.data.canPickup ?? true,
            emergencyContact: parsed.data.emergencyContact ?? false,
          },
        },
      } : {}),
    },
    include: childInclude(),
  });

  if (!child.userId) {
    const identity = await createChildIdentityUser(child);
    await prisma.child.update({
      where: { id: child.id },
      data: { userId: identity.id },
    });
    (child as any).userId = identity.id;
    (child as any).user = { id: identity.id, memberType: 'child', loginEnabled: false };
  }

  res.status(201).json({ success: true, data: withComputedAge(child) });
}

export async function updateChild(req: Request, res: Response): Promise<void> {
  const parsed = childUpdateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const scope = await getScope(req);
  const child = await ensureChildInScope(String(req.params.id), scope, req);
  if (!child) { res.status(404).json({ success: false, message: 'Child not found' }); return; }
  if (child === false) { res.status(403).json({ success: false, message: 'Access denied' }); return; }
  const nextChurchId = isMemberRequest(req) ? undefined : parsed.data.churchId;
  if (nextChurchId && !scope.includes(nextChurchId)) {
    res.status(403).json({ success: false, message: 'Access denied to this church' });
    return;
  }

  const updated = await prisma.child.update({
    where: { id: String(req.params.id) },
    data: {
      churchId: nextChurchId,
      firstName: parsed.data.firstName,
      lastName: parsed.data.lastName,
      dateOfBirth: parsed.data.dateOfBirth === undefined ? undefined : (parsed.data.dateOfBirth ? new Date(parsed.data.dateOfBirth) : null),
      age: parsed.data.dateOfBirth === undefined
        ? parsed.data.age === undefined ? undefined : parsed.data.age
        : parsed.data.dateOfBirth ? calculateAgeFromDate(parsed.data.dateOfBirth) : null,
      gender: parsed.data.gender === undefined ? undefined : parsed.data.gender,
      phone: parsed.data.phone === undefined ? undefined : (parsed.data.phone || null),
      status: parsed.data.status,
      notes: parsed.data.notes === undefined ? undefined : (parsed.data.notes || null),
    },
    include: childInclude(),
  });

  if (!updated.userId) {
    const identity = await createChildIdentityUser(updated);
    const relinked = await prisma.child.update({
      where: { id: updated.id },
      data: { userId: identity.id },
      include: childInclude(),
    });
    res.json({ success: true, data: withComputedAge(relinked) });
    return;
  }

  await syncChildIdentityUser(updated);

  res.json({ success: true, data: withComputedAge(updated) });
}

export async function deleteChild(req: Request, res: Response): Promise<void> {
  const child = await ensureChildInScope(String(req.params.id), await getScope(req), req);
  if (!child) { res.status(404).json({ success: false, message: 'Child not found' }); return; }
  if (child === false) { res.status(403).json({ success: false, message: 'Access denied' }); return; }

  await prisma.child.delete({ where: { id: String(req.params.id) } });
  if (child.userId) {
    await prisma.user.update({
      where: { id: child.userId },
      data: { status: 'inactive', loginEnabled: false },
    }).catch(() => undefined);
  }
  res.json({ success: true, message: 'Child deleted' });
}

export async function linkGuardian(req: Request, res: Response): Promise<void> {
  const parsed = guardianSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const child = await ensureChildInScope(String(req.params.id), await getScope(req), req);
  if (!child) { res.status(404).json({ success: false, message: 'Child not found' }); return; }
  if (child === false) { res.status(403).json({ success: false, message: 'Access denied' }); return; }

  if (isMemberRequest(req) && parsed.data.guardianId !== req.user?.userId) {
    res.status(403).json({ success: false, message: 'Members can only link themselves as guardian' });
    return;
  }

  if (!(await ensureGuardianInChurch(parsed.data.guardianId, child.churchId))) {
    res.status(400).json({ success: false, message: 'Guardian must belong to the same church as the child' });
    return;
  }

  await setPrimaryIfNeeded(child.id, parsed.data.guardianId, parsed.data.isPrimary);

  const link = await prisma.childGuardian.upsert({
    where: { childId_guardianId: { childId: child.id, guardianId: parsed.data.guardianId } },
    create: { childId: child.id, ...parsed.data },
    update: {
      relationship: parsed.data.relationship,
      isPrimary: parsed.data.isPrimary,
      canPickup: parsed.data.canPickup,
      emergencyContact: parsed.data.emergencyContact,
    },
    include: { guardian: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, churchId: true } } },
  });

  res.json({ success: true, data: link });
}

export async function updateGuardianLink(req: Request, res: Response): Promise<void> {
  const parsed = guardianSchema.omit({ guardianId: true }).partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const child = await ensureChildInScope(String(req.params.id), await getScope(req), req);
  if (!child) { res.status(404).json({ success: false, message: 'Child not found' }); return; }
  if (child === false) { res.status(403).json({ success: false, message: 'Access denied' }); return; }

  const guardianId = String(req.params.guardianId);
  if (isMemberRequest(req) && guardianId !== req.user?.userId) {
    res.status(403).json({ success: false, message: 'Members can only update their own guardian link' });
    return;
  }

  await setPrimaryIfNeeded(child.id, guardianId, parsed.data.isPrimary);

  const link = await prisma.childGuardian.update({
    where: { childId_guardianId: { childId: child.id, guardianId } },
    data: parsed.data,
    include: { guardian: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, churchId: true } } },
  });

  res.json({ success: true, data: link });
}

export async function unlinkGuardian(req: Request, res: Response): Promise<void> {
  const child = await ensureChildInScope(String(req.params.id), await getScope(req), req);
  if (!child) { res.status(404).json({ success: false, message: 'Child not found' }); return; }
  if (child === false) { res.status(403).json({ success: false, message: 'Access denied' }); return; }

  if (isMemberRequest(req) && String(req.params.guardianId) !== req.user?.userId) {
    res.status(403).json({ success: false, message: 'Members can only unlink themselves as guardian' });
    return;
  }

  await prisma.childGuardian.delete({
    where: { childId_guardianId: { childId: child.id, guardianId: String(req.params.guardianId) } },
  });

  res.json({ success: true, message: 'Guardian unlinked' });
}
