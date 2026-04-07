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

export async function getAdminStats(req: Request, res: Response): Promise<void> {
  // Resolve role IDs first to avoid Prisma relation filter issues in count()
  const [ministryAdminRole, memberRole] = await Promise.all([
    prisma.role.findUnique({ where: { name: 'ministry_admin' }, select: { id: true } }),
    prisma.role.findUnique({ where: { name: 'member' }, select: { id: true } }),
  ]);

  const [
    totalUsers,
    totalChurches,
    totalMinistryAdmins,
    totalMembers,
    malawiUsers,
    kenyaUsers,
    activeUsers,
    suspendedUsers,
    activeSubscriptions,
    expiredSubscriptions,
    revenueResult,
    malawiRevenueResult,
    kenyaRevenueResult,
    recentRegistrations,
    recentPayments,
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
    prisma.payment.aggregate({ where: { status: 'completed' }, _sum: { amount: true }, _count: true }),
    prisma.payment.aggregate({ where: { status: 'completed', currency: 'MWK' }, _sum: { amount: true }, _count: true }),
    prisma.payment.aggregate({ where: { status: 'completed', currency: 'KSH' }, _sum: { amount: true }, _count: true }),
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

  // Enrich recent payments with admin info
  const adminIds = [...new Set(recentPayments.map((p: any) => p.ministryAdminId))];
  const admins = await prisma.user.findMany({
    where: { id: { in: adminIds } },
    select: { id: true, firstName: true, lastName: true, email: true },
  });
  const adminMap = Object.fromEntries(admins.map((a: any) => [a.id, a]));

  res.json({
    success: true,
    data: {
      totalUsers,
      totalChurches,
      totalMinistryAdmins,
      totalMembers,
      malawiUsers,
      kenyaUsers,
      activeUsers,
      suspendedUsers,
      activeSubscriptions,
      expiredSubscriptions,
      totalRevenue: revenueResult._sum.amount ?? 0,
      totalPayments: revenueResult._count,
      malawiRevenue: malawiRevenueResult._sum.amount ?? 0,
      malawiPayments: malawiRevenueResult._count,
      kenyaRevenue: kenyaRevenueResult._sum.amount ?? 0,
      kenyaPayments: kenyaRevenueResult._count,
      recentRegistrations,
      recentPayments: recentPayments.map((p: any) => ({
        ...p,
        ministryAdmin: adminMap[p.ministryAdminId] ?? null,
      })),
    },
  });
}

// ─── Helper: resolve user IDs belonging to a country ────────────────────────
// 1 query to get admin IDs, then 2 parallel IN queries — O(1) round trips.
async function getUserIdsByCountry(country: string): Promise<string[]> {
  const admins = await prisma.user.findMany({
    where: { accountCountry: country },
    select: { id: true },
  });
  const adminIds = admins.map((a: any) => a.id);
  if (adminIds.length === 0) return [];

  // Parallel: users linked via ministryAdminId OR via church owned by those admins
  const [linkedUsers, churchUsers] = await Promise.all([
    prisma.user.findMany({
      where: { ministryAdminId: { in: adminIds } },
      select: { id: true },
    }),
    prisma.user.findMany({
      where: { church: { ministryAdminId: { in: adminIds } } },
      select: { id: true },
    }),
  ]);

  return [...new Set([
    ...adminIds,
    ...linkedUsers.map((u: any) => u.id),
    ...churchUsers.map((u: any) => u.id),
  ])];
}

// ─── GET /api/admin/users ─────────────────────────────────────────────────────

export async function getAdminUsers(req: Request, res: Response): Promise<void> {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(10, parseInt(req.query.limit as string) || 70));
  const skip = (page - 1) * limit;

  const search = (req.query.search as string)?.trim() || '';
  const roleFilter = req.query.role as string | undefined;
  const countryFilter = req.query.country as string | undefined;
  const statusFilter = req.query.status as string | undefined;

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
    const countryUserIds = await getUserIdsByCountry(countryFilter);
    // Intersect with any existing id filter, or set directly
    where.id = { in: countryUserIds };
  }
  if (statusFilter) where.status = statusFilter;

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      include: {
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

  // Resolve country for users missing accountCountry in one batch query.
  // Collect all ministry admin IDs needed: direct (ministryAdminId) + via church.
  const allAdminIds = new Set<string>();
  for (const u of users) {
    if (!u.accountCountry) {
      if (u.ministryAdminId) allAdminIds.add(u.ministryAdminId);
      else if ((u.church as any)?.ministryAdminId) allAdminIds.add((u.church as any).ministryAdminId);
    }
  }

  const adminCountryMap: Record<string, string | null> = {};
  if (allAdminIds.size > 0) {
    const admins = await prisma.user.findMany({
      where: { id: { in: [...allAdminIds] } },
      select: { id: true, accountCountry: true },
    });
    for (const a of admins) adminCountryMap[a.id] = a.accountCountry ?? null;
  }

  function resolveCountry(u: any): string | null {
    if (u.accountCountry) return u.accountCountry;
    if (u.ministryAdminId) return adminCountryMap[u.ministryAdminId] ?? null;
    const churchAdminId = u.church?.ministryAdminId;
    return churchAdminId ? (adminCountryMap[churchAdminId] ?? null) : null;
  }

  res.json({
    success: true,
    data: users.map(u => ({
      ...safeUser(u),
      churchCount: u._count.ownedChurches,
      resolvedCountry: resolveCountry(u),
    })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
}

// ─── GET /api/admin/users/:id ─────────────────────────────────────────────────

export async function getAdminUser(req: Request, res: Response): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: req.params.id },
    include: {
      role: { select: { id: true, name: true, displayName: true } },
      church: { select: { id: true, name: true } },
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

  if (!user) {
    res.status(404).json({ success: false, message: 'User not found' });
    return;
  }

  // Get all subscriptions if ministry_admin
  let subscriptions: any[] = [];
  let payments: any[] = [];
  if (user.role?.name === 'ministry_admin') {
    [subscriptions, payments] = await Promise.all([
      prisma.subscription.findMany({
        where: { ministryAdminId: user.id },
        include: { package: { select: { id: true, name: true, displayName: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.payment.findMany({
        where: { ministryAdminId: user.id },
        include: { package: { select: { name: true, displayName: true } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);
  }

  const activeSubscription = subscriptions.find((s: any) => s.status === 'active') ?? null;

  res.json({
    success: true,
    data: {
      ...safeUser(user),
      ownedChurches: user.ownedChurches,
      subscription: activeSubscription,
      subscriptions,
      payments,
    },
  });
}

// ─── PUT /api/admin/users/:id ─────────────────────────────────────────────────

const updateUserSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  status: z.enum(['active', 'suspended', 'inactive']).optional(),
  accountCountry: z.enum(['Malawi', 'Kenya']).optional(),
});

export async function updateAdminUser(req: Request, res: Response): Promise<void> {
  const target = await prisma.user.findUnique({
    where: { id: req.params.id },
    include: { role: { select: { name: true } } },
  });
  if (!target) {
    res.status(404).json({ success: false, message: 'User not found' });
    return;
  }
  if (target.role?.name === 'system_admin') {
    res.status(403).json({ success: false, message: 'Cannot modify another system admin' });
    return;
  }

  const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const updated = await prisma.user.update({
    where: { id: req.params.id },
    data: parsed.data,
    include: { role: { select: { id: true, name: true, displayName: true } } },
  });

  res.json({ success: true, data: safeUser(updated) });
}

// ─── DELETE /api/admin/users/:id ──────────────────────────────────────────────

export async function deleteAdminUser(req: Request, res: Response): Promise<void> {
  if (req.params.id === req.user?.userId) {
    res.status(400).json({ success: false, message: 'Cannot delete your own account' });
    return;
  }

  const target = await prisma.user.findUnique({
    where: { id: req.params.id },
    include: { role: true },
  });
  if (!target) {
    res.status(404).json({ success: false, message: 'User not found' });
    return;
  }
  if (target.role?.name === 'system_admin') {
    res.status(403).json({ success: false, message: 'Cannot delete a system admin' });
    return;
  }

  await prisma.user.delete({ where: { id: req.params.id } });
  res.json({ success: true, message: 'User deleted successfully' });
}

// ─── POST /api/admin/users/:id/reset-password ─────────────────────────────────

export async function resetAdminUserPassword(req: Request, res: Response): Promise<void> {
  const { password } = req.body;
  if (!password || password.length < 8) {
    res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
    return;
  }

  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) {
    res.status(404).json({ success: false, message: 'User not found' });
    return;
  }

  await prisma.user.update({
    where: { id: req.params.id },
    data: { password: await hashPassword(password) },
  });

  res.json({ success: true, message: 'Password reset successfully' });
}

// ─── GET /api/admin/churches/:id ──────────────────────────────────────────────

export async function getAdminChurch(req: Request, res: Response): Promise<void> {
  const church = await prisma.church.findUnique({
    where: { id: req.params.id },
    include: {
      ministryAdmin: {
        select: { id: true, firstName: true, lastName: true, email: true, phone: true, accountCountry: true },
      },
      _count: { select: { users: true, events: true, givingCampaigns: true } },
    },
  });

  if (!church) {
    res.status(404).json({ success: false, message: 'Church not found' });
    return;
  }

  // Get members with pagination
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(10, parseInt(req.query.limit as string) || 70));
  const skip = (page - 1) * limit;
  const search = (req.query.search as string)?.trim() || '';
  const roleFilter = req.query.role as string | undefined;
  const statusFilter = req.query.status as string | undefined;

  const userWhere: any = { churchId: church.id };
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

  const [users, userTotal] = await Promise.all([
    prisma.user.findMany({
      where: userWhere,
      include: { role: { select: { name: true, displayName: true } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.user.count({ where: userWhere }),
  ]);

  res.json({
    success: true,
    data: {
      ...church,
      users: users.map(safeUser),
      userPagination: { page, limit, total: userTotal, totalPages: Math.ceil(userTotal / limit) },
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
  const church = await prisma.church.findUnique({ where: { id: req.params.id } });
  if (!church) {
    res.status(404).json({ success: false, message: 'Church not found' });
    return;
  }

  const parsed = updateChurchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const updated = await prisma.church.update({
    where: { id: req.params.id },
    data: parsed.data,
  });

  res.json({ success: true, data: updated });
}

// ─── DELETE /api/admin/churches/:id ───────────────────────────────────────────

export async function deleteAdminChurch(req: Request, res: Response): Promise<void> {
  const church = await prisma.church.findUnique({ where: { id: req.params.id } });
  if (!church) {
    res.status(404).json({ success: false, message: 'Church not found' });
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.event.deleteMany({ where: { churchId: church.id } });
    await tx.givingCampaign.deleteMany({ where: { churchId: church.id } });
    await tx.donationTransaction.deleteMany({ where: { churchId: church.id } });
    await tx.attendance.deleteMany({ where: { churchId: church.id } });
    await tx.meeting.deleteMany({ where: { churchId: church.id } });
    await tx.announcement.deleteMany({ where: { churchId: church.id } });
    await tx.resource.deleteMany({ where: { churchId: church.id } });
    await tx.transaction.deleteMany({ where: { churchId: church.id } });
    await tx.user.updateMany({ where: { churchId: church.id }, data: { churchId: null } });
    await tx.church.delete({ where: { id: church.id } });
  });

  res.json({ success: true, message: 'Church deleted successfully' });
}

// ─── PUT /api/admin/church-users/:id — action on a church member ──────────────

export async function updateAdminChurchUser(req: Request, res: Response): Promise<void> {
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) {
    res.status(404).json({ success: false, message: 'User not found' });
    return;
  }

  const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const updated = await prisma.user.update({
    where: { id: req.params.id },
    data: parsed.data,
    include: { role: { select: { name: true, displayName: true } } },
  });

  res.json({ success: true, data: safeUser(updated) });
}

// ─── POST /api/admin/users/:id/send-email ────────────────────────────────────

export async function sendEmailToUser(req: Request, res: Response): Promise<void> {
  const { subject, message } = req.body;
  if (!subject?.trim() || !message?.trim()) {
    res.status(400).json({ success: false, message: 'Subject and message are required' });
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: req.params.id },
    select: { id: true, firstName: true, email: true },
  });
  if (!user) {
    res.status(404).json({ success: false, message: 'User not found' });
    return;
  }

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

// ─── POST /api/admin/users/:id/subscription — create or replace subscription ──────

const subscriptionSchema = z.object({
  packageId: z.string().min(1, 'Package is required'),
  startsAt: z.string().min(1, 'Start date is required'),
  expiresAt: z.string().min(1, 'Expiry date is required'),
  status: z.enum(['active', 'expired', 'cancelled']).default('active'),
});

export async function manageAdminSubscription(req: Request, res: Response): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: req.params.id },
    include: { role: true },
  });
  if (!user) {
    res.status(404).json({ success: false, message: 'User not found' });
    return;
  }
  if (user.role?.name !== 'ministry_admin') {
    res.status(400).json({ success: false, message: 'Subscriptions only apply to ministry admins' });
    return;
  }

  const parsed = subscriptionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const pkg = await prisma.package.findUnique({ where: { id: parsed.data.packageId } });
  if (!pkg) {
    res.status(404).json({ success: false, message: 'Package not found' });
    return;
  }

  // Expire all existing active subscriptions first
  await prisma.subscription.updateMany({
    where: { ministryAdminId: user.id, status: 'active' },
    data: { status: 'expired' },
  });

  const subscription = await prisma.subscription.create({
    data: {
      ministryAdminId: user.id,
      packageId: parsed.data.packageId,
      status: parsed.data.status,
      startsAt: new Date(parsed.data.startsAt),
      expiresAt: new Date(parsed.data.expiresAt),
    },
    include: { package: { select: { id: true, name: true, displayName: true } } },
  });

  res.status(201).json({ success: true, data: subscription });
}

// ─── PUT /api/admin/users/:id/subscription/:subId — update existing subscription ───

export async function updateAdminSubscription(req: Request, res: Response): Promise<void> {
  const sub = await prisma.subscription.findUnique({ where: { id: req.params.subId } });
  if (!sub || sub.ministryAdminId !== req.params.id) {
    res.status(404).json({ success: false, message: 'Subscription not found' });
    return;
  }

  const parsed = subscriptionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  // If activating this sub, expire others
  if (parsed.data.status === 'active') {
    await prisma.subscription.updateMany({
      where: { ministryAdminId: req.params.id, status: 'active', id: { not: sub.id } },
      data: { status: 'expired' },
    });
  }

  const updated = await prisma.subscription.update({
    where: { id: sub.id },
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

// ─── GET /api/admin/transactions — all package payment transactions ─────────────

export async function getAdminTransactions(req: Request, res: Response): Promise<void> {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(10, parseInt(req.query.limit as string) || 70));
  const skip = (page - 1) * limit;

  const search = (req.query.search as string)?.trim() || '';
  const packageFilter = req.query.package as string | undefined;
  const statusFilter = req.query.status as string | undefined;
  const countryFilter = req.query.country as string | undefined;
  const dateFrom = req.query.dateFrom as string | undefined;
  const dateTo = req.query.dateTo as string | undefined;

  const where: any = {};

  if (search) {
    // Search by ministry admin name or email
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
    where.ministryAdminId = { in: matchingUsers.map((u: any) => u.id) };
  }

  if (packageFilter) where.packageName = packageFilter;
  if (statusFilter) where.status = statusFilter;
  if (dateFrom || dateTo) {
    where.createdAt = {};
    if (dateFrom) where.createdAt.gte = new Date(dateFrom);
    if (dateTo) where.createdAt.lte = new Date(dateTo + 'T23:59:59Z');
  }

  // Country filter: join through user
  let ministryAdminIds: string[] | undefined;
  if (countryFilter) {
    const users = await prisma.user.findMany({
      where: { accountCountry: countryFilter },
      select: { id: true },
    });
    ministryAdminIds = users.map((u: any) => u.id);
    if (where.ministryAdminId) {
      // Intersect with search results
      const searchIds = new Set(where.ministryAdminId.in);
      where.ministryAdminId = { in: ministryAdminIds.filter((id: string) => searchIds.has(id)) };
    } else {
      where.ministryAdminId = { in: ministryAdminIds };
    }
  }

  const [payments, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      include: {
        package: { select: { name: true, displayName: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.payment.count({ where }),
  ]);

  // Enrich with ministry admin info
  const adminIds = [...new Set(payments.map((p: any) => p.ministryAdminId))];
  const admins = await prisma.user.findMany({
    where: { id: { in: adminIds } },
    select: { id: true, firstName: true, lastName: true, email: true, accountCountry: true },
  });
  const adminMap = Object.fromEntries(admins.map((a: any) => [a.id, a]));

  res.json({
    success: true,
    data: payments.map((p: any) => ({
      ...p,
      ministryAdmin: adminMap[p.ministryAdminId] ?? null,
    })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
}
