import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { hashPassword } from '../lib/password';

function safeUser(user: any) {
  const { password: _pw, ...rest } = user;
  return {
    ...rest,
    roleName: rest.role?.name ?? null,
    districts: rest.districts ? tryParse(rest.districts) : undefined,
    traditionalAuthorities: rest.traditionalAuthorities ? tryParse(rest.traditionalAuthorities) : undefined,
    regions: rest.regions ? tryParse(rest.regions) : undefined,
  };
}

function tryParse(val: string) {
  try { return JSON.parse(val); } catch { return val; }
}

// ─── GET /api/admin/stats ─────────────────────────────────────────────────────

export async function getAdminStats(_req: Request, res: Response): Promise<void> {
  const [ministryAdminRole, memberRole] = await Promise.all([
    prisma.role.findUnique({ where: { name: 'ministry_admin' }, select: { id: true } }),
    prisma.role.findUnique({ where: { name: 'member' }, select: { id: true } }),
  ]);

  const [
    totalUsers, totalChurches, totalMinistryAdmins, totalMembers,
    malawiUsers, kenyaUsers, activeUsers, suspendedUsers,
    activeSubscriptions, expiredSubscriptions,
    expiringSoonSubscriptions, totalPackages, pendingPayments, failedPayments,
    revenueResult, malawiRevenueResult, kenyaRevenueResult,
    systemRevenueResult, malawiSystemRevenueResult, kenyaSystemRevenueResult,
    withdrawalRevenueResult,
    packageSubscriptionCounts,
    recentRegistrations, recentPayments,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.church.count(),
    prisma.user.count({ where: { roleId: ministryAdminRole?.id } }),
    prisma.user.count({ where: { roleId: memberRole?.id } }),
    prisma.user.count({ where: { accountCountry: 'Malawi' } }),
    prisma.user.count({ where: { accountCountry: 'Kenya' } }),
    prisma.user.count({ where: { status: 'active' } }),
    prisma.user.count({ where: { status: 'suspended' } }),
    prisma.subscription.count({ where: { status: 'active' } }),
    prisma.subscription.count({ where: { status: 'expired' } }),
    prisma.subscription.count({
      where: {
        status: 'active',
        expiresAt: {
          gte: new Date(),
          lte: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        },
      },
    }),
    prisma.package.count({ where: { isActive: true } }),
    prisma.payment.count({ where: { status: 'pending' } }),
    prisma.payment.count({ where: { status: 'failed' } }),
    prisma.payment.aggregate({ where: { status: 'completed' }, _sum: { amount: true }, _count: true }),
    prisma.payment.aggregate({ where: { status: 'completed', currency: 'MWK' }, _sum: { amount: true }, _count: true }),
    prisma.payment.aggregate({ where: { status: 'completed', currency: 'KES' }, _sum: { amount: true }, _count: true }),
    prisma.transaction.aggregate({
      where: { status: 'completed' },
      _sum: { systemFeeAmount: true, ceilRoundingAmount: true } as any,
      _count: true,
    }),
    prisma.transaction.aggregate({
      where: { status: 'completed', currency: 'MWK' },
      _sum: { systemFeeAmount: true, ceilRoundingAmount: true } as any,
      _count: true,
    }),
    prisma.transaction.aggregate({
      where: { status: 'completed', currency: 'KES' },
      _sum: { systemFeeAmount: true, ceilRoundingAmount: true } as any,
      _count: true,
    }),
    prisma.withdrawal.aggregate({
      where: { status: 'completed' },
      _sum: { systemFeeAmount: true } as any,
      _count: true,
    }),
    prisma.subscription.groupBy({
      by: ['packageId', 'status'],
      _count: { _all: true },
    }),
    prisma.user.findMany({
      where: { roleId: ministryAdminRole?.id },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, firstName: true, lastName: true, email: true, accountCountry: true, createdAt: true },
    }),
    prisma.payment.findMany({
      where: { status: 'completed' },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        id: true, amount: true, currency: true, packageName: true, billingCycle: true,
        createdAt: true, ministryAdminId: true, gateway: true,
        package: { select: { displayName: true } },
      },
    }),
  ]);

  const adminIds = [...new Set(recentPayments.map((p: any) => p.ministryAdminId))];
  const admins = await prisma.user.findMany({
    where: { id: { in: adminIds } },
    select: { id: true, firstName: true, lastName: true, email: true },
  });
  const adminMap = Object.fromEntries(admins.map((a: any) => [a.id, a]));
  const packageIds = [...new Set(packageSubscriptionCounts.map((p: any) => p.packageId))];
  const packages = await prisma.package.findMany({
    where: { id: { in: packageIds } },
    select: { id: true, name: true, displayName: true },
  });
  const packageMap = Object.fromEntries(packages.map((p: any) => [p.id, p]));
  const packageBreakdown = packageSubscriptionCounts.reduce((acc: any[], row: any) => {
    const existing = acc.find(item => item.packageId === row.packageId);
    const pkg = packageMap[row.packageId];
    if (existing) {
      existing[row.status] = row._count._all;
      existing.total += row._count._all;
      return acc;
    }
    acc.push({
      packageId: row.packageId,
      packageName: pkg?.name ?? row.packageId,
      displayName: pkg?.displayName ?? row.packageId,
      active: row.status === 'active' ? row._count._all : 0,
      expired: row.status === 'expired' ? row._count._all : 0,
      cancelled: row.status === 'cancelled' ? row._count._all : 0,
      total: row._count._all,
    });
    return acc;
  }, []).sort((a: any, b: any) => b.total - a.total);

  res.json({
    success: true,
    data: {
      totalUsers, totalChurches, totalMinistryAdmins, totalMembers,
      malawiUsers, kenyaUsers, activeUsers, suspendedUsers,
      activeSubscriptions, expiredSubscriptions, expiringSoonSubscriptions,
      totalPackages, pendingPayments, failedPayments,
      totalRevenue: revenueResult._sum.amount ?? 0,
      totalPayments: revenueResult._count,
      malawiRevenue: malawiRevenueResult._sum.amount ?? 0,
      malawiPayments: malawiRevenueResult._count,
      kenyaRevenue: kenyaRevenueResult._sum.amount ?? 0,
      kenyaPayments: kenyaRevenueResult._count,
      mainRevenue: ((systemRevenueResult._sum as any)?.systemFeeAmount ?? 0) + ((systemRevenueResult._sum as any)?.ceilRoundingAmount ?? 0) + ((withdrawalRevenueResult._sum as any)?.systemFeeAmount ?? 0),
      mainRevenueTransactions: systemRevenueResult._count + withdrawalRevenueResult._count,
      malawiMainRevenue: ((malawiSystemRevenueResult._sum as any)?.systemFeeAmount ?? 0) + ((malawiSystemRevenueResult._sum as any)?.ceilRoundingAmount ?? 0) + ((withdrawalRevenueResult._sum as any)?.systemFeeAmount ?? 0),
      malawiMainRevenueTransactions: malawiSystemRevenueResult._count + withdrawalRevenueResult._count,
      kenyaMainRevenue: ((kenyaSystemRevenueResult._sum as any)?.systemFeeAmount ?? 0) + ((kenyaSystemRevenueResult._sum as any)?.ceilRoundingAmount ?? 0),
      kenyaMainRevenueTransactions: kenyaSystemRevenueResult._count,
      withdrawalSystemRevenue: (withdrawalRevenueResult._sum as any)?.systemFeeAmount ?? 0,
      withdrawalSystemRevenueCount: withdrawalRevenueResult._count,
      packageBreakdown,
      recentRegistrations,
      recentPayments: recentPayments.map((p: any) => ({ ...p, ministryAdmin: adminMap[p.ministryAdminId] ?? null })),
    },
  });
}

// ─── Helper: resolve user IDs belonging to a country ─────────────────────────

async function getUserIdsByCountry(country: string): Promise<string[]> {
  const admins = await prisma.user.findMany({
    where: { accountCountry: country },
    select: { id: true },
  });
  const adminIds = admins.map((a: any) => a.id);
  if (adminIds.length === 0) return [];

  const [linkedUsers, churchUsers] = await Promise.all([
    prisma.user.findMany({ where: { ministryAdminId: { in: adminIds } }, select: { id: true } }),
    prisma.user.findMany({ where: { church: { ministryAdminId: { in: adminIds } } }, select: { id: true } }),
  ]);

  return [...new Set([...adminIds, ...linkedUsers.map((u: any) => u.id), ...churchUsers.map((u: any) => u.id)])];
}

// ─── Helper: resolve all user IDs belonging to a ministry ────────────────────

async function getUserIdsByMinistry(ministryAdminId: string): Promise<string[]> {
  const [directUsers, churchUsers] = await Promise.all([
    prisma.user.findMany({ where: { ministryAdminId }, select: { id: true } }),
    prisma.user.findMany({ where: { church: { ministryAdminId } }, select: { id: true } }),
  ]);
  return [...new Set([ministryAdminId, ...directUsers.map((u: any) => u.id), ...churchUsers.map((u: any) => u.id)])];
}

// ─── GET /api/admin/ministries ────────────────────────────────────────────────

export async function getAdminMinistries(_req: Request, res: Response): Promise<void> {
  const ministryAdminRole = await prisma.role.findUnique({ where: { name: 'ministry_admin' }, select: { id: true } });
  if (!ministryAdminRole) { res.json({ success: true, data: [] }); return; }

  const admins = await prisma.user.findMany({
    where: { roleId: ministryAdminRole.id },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      ministryName: true,
      accountCountry: true,
      ownedChurches: { select: { name: true }, take: 1 },
    },
    orderBy: { firstName: 'asc' },
  });

  res.json({
    success: true,
    data: admins.map(a => ({
      id: a.id,
      label: a.ministryName ?? a.ownedChurches[0]?.name ?? `${a.firstName} ${a.lastName}`,
      country: a.accountCountry ?? null,
    })),
  });
}

// ─── GET /api/admin/users ─────────────────────────────────────────────────────
// Scoping: protected by authorizeSystemAdmin middleware — only system_admin role
// can reach this endpoint, so we intentionally show ALL platform users without
// getAccessibleChurchIds filtering (which would incorrectly limit to one ministry).

export async function getAdminUsers(req: Request, res: Response): Promise<void> {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(10, parseInt(req.query.limit as string) || 70));
  const skip = (page - 1) * limit;

  const search = (req.query.search as string)?.trim() || '';
  const roleFilter = req.query.role as string | undefined;
  const countryFilter = req.query.country as string | undefined;
  const statusFilter = req.query.status as string | undefined;
  const ministryFilter = req.query.ministry as string | undefined; // ministry_admin user id

  const where: any = {};

  if (search) {
    where.OR = [
      { firstName: { contains: search } },
      { lastName: { contains: search } },
      { email: { contains: search } },
      { phone: { contains: search } },
    ];
  }
  if (roleFilter) {
    const roleRecord = await prisma.role.findUnique({ where: { name: roleFilter }, select: { id: true } });
    if (roleRecord) where.roleId = roleRecord.id;
    else { res.json({ success: true, data: [], pagination: { page, limit, total: 0, totalPages: 0 } }); return; }
  }
  if (countryFilter) {
    where.id = { in: await getUserIdsByCountry(countryFilter) };
  }
  if (statusFilter) where.status = statusFilter;
  if (ministryFilter) {
    // Include the ministry_admin themselves + all users under them
    const underMinistry = await getUserIdsByMinistry(ministryFilter);
    if (where.id) {
      // Intersect with existing id filter (e.g. from countryFilter)
      const existing = new Set(where.id.in as string[]);
      where.id = { in: underMinistry.filter(id => existing.has(id)) };
    } else {
      where.id = { in: underMinistry };
    }
  }

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        status: true,
        accountCountry: true,
        ministryAdminId: true,
        ministryName: true,
        createdAt: true,
        role: { select: { id: true, name: true, displayName: true } },
        church: { select: { id: true, name: true, ministryAdminId: true } },
        _count: { select: { ownedChurches: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.user.count({ where }),
  ]);

  // Batch resolve country + ministryName via a single admin lookup
  const allAdminIds = new Set<string>();
  for (const u of users) {
    const adminId = (u as any).ministryAdminId ?? (u.church as any)?.ministryAdminId;
    if (adminId) allAdminIds.add(adminId);
    // ministry_admin: also add themselves so we can resolve their own info
    if (u.role?.name === 'ministry_admin') allAdminIds.add(u.id);
  }

  const adminInfoMap: Record<string, { accountCountry: string | null; ministryName: string | null; churchName: string | null }> = {};
  if (allAdminIds.size > 0) {
    const adminList = await prisma.user.findMany({
      where: { id: { in: [...allAdminIds] } },
      select: {
        id: true,
        accountCountry: true,
        ministryName: true,
        ownedChurches: { select: { name: true }, take: 1 },
      },
    });
    for (const a of adminList) {
      adminInfoMap[a.id] = {
        accountCountry: a.accountCountry ?? null,
        // Fall back to first owned church name if ministryName not set
        ministryName: a.ministryName ?? (a.ownedChurches[0]?.name ?? null),
        churchName: a.ownedChurches[0]?.name ?? null,
      };
    }
  }

  function resolveCountry(u: any): string | null {
    if (u.accountCountry) return u.accountCountry;
    const adminId = (u as any).ministryAdminId ?? (u.church as any)?.ministryAdminId;
    return adminId ? (adminInfoMap[adminId]?.accountCountry ?? null) : null;
  }

  function resolveMinistryName(u: any): string | null {
    // ministry_admin: use their own ministryName, fall back to their first church name
    if (u.role?.name === 'ministry_admin') {
      return (u as any).ministryName ?? adminInfoMap[u.id]?.churchName ?? null;
    }
    // All other roles: trace up to their ministry admin
    const adminId = (u as any).ministryAdminId ?? (u.church as any)?.ministryAdminId;
    return adminId ? (adminInfoMap[adminId]?.ministryName ?? null) : null;
  }

  res.json({
    success: true,
    data: users.map(u => ({
      id: u.id,
      firstName: u.firstName,
      lastName: u.lastName,
      email: u.email,
      phone: u.phone ?? null,
      status: u.status,
      createdAt: u.createdAt,
      role: u.role,
      roleName: u.role?.name ?? null,
      church: u.church ? { id: u.church.id, name: u.church.name } : null,
      churchCount: u._count.ownedChurches,
      resolvedCountry: resolveCountry(u),
      resolvedMinistryName: resolveMinistryName(u),
    })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
}

// ─── GET /api/admin/users/:id ─────────────────────────────────────────────────

export async function getAdminUser(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id);

  const user = await prisma.user.findUnique({
    where: { id },
    include: {
      role: { select: { id: true, name: true, displayName: true } },
      church: { select: { id: true, name: true } },
      childProfile: {
        select: {
          id: true, firstName: true, lastName: true, dateOfBirth: true, age: true, gender: true, status: true,
          church: { select: { id: true, name: true } },
          guardians: {
            select: {
              relationship: true,
              isPrimary: true,
              canPickup: true,
              emergencyContact: true,
              guardian: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
            },
          },
        },
      },
      ownedChurches: {
        select: {
          id: true, name: true, location: true, country: true,
          region: true, district: true, createdAt: true,
          _count: { select: { users: true } },
        },
        orderBy: { createdAt: 'desc' },
      },
    },
  });

  if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }

  let subscriptions: any[] = [];
  let payments: any[] = [];
  if (user.role?.name === 'ministry_admin') {
    [subscriptions, payments] = await Promise.all([
      prisma.subscription.findMany({
        where: { ministryAdminId: id },
        include: { package: { select: { id: true, name: true, displayName: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.payment.findMany({
        where: { ministryAdminId: id },
        include: { package: { select: { name: true, displayName: true } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);
  }

  const activeSubscription = subscriptions.find((s: any) => s.status === 'active') ?? null;

  res.json({
    success: true,
    data: { ...safeUser(user), ownedChurches: user.ownedChurches, subscription: activeSubscription, subscriptions, payments },
  });
}

// ─── PUT /api/admin/users/:id ─────────────────────────────────────────────────

const updateUserSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  email: z.string().email().optional(),
  phone: z.string().nullable().optional(),
  status: z.enum(['active', 'suspended', 'inactive']).optional(),
  accountCountry: z.enum(['Malawi', 'Kenya']).nullable().optional(),
  title: z.string().nullable().optional(),
  titleOther: z.string().nullable().optional(),
  ministryName: z.string().nullable().optional(),
  currentMembership: z.coerce.number().int().min(0).nullable().optional(),
  numberOfBranches: z.coerce.number().int().min(0).nullable().optional(),
  gender: z.enum(['male', 'female']).nullable().optional(),
  dateOfBirth: z.string().nullable().optional(),
  maritalStatus: z.enum(['single', 'married', 'widowed', 'divorced']).nullable().optional(),
  weddingDate: z.string().nullable().optional(),
  residentialNeighbourhood: z.string().nullable().optional(),
  membershipType: z.enum(['member', 'pastor', 'deacon', 'other']).nullable().optional(),
  serviceInterest: z.string().nullable().optional(),
  baptizedByImmersion: z.boolean().nullable().optional(),
  memberType: z.enum(['adult', 'child']).optional(),
  loginEnabled: z.boolean().optional(),
  roleId: z.string().optional(),
  churchId: z.string().nullable().optional(),
  regions: z.array(z.string()).optional(),
  districts: z.array(z.string()).optional(),
  traditionalAuthorities: z.array(z.string()).optional(),
});

function buildUserUpdateData(data: z.infer<typeof updateUserSchema>) {
  const updateData: any = { ...data };
  if (data.dateOfBirth !== undefined) updateData.dateOfBirth = data.dateOfBirth ? new Date(data.dateOfBirth) : null;
  if (data.weddingDate !== undefined) updateData.weddingDate = data.weddingDate ? new Date(data.weddingDate) : null;
  if (data.regions !== undefined) updateData.regions = JSON.stringify(data.regions);
  if (data.districts !== undefined) updateData.districts = JSON.stringify(data.districts);
  if (data.traditionalAuthorities !== undefined) updateData.traditionalAuthorities = JSON.stringify(data.traditionalAuthorities);
  return updateData;
}

async function resolveTargetMinistryAdminId(target: any): Promise<string | null> {
  if (target.role?.name === 'ministry_admin') return target.id;
  if (target.ministryAdminId) return target.ministryAdminId;
  if (target.churchId) {
    const church = await prisma.church.findUnique({ where: { id: target.churchId }, select: { ministryAdminId: true } });
    return church?.ministryAdminId ?? null;
  }
  return null;
}

export async function getAdminUserRoleOptions(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id);
  const target = await prisma.user.findUnique({
    where: { id },
    include: { role: { select: { name: true } } },
  });
  if (!target) { res.status(404).json({ success: false, message: 'User not found' }); return; }

  const ministryAdminId = await resolveTargetMinistryAdminId(target);
  const roles = await prisma.role.findMany({
    where: {
      name: { not: 'system_admin' },
      OR: [
        { ministryAdminId: null },
        ...(ministryAdminId ? [{ ministryAdminId }] : []),
      ],
    },
    select: { id: true, name: true, displayName: true, isSystemRole: true, ministryAdminId: true },
    orderBy: [{ isSystemRole: 'desc' }, { displayName: 'asc' }],
  });

  res.json({ success: true, data: { ministryAdminId, roles } });
}

export async function updateAdminUser(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id);

  const target = await prisma.user.findUnique({
    where: { id },
    include: { role: { select: { name: true } } },
  });
  if (!target) { res.status(404).json({ success: false, message: 'User not found' }); return; }
  if (target.role?.name === 'system_admin') {
    res.status(403).json({ success: false, message: 'Cannot modify another system admin' }); return;
  }

  const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }
  const updateData = buildUserUpdateData(parsed.data);

  if (parsed.data.roleId) {
    const ministryAdminId = await resolveTargetMinistryAdminId(target);
    const role = await prisma.role.findFirst({
      where: {
        id: parsed.data.roleId,
        name: { not: 'system_admin' },
        OR: [
          { ministryAdminId: null },
          ...(ministryAdminId ? [{ ministryAdminId }] : []),
        ],
      },
    });
    if (!role) { res.status(400).json({ success: false, message: 'Role not found in this user ministry scope' }); return; }
    updateData.roleId = role.id;
    if (role.ministryAdminId) updateData.ministryAdminId = role.ministryAdminId;
    else if (role.name === 'member' && ministryAdminId) updateData.ministryAdminId = ministryAdminId;
  }

  const updated = await prisma.user.update({
    where: { id },
    data: updateData,
    include: { role: { select: { id: true, name: true, displayName: true } } },
  });

  res.json({ success: true, data: safeUser(updated) });
}

// ─── DELETE /api/admin/users/:id ──────────────────────────────────────────────

export async function deleteAdminUser(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id);

  if (id === req.user?.userId) {
    res.status(400).json({ success: false, message: 'Cannot delete your own account' }); return;
  }

  const target = await prisma.user.findUnique({
    where: { id },
    include: { role: { select: { name: true } } },
  });
  if (!target) { res.status(404).json({ success: false, message: 'User not found' }); return; }
  if (target.role?.name === 'system_admin') {
    res.status(403).json({ success: false, message: 'Cannot delete a system admin' }); return;
  }

  await prisma.user.delete({ where: { id } });
  res.json({ success: true, message: 'User deleted successfully' });
}

// ─── POST /api/admin/users/:id/reset-password ─────────────────────────────────

export async function resetAdminUserPassword(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id);
  const { password } = req.body;

  if (!password || password.length < 8) {
    res.status(400).json({ success: false, message: 'Password must be at least 8 characters' }); return;
  }

  const target = await prisma.user.findUnique({ where: { id }, select: { id: true } });
  if (!target) { res.status(404).json({ success: false, message: 'User not found' }); return; }

  await prisma.user.update({ where: { id }, data: { password: await hashPassword(password) } });
  res.json({ success: true, message: 'Password reset successfully' });
}

// ─── POST /api/admin/users/:id/send-email ─────────────────────────────────────

export async function sendEmailToUser(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id);
  const { subject, message } = req.body;

  if (!subject?.trim() || !message?.trim()) {
    res.status(400).json({ success: false, message: 'Subject and message are required' }); return;
  }

  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, firstName: true, email: true },
  });
  if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }

  const { queueEmail } = await import('../lib/emailQueue');
  const { adminDirectEmailTemplate } = await import('../lib/emailTemplates');

  await queueEmail(
    user.email,
    subject.trim(),
    adminDirectEmailTemplate({ firstName: user.firstName, subject: subject.trim(), message: message.trim() }),
    'notification'
  );

  res.json({ success: true, message: `Email queued for ${user.email}` });
}

// ─── GET /api/admin/churches/:id ──────────────────────────────────────────────

export async function getAdminChurch(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id);

  const church = await prisma.church.findUnique({
    where: { id },
    include: {
      ministryAdmin: {
        select: { id: true, firstName: true, lastName: true, email: true, phone: true, accountCountry: true },
      },
      _count: { select: { users: true, events: true, givingCampaigns: true } },
    },
  });
  if (!church) { res.status(404).json({ success: false, message: 'Church not found' }); return; }

  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(10, parseInt(req.query.limit as string) || 70));
  const skip = (page - 1) * limit;
  const search = (req.query.search as string)?.trim() || '';
  const roleFilter = req.query.role as string | undefined;
  const statusFilter = req.query.status as string | undefined;

  const userWhere: any = { churchId: id };
  if (search) {
    userWhere.OR = [
      { firstName: { contains: search } },
      { lastName: { contains: search } },
      { email: { contains: search } },
    ];
  }
  if (roleFilter) {
    const roleRecord = await prisma.role.findUnique({ where: { name: roleFilter }, select: { id: true } });
    if (roleRecord) userWhere.roleId = roleRecord.id;
  }
  if (statusFilter) userWhere.status = statusFilter;

  const [users, userTotal, teams, cells] = await Promise.all([
    prisma.user.findMany({
      where: userWhere,
      include: { role: { select: { name: true, displayName: true } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.user.count({ where: userWhere }),
    // Teams — name + member count only (privacy: no personal data)
    prisma.team.findMany({
      where: { churchId: id },
      select: {
        id: true,
        name: true,
        description: true,
        color: true,
        createdAt: true,
        _count: { select: { members: true } },
        members: {
          select: {
            isLeader: true,
            user: { select: { id: true, firstName: true, lastName: true } },
          },
        },
      },
      orderBy: { name: 'asc' },
    }),
    // Cells — name + member count only (privacy: no personal data)
    prisma.cell.findMany({
      where: { churchId: id },
      select: {
        id: true,
        name: true,
        zone: true,
        status: true,
        createdAt: true,
        _count: { select: { members: true } },
        members: {
          select: {
            isLeader: true,
            isAssistant: true,
            user: { select: { id: true, firstName: true, lastName: true } },
          },
        },
      },
      orderBy: { name: 'asc' },
    }),
  ]);

  res.json({
    success: true,
    data: {
      ...church,
      users: users.map(safeUser),
      userPagination: { page, limit, total: userTotal, totalPages: Math.ceil(userTotal / limit) },
      teams,
      cells,
    },
  });
}

// ─── PUT /api/admin/churches/:id ──────────────────────────────────────────────

const updateChurchSchema = z.object({
  name: z.string().min(2).optional(),
  location: z.string().optional(),
  pastorName: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  website: z.string().optional(),
  address: z.string().optional(),
});

export async function updateAdminChurch(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id);

  const church = await prisma.church.findUnique({ where: { id }, select: { id: true } });
  if (!church) { res.status(404).json({ success: false, message: 'Church not found' }); return; }

  const parsed = updateChurchSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const updated = await prisma.church.update({ where: { id }, data: parsed.data });
  res.json({ success: true, data: updated });
}

// ─── DELETE /api/admin/churches/:id ───────────────────────────────────────────

export async function deleteAdminChurch(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id);

  const church = await prisma.church.findUnique({ where: { id }, select: { id: true } });
  if (!church) { res.status(404).json({ success: false, message: 'Church not found' }); return; }

  await prisma.$transaction(async (tx) => {
    await tx.event.deleteMany({ where: { churchId: id } });
    await tx.givingCampaign.deleteMany({ where: { churchId: id } });
    await tx.donationTransaction.deleteMany({ where: { churchId: id } });
    await tx.attendance.deleteMany({ where: { churchId: id } });
    await tx.meeting.deleteMany({ where: { churchId: id } });
    await tx.announcement.deleteMany({ where: { churchId: id } });
    await tx.resource.deleteMany({ where: { churchId: id } });
    await tx.transaction.deleteMany({ where: { churchId: id } });
    await tx.user.updateMany({ where: { churchId: id }, data: { churchId: null } });
    await tx.church.delete({ where: { id } });
  });

  res.json({ success: true, message: 'Church deleted successfully' });
}

// ─── PUT /api/admin/church-users/:id ──────────────────────────────────────────

export async function updateAdminChurchUser(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id);

  const target = await prisma.user.findUnique({ where: { id }, select: { id: true } });
  if (!target) { res.status(404).json({ success: false, message: 'User not found' }); return; }

  const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const updated = await prisma.user.update({
    where: { id },
    data: buildUserUpdateData(parsed.data),
    include: { role: { select: { name: true, displayName: true } } },
  });

  res.json({ success: true, data: safeUser(updated) });
}

// ─── POST /api/admin/users/:id/subscription ───────────────────────────────────

const subscriptionSchema = z.object({
  packageId: z.string().min(1, 'Package is required'),
  startsAt: z.string().min(1, 'Start date is required'),
  expiresAt: z.string().min(1, 'Expiry date is required'),
  status: z.enum(['active', 'expired', 'cancelled']).default('active'),
});

export async function manageAdminSubscription(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id);

  const user = await prisma.user.findUnique({
    where: { id },
    include: { role: { select: { name: true } } },
  });
  if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }
  if (user.role?.name !== 'ministry_admin') {
    res.status(400).json({ success: false, message: 'Subscriptions only apply to ministry admins' }); return;
  }

  const parsed = subscriptionSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const pkg = await prisma.package.findUnique({ where: { id: parsed.data.packageId }, select: { id: true } });
  if (!pkg) { res.status(404).json({ success: false, message: 'Package not found' }); return; }

  await prisma.subscription.updateMany({ where: { ministryAdminId: id, status: 'active' }, data: { status: 'expired' } });

  // Delete any existing subscription (unique constraint allows only one per admin)
  // then create a fresh one with the new dates/package
  await prisma.subscription.deleteMany({ where: { ministryAdminId: id } });

  const subscription = await prisma.subscription.create({
    data: {
      ministryAdminId: id,
      packageId: parsed.data.packageId,
      status: parsed.data.status,
      startsAt: new Date(parsed.data.startsAt),
      expiresAt: new Date(parsed.data.expiresAt),
    },
    include: { package: { select: { id: true, name: true, displayName: true } } },
  });

  res.status(201).json({ success: true, data: subscription });
}

// ─── PUT /api/admin/users/:id/subscription/:subId ─────────────────────────────

export async function updateAdminSubscription(req: Request, res: Response): Promise<void> {
  const userId = String(req.params.id);
  const subId = String(req.params.subId);

  const sub = await prisma.subscription.findUnique({ where: { id: subId } });
  if (!sub || sub.ministryAdminId !== userId) {
    res.status(404).json({ success: false, message: 'Subscription not found' }); return;
  }

  const parsed = subscriptionSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  if (parsed.data.status === 'active') {
    await prisma.subscription.updateMany({
      where: { ministryAdminId: userId, status: 'active', id: { not: subId } },
      data: { status: 'expired' },
    });
  }

  const updated = await prisma.subscription.update({
    where: { id: subId },
    data: {
      packageId: parsed.data.packageId,
      status: parsed.data.status,
      startsAt: new Date(parsed.data.startsAt),
      expiresAt: new Date(parsed.data.expiresAt),
    },
    include: { package: { select: { id: true, name: true, displayName: true } } },
  });

  res.json({ success: true, data: updated });
}

// ─── GET /api/admin/transactions ──────────────────────────────────────────────

export async function getAdminTransactions(req: Request, res: Response): Promise<void> {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(10, parseInt(req.query.limit as string) || 70));
  const skip = (page - 1) * limit;

  const search = (req.query.search as string)?.trim() || '';
  const packageFilter = req.query.package as string | undefined;
  const statusFilter = req.query.status as string | undefined;
  const countryFilter = req.query.country as string | undefined;
  const gatewayFilter = req.query.gateway as string | undefined;
  const cycleFilter = req.query.cycle as string | undefined;
  const ministryFilter = req.query.ministry as string | undefined;
  const dateFrom = req.query.dateFrom as string | undefined;
  const dateTo = req.query.dateTo as string | undefined;

  const where: any = {};
  const adminIdFilters: string[][] = [];

  if (search) {
    const matchingUsers = await prisma.user.findMany({
      where: { OR: [{ firstName: { contains: search } }, { lastName: { contains: search } }, { email: { contains: search } }] },
      select: { id: true },
    });
    adminIdFilters.push(matchingUsers.map((u: any) => u.id));
  }

  if (ministryFilter) adminIdFilters.push([ministryFilter]);

  if (packageFilter) where.packageName = packageFilter;
  if (statusFilter) where.status = statusFilter;
  if (gatewayFilter) where.gateway = gatewayFilter;
  if (cycleFilter) where.billingCycle = cycleFilter;
  if (dateFrom || dateTo) {
    where.createdAt = {};
    if (dateFrom) where.createdAt.gte = new Date(dateFrom);
    if (dateTo) where.createdAt.lte = new Date(dateTo + 'T23:59:59Z');
  }

  if (countryFilter) {
    const countryAdmins = await prisma.user.findMany({ where: { accountCountry: countryFilter }, select: { id: true } });
    adminIdFilters.push(countryAdmins.map((u: any) => u.id));
  }

  if (adminIdFilters.length > 0) {
    const [firstIds, ...restIds] = adminIdFilters;
    const matchingIds = firstIds.filter((id: string) => restIds.every(ids => ids.includes(id)));
    where.ministryAdminId = { in: matchingIds };
  }

  const [payments, total, byCurrency, byStatus, byType, byGateway] = await Promise.all([
    prisma.payment.findMany({
      where,
      include: { package: { select: { name: true, displayName: true } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.payment.count({ where }),
    prisma.payment.groupBy({
      by: ['currency'],
      where,
      _count: { _all: true },
      _sum: { amount: true, baseAmount: true, convenienceFee: true, systemFeeAmount: true, ceilRoundingAmount: true, totalAmount: true } as any,
    }),
    prisma.payment.groupBy({ by: ['status'], where, _count: { _all: true } }),
    prisma.payment.groupBy({ by: ['type'], where, _count: { _all: true } }),
    prisma.payment.groupBy({ by: ['gateway'], where, _count: { _all: true } }),
  ]);

  const adminIds = [...new Set(payments.map((p: any) => p.ministryAdminId))];
  const admins = await prisma.user.findMany({
    where: { id: { in: adminIds } },
    select: { id: true, firstName: true, lastName: true, email: true, accountCountry: true },
  });
  const adminMap = Object.fromEntries(admins.map((a: any) => [a.id, a]));

  res.json({
    success: true,
    data: payments.map((p: any) => ({ ...p, ministryAdmin: adminMap[p.ministryAdminId] ?? null })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    summary: {
      total,
      byStatus: Object.fromEntries(byStatus.map((item: any) => [item.status || 'unknown', item._count._all])),
      byType: Object.fromEntries(byType.map((item: any) => [item.type || 'unknown', item._count._all])),
      byGateway: Object.fromEntries(byGateway.map((item: any) => [item.gateway || 'unknown', item._count._all])),
      byCurrency: byCurrency.map((item: any) => {
        const packageRevenue = item._sum.baseAmount ?? item._sum.amount ?? 0;
        const gatewayCost = item._sum.convenienceFee ?? 0;
        const feeOnly = item._sum.systemFeeAmount ?? 0;
        const rounding = item._sum.ceilRoundingAmount ?? 0;
        const icimsFee = feeOnly + rounding;
        return {
          currency: item.currency,
          count: item._count._all,
          totalCollected: item._sum.totalAmount ?? item._sum.amount ?? 0,
          packageRevenue,
          gatewayCost,
          icimsFee,
          feeOnly,
          rounding,
          totalRevenue: packageRevenue + icimsFee,
          totalPaymentCost: gatewayCost + icimsFee,
        };
      }),
    },
  });
}

// ─── GET /api/admin/system-transactions ───────────────────────────────────────

export async function getAdminSystemTransactions(req: Request, res: Response): Promise<void> {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(10, parseInt(req.query.limit as string) || 70));
  const skip = (page - 1) * limit;

  const search         = (req.query.search as string)?.trim() || '';
  const typeFilter     = req.query.type as string | undefined;
  const statusFilter   = req.query.status as string | undefined;
  const gatewayFilter  = req.query.gateway as string | undefined;
  const countryFilter  = req.query.country as string | undefined;
  const churchIdFilter = req.query.churchId as string | undefined;
  const ministryFilter = req.query.ministry as string | undefined;
  const dateFrom       = req.query.dateFrom as string | undefined;
  const dateTo         = req.query.dateTo as string | undefined;

  // Build AND conditions so filters never overwrite each other
  const andConditions: any[] = [];

  // Search — matches user name/email, guest name/email, or reference
  if (search) {
    const matchingUsers = await prisma.user.findMany({
      where: {
        OR: [
          { firstName: { contains: search } },
          { lastName: { contains: search } },
          { email: { contains: search } },
        ],
      },
      select: { id: true },
    });
    andConditions.push({
      OR: [
        { userId: { in: matchingUsers.map((u: any) => u.id) } },
        { guestName: { contains: search } },
        { guestEmail: { contains: search } },
        { reference: { contains: search } },
      ],
    });
  }

  if (typeFilter)    andConditions.push({ type: typeFilter });
  if (statusFilter)  andConditions.push({ status: statusFilter });
  if (gatewayFilter) andConditions.push({ gateway: gatewayFilter });

  // Country — gatewayCountry is already stored on the transaction row
  if (countryFilter) andConditions.push({ gatewayCountry: countryFilter });

  // Ministry filter — resolve all churchIds belonging to this ministry admin
  if (ministryFilter) {
    const ministryChurches = await prisma.church.findMany({
      where: { ministryAdminId: ministryFilter },
      select: { id: true },
    });
    const ministryChurchIds = ministryChurches.map((c: any) => c.id);
    // If a churchId filter is also set, intersect the two sets
    if (churchIdFilter) {
      andConditions.push({ churchId: ministryChurchIds.includes(churchIdFilter) ? churchIdFilter : '__no_match__' });
    } else {
      andConditions.push({ churchId: { in: ministryChurchIds } });
    }
  } else if (churchIdFilter) {
    // Specific church filter (no ministry filter)
    andConditions.push({ churchId: churchIdFilter });
  }

  if (dateFrom || dateTo) {
    const dateCondition: any = {};
    if (dateFrom) dateCondition.gte = new Date(dateFrom);
    if (dateTo)   dateCondition.lte = new Date(dateTo + 'T23:59:59Z');
    andConditions.push({ createdAt: dateCondition });
  }

  const where: any = andConditions.length > 0 ? { AND: andConditions } : {};

  const [transactions, total, mwkAgg, kesAgg, statusCounts, typeCounts] = await Promise.all([
    prisma.transaction.findMany({
      where,
      select: {
        id: true,
        type: true,
        amount: true,
        baseAmount: true,
        convenienceFee: true,
        systemFeeAmount: true,
        ceilRoundingAmount: true,
        totalAmount: true,
        currency: true,
        status: true,
        paymentMethod: true,
        gateway: true,
        gatewayCountry: true,
        reference: true,
        isGuest: true,
        isManual: true,
        guestName: true,
        guestEmail: true,
        paidAt: true,
        createdAt: true,
        user: { select: { firstName: true, lastName: true, email: true } },
        church: { select: { id: true, name: true } },
      } as any,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.transaction.count({ where }),
    prisma.transaction.aggregate({
      where: { ...where, currency: 'MWK' },
      _sum: { baseAmount: true, systemFeeAmount: true, convenienceFee: true, ceilRoundingAmount: true, totalAmount: true } as any,
      _count: { _all: true },
    }),
    prisma.transaction.aggregate({
      where: { ...where, currency: 'KES' },
      _sum: { baseAmount: true, systemFeeAmount: true, convenienceFee: true, ceilRoundingAmount: true, totalAmount: true } as any,
      _count: { _all: true },
    }),
    prisma.transaction.groupBy({ by: ['status'], where, _count: { _all: true } }),
    prisma.transaction.groupBy({ by: ['type'], where, _count: { _all: true } }),
  ]);

  // Enrich with campaign and event names for display (single batch each)
  const txList = transactions as any[];

  const donationTxIds = txList.filter(t => t.type === 'donation').map((t: any) => t.id);
  const donationDetails = donationTxIds.length > 0
    ? await prisma.donationTransaction.findMany({
        where: { transactionId: { in: donationTxIds } },
        select: { transactionId: true, campaign: { select: { name: true, category: true } } },
      })
    : [];
  const donationMap = new Map(donationDetails.map((d: any) => [d.transactionId, d]));

  const eventTxIds = txList.filter(t => t.type === 'event_ticket').map((t: any) => t.id);
  const eventDetails = eventTxIds.length > 0
    ? await prisma.eventTicket.findMany({
        where: { transactionId: { in: eventTxIds } },
        select: { transactionId: true, event: { select: { title: true } } },
      })
    : [];
  const eventMap = new Map(eventDetails.map((e: any) => [e.transactionId, e]));

  const enriched = txList.map(t => ({
    ...t,
    campaignName: (donationMap.get(t.id) as any)?.campaign?.name ?? null,
    campaignCategory: (donationMap.get(t.id) as any)?.campaign?.category ?? null,
    eventTitle: (eventMap.get(t.id) as any)?.event?.title ?? null,
  }));

  const buildCurrencySummary = (agg: any, currency: string) => {
    const totalBaseAmount = agg._sum?.baseAmount ?? 0;
    const totalGatewayFee = agg._sum?.convenienceFee ?? 0;
    const totalSystemFeeOnly = agg._sum?.systemFeeAmount ?? 0;
    const totalRounding = agg._sum?.ceilRoundingAmount ?? 0;
    const totalSystemFee = totalSystemFeeOnly + totalRounding;
    const totalCharged = agg._sum?.totalAmount ?? 0;
    return {
      currency,
      count: agg._count?._all ?? 0,
      totalBaseAmount,
      totalSystemFee,
      totalSystemFeeOnly,
      totalRounding,
      totalGatewayFee,
      totalTransactionCost: totalGatewayFee + totalSystemFee,
      totalCharged,
    };
  };

  res.json({
    success: true,
    data: enriched,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    summary: {
      total,
      byStatus: Object.fromEntries(statusCounts.map((row: any) => [row.status, row._count._all])),
      byType: Object.fromEntries(typeCounts.map((row: any) => [row.type, row._count._all])),
      byCurrency: [
        ...((mwkAgg._count as any)?._all > 0 ? [buildCurrencySummary(mwkAgg, 'MWK')] : []),
        ...((kesAgg._count as any)?._all > 0 ? [buildCurrencySummary(kesAgg, 'KES')] : []),
      ],
    },
  });
}

// ─── GET /api/admin/system-transactions/:id ──────────────────────────────────

export async function getAdminSystemTransaction(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id);

  const tx = await prisma.transaction.findUnique({
    where: { id },
    include: {
      user:   { select: { firstName: true, lastName: true, email: true, phone: true } },
      church: { select: { id: true, name: true } },
      tickets: { select: { ticketNumber: true, status: true } },
    },
  }) as any;

  if (!tx) { res.status(404).json({ success: false, message: 'Transaction not found' }); return; }

  // Enrich with campaign name for donations
  let campaignName: string | null = null;
  let campaignCategory: string | null = null;
  let cellName: string | null = null;
  if (tx.type === 'donation') {
    const donationTx = await prisma.donationTransaction.findFirst({
      where: { transactionId: id },
      select: { campaign: { select: { name: true, category: true } }, cell: { select: { name: true } } },
    });
    campaignName     = donationTx?.campaign?.name ?? null;
    campaignCategory = donationTx?.campaign?.category ?? null;
    cellName         = donationTx?.cell?.name ?? null;
  }

  // Parse gatewayResponse so frontend gets a real object
  let gatewayResponseParsed: any = null;
  if (tx.gatewayResponse) {
    try { gatewayResponseParsed = JSON.parse(tx.gatewayResponse); } catch {}
  }

  res.json({
    success: true,
    data: {
      ...tx,
      campaignName,
      campaignCategory,
      cellName,
      gatewayResponseParsed,
    },
  });
}

// ─── GET /api/admin/pending-transactions ─────────────────────────────────────

export async function getAdminWithdrawals(req: Request, res: Response): Promise<void> {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(10, parseInt(req.query.limit as string) || 70));
  const skip = (page - 1) * limit;

  const search = (req.query.search as string)?.trim() || '';
  const status = req.query.status as string | undefined;
  const method = req.query.method as string | undefined;
  const currency = req.query.currency as string | undefined;
  const ministry = req.query.ministry as string | undefined;
  const dateFrom = req.query.dateFrom as string | undefined;
  const dateTo = req.query.dateTo as string | undefined;
  const andConditions: any[] = [];

  if (search) {
    const matchingUsers = await prisma.user.findMany({
      where: {
        OR: [
          { firstName: { contains: search } },
          { lastName: { contains: search } },
          { email: { contains: search } },
          { phone: { contains: search } },
          { ministryName: { contains: search } },
        ],
      },
      select: { id: true },
    });
    andConditions.push({
      OR: [
        { id: { contains: search } },
        { chargeId: { contains: search } },
        { accountName: { contains: search } },
        { accountNumber: { contains: search } },
        { mobileNumber: { contains: search } },
        { failureReason: { contains: search } },
        { initiatedBy: { in: matchingUsers.map((u: any) => u.id) } },
        { ministryAdminId: { in: matchingUsers.map((u: any) => u.id) } },
      ],
    });
  }

  if (status) andConditions.push({ status });
  if (method) andConditions.push({ method });
  if (currency) andConditions.push({ wallet: { currency } });
  if (ministry) {
    andConditions.push({ ministryAdminId: ministry });
  }
  if (dateFrom || dateTo) {
    const createdAt: any = {};
    if (dateFrom) createdAt.gte = new Date(dateFrom);
    if (dateTo) createdAt.lte = new Date(`${dateTo}T23:59:59Z`);
    andConditions.push({ createdAt });
  }

  const where: any = andConditions.length > 0 ? { AND: andConditions } : {};
  const [withdrawals, total, statusCounts, methodCounts, walletCounts, mwkAgg, kesAgg, completedMwkAgg, completedKesAgg] = await Promise.all([
    prisma.withdrawal.findMany({
      where,
      include: {
        wallet: {
          select: {
            id: true,
            currency: true,
            church: {
              select: {
                id: true,
                name: true,
                ministryAdminId: true,
                ministryAdmin: { select: { id: true, firstName: true, lastName: true, email: true, ministryName: true, accountCountry: true } },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.withdrawal.count({ where }),
    prisma.withdrawal.groupBy({ by: ['status'], where, _count: { _all: true } }),
    prisma.withdrawal.groupBy({ by: ['method'], where, _count: { _all: true } }),
    prisma.withdrawal.groupBy({ by: ['walletId'], where, _count: { _all: true } }),
    prisma.withdrawal.aggregate({ where: { ...where, wallet: { currency: 'MWK' } } as any, _sum: { amount: true, fee: true, gatewayFeeAmount: true, bankFixedFeeAmount: true, systemFeeAmount: true, netAmount: true, payoutAmount: true } as any, _count: { _all: true } }),
    prisma.withdrawal.aggregate({ where: { ...where, wallet: { currency: 'KES' } } as any, _sum: { amount: true, fee: true, gatewayFeeAmount: true, bankFixedFeeAmount: true, systemFeeAmount: true, netAmount: true, payoutAmount: true } as any, _count: { _all: true } }),
    prisma.withdrawal.aggregate({ where: { ...where, status: 'completed', wallet: { currency: 'MWK' } } as any, _sum: { systemFeeAmount: true } as any, _count: { _all: true } }),
    prisma.withdrawal.aggregate({ where: { ...where, status: 'completed', wallet: { currency: 'KES' } } as any, _sum: { systemFeeAmount: true } as any, _count: { _all: true } }),
  ]);

  const initiatorIds = [...new Set((withdrawals as any[]).map(w => w.initiatedBy).filter(Boolean))] as string[];
  const [initiators, wallets] = await Promise.all([
    initiatorIds.length > 0 ? prisma.user.findMany({ where: { id: { in: initiatorIds } }, select: { id: true, firstName: true, lastName: true, email: true, phone: true } }) : [],
    walletCounts.length > 0 ? prisma.wallet.findMany({ where: { id: { in: walletCounts.map((row: any) => row.walletId) } }, select: { id: true, currency: true } }) : [],
  ]);
  const initiatorMap = new Map((initiators as any[]).map(u => [u.id, u]));
  const walletCurrency = new Map((wallets as any[]).map(w => [w.id, w.currency]));
  const byCurrencyCount = walletCounts.reduce((acc: Record<string, number>, row: any) => {
    const key = walletCurrency.get(row.walletId) || 'Unknown';
    acc[key] = (acc[key] || 0) + row._count._all;
    return acc;
  }, {});
  const buildCurrencySummary = (agg: any, completedAgg: any, code: string) => ({
    currency: code,
    count: agg._count?._all ?? 0,
    totalRequested: agg._sum?.amount ?? 0,
    totalFee: agg._sum?.fee ?? 0,
    gatewayFee: agg._sum?.gatewayFeeAmount ?? 0,
    bankFixedFee: agg._sum?.bankFixedFeeAmount ?? 0,
    systemFee: agg._sum?.systemFeeAmount ?? 0,
    netAmount: agg._sum?.netAmount ?? 0,
    payoutAmount: agg._sum?.payoutAmount ?? 0,
    completedSystemRevenue: completedAgg._sum?.systemFeeAmount ?? 0,
    completedCount: completedAgg._count?._all ?? 0,
  });

  res.json({
    success: true,
    data: (withdrawals as any[]).map(w => ({
      ...w,
      currency: w.wallet?.currency ?? 'MWK',
      church: w.wallet?.church ?? null,
      ministryAdmin: w.wallet?.church?.ministryAdmin ?? null,
      initiatedByUser: w.initiatedBy ? initiatorMap.get(w.initiatedBy) ?? null : null,
    })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    summary: {
      total,
      byStatus: Object.fromEntries(statusCounts.map((row: any) => [row.status, row._count._all])),
      byMethod: Object.fromEntries(methodCounts.map((row: any) => [row.method, row._count._all])),
      byCurrencyCount,
      byCurrency: [
        ...((mwkAgg._count as any)?._all > 0 ? [buildCurrencySummary(mwkAgg, completedMwkAgg, 'MWK')] : []),
        ...((kesAgg._count as any)?._all > 0 ? [buildCurrencySummary(kesAgg, completedKesAgg, 'KES')] : []),
      ],
    },
  });
}

export async function getAdminPendingTransactions(req: Request, res: Response): Promise<void> {
  const page  = Math.max(1, parseInt(req.query.page  as string) || 1);
  const limit = Math.min(100, Math.max(10, parseInt(req.query.limit as string) || 50));
  const skip  = (page - 1) * limit;

  const status   = req.query.status  as string | undefined;
  const type     = req.query.type    as string | undefined;
  const search   = (req.query.search as string)?.trim() || '';
  const churchId = req.query.churchId as string | undefined;
  const ministry = req.query.ministry as string | undefined;
  const dateFrom = req.query.dateFrom as string | undefined;
  const dateTo   = req.query.dateTo   as string | undefined;

  const where: any = {};
  if (status) {
    where.status = status === 'completed' ? '__no_match__' : status;
  } else {
    where.status = { not: 'completed' };
  }
  if (type)   where.type   = type;
  if (dateFrom || dateTo) {
    where.createdAt = {};
    if (dateFrom) where.createdAt.gte = new Date(dateFrom);
    if (dateTo)   where.createdAt.lte = new Date(dateTo + 'T23:59:59Z');
  }
  if (search) {
    where.OR = [
      { reference: { contains: search } },
      { id:        { contains: search } },
    ];
  }

  // Ministry filter — resolve all churchIds belonging to this ministry admin
  if (ministry) {
    const ministryChurches = await prisma.church.findMany({
      where: { ministryAdminId: ministry },
      select: { id: true },
    });
    const ministryChurchIds = ministryChurches.map((c: any) => c.id);
    if (churchId) {
      // Intersect: only apply churchId if it belongs to the ministry
      where.churchId = ministryChurchIds.includes(churchId) ? churchId : '__no_match__';
    } else {
      where.churchId = { in: ministryChurchIds };
    }
  } else if (churchId) {
    where.churchId = churchId;
  }

  const [rows, total] = await Promise.all([
    prisma.pendingTransaction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.pendingTransaction.count({ where }),
  ]);

  // Resolve userId → user name/email in one batch
  const userIds = [...new Set(rows.map(r => r.userId).filter(Boolean))] as string[];
  const users = userIds.length
    ? await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, firstName: true, lastName: true, email: true },
      })
    : [];
  const userMap = Object.fromEntries(users.map(u => [u.id, u]));

  // Resolve churchId → church name in one batch
  const churchIds = [...new Set(rows.map(r => r.churchId).filter(Boolean))] as string[];
  const churches = churchIds.length
    ? await prisma.church.findMany({
        where: { id: { in: churchIds } },
        select: { id: true, name: true },
      })
    : [];
  const churchMap = Object.fromEntries(churches.map(c => [c.id, c.name]));

  const enriched = rows.map(r => ({
    ...r,
    user:       r.userId   ? (userMap[r.userId]   ?? null) : null,
    churchName: r.churchId ? (churchMap[r.churchId] ?? null) : null,
    // Parse metadata JSON so the frontend gets an object, not a raw string
    metadataParsed: (() => {
      try { return r.metadata ? JSON.parse(r.metadata) : null; } catch { return null; }
    })(),
  }));

  res.json({
    success: true,
    data: enriched,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
}
