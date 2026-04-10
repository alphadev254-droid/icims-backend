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
    revenueResult, malawiRevenueResult, kenyaRevenueResult,
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

  const adminIds = [...new Set(recentPayments.map((p: any) => p.ministryAdminId))];
  const admins = await prisma.user.findMany({
    where: { id: { in: adminIds } },
    select: { id: true, firstName: true, lastName: true, email: true },
  });
  const adminMap = Object.fromEntries(admins.map((a: any) => [a.id, a]));

  res.json({
    success: true,
    data: {
      totalUsers, totalChurches, totalMinistryAdmins, totalMembers,
      malawiUsers, kenyaUsers, activeUsers, suspendedUsers,
      activeSubscriptions, expiredSubscriptions,
      totalRevenue: revenueResult._sum.amount ?? 0,
      totalPayments: revenueResult._count,
      malawiRevenue: malawiRevenueResult._sum.amount ?? 0,
      malawiPayments: malawiRevenueResult._count,
      kenyaRevenue: kenyaRevenueResult._sum.amount ?? 0,
      kenyaPayments: kenyaRevenueResult._count,
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
    where.id = { in: await getUserIdsByCountry(countryFilter) };
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

  // Resolve country in one batch query
  const allAdminIds = new Set<string>();
  for (const u of users) {
    if (!u.accountCountry) {
      if (u.ministryAdminId) allAdminIds.add(u.ministryAdminId);
      else if ((u.church as any)?.ministryAdminId) allAdminIds.add((u.church as any).ministryAdminId);
    }
  }

  const adminCountryMap: Record<string, string | null> = {};
  if (allAdminIds.size > 0) {
    const adminList = await prisma.user.findMany({
      where: { id: { in: [...allAdminIds] } },
      select: { id: true, accountCountry: true },
    });
    for (const a of adminList) adminCountryMap[a.id] = a.accountCountry ?? null;
  }

  function resolveCountry(u: any): string | null {
    if (u.accountCountry) return u.accountCountry;
    if (u.ministryAdminId) return adminCountryMap[u.ministryAdminId] ?? null;
    const churchAdminId = (u.church as any)?.ministryAdminId;
    return churchAdminId ? (adminCountryMap[churchAdminId] ?? null) : null;
  }

  res.json({
    success: true,
    data: users.map(u => ({ ...safeUser(u), churchCount: u._count.ownedChurches, resolvedCountry: resolveCountry(u) })),
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
  phone: z.string().optional(),
  status: z.enum(['active', 'suspended', 'inactive']).optional(),
  accountCountry: z.enum(['Malawi', 'Kenya']).optional(),
});

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

  const updated = await prisma.user.update({
    where: { id },
    data: parsed.data,
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
    data: parsed.data,
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
  const dateFrom = req.query.dateFrom as string | undefined;
  const dateTo = req.query.dateTo as string | undefined;

  const where: any = {};

  if (search) {
    const matchingUsers = await prisma.user.findMany({
      where: { OR: [{ firstName: { contains: search } }, { lastName: { contains: search } }, { email: { contains: search } }] },
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

  if (countryFilter) {
    const countryAdmins = await prisma.user.findMany({ where: { accountCountry: countryFilter }, select: { id: true } });
    const countryAdminIds = countryAdmins.map((u: any) => u.id);
    if (where.ministryAdminId) {
      const searchIds = new Set(where.ministryAdminId.in);
      where.ministryAdminId = { in: countryAdminIds.filter((id: string) => searchIds.has(id)) };
    } else {
      where.ministryAdminId = { in: countryAdminIds };
    }
  }

  const [payments, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      include: { package: { select: { name: true, displayName: true } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.payment.count({ where }),
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

  // Specific church filter
  if (churchIdFilter) andConditions.push({ churchId: churchIdFilter });

  if (dateFrom || dateTo) {
    const dateCondition: any = {};
    if (dateFrom) dateCondition.gte = new Date(dateFrom);
    if (dateTo)   dateCondition.lte = new Date(dateTo + 'T23:59:59Z');
    andConditions.push({ createdAt: dateCondition });
  }

  const where: any = andConditions.length > 0 ? { AND: andConditions } : {};

  const [transactions, total, mwkAgg, kesAgg] = await Promise.all([
    prisma.transaction.findMany({
      where,
      select: {
        id: true,
        type: true,
        amount: true,
        baseAmount: true,
        convenienceFee: true,
        systemFeeAmount: true,
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
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.transaction.count({ where }),
    prisma.transaction.aggregate({
      where: { ...where, currency: 'MWK' },
      _sum: { baseAmount: true, systemFeeAmount: true, convenienceFee: true, totalAmount: true },
      _count: true,
    }),
    prisma.transaction.aggregate({
      where: { ...where, currency: 'KES' },
      _sum: { baseAmount: true, systemFeeAmount: true, convenienceFee: true, totalAmount: true },
      _count: true,
    }),
  ]);

  const buildCurrencySummary = (agg: typeof mwkAgg, currency: string) => ({
    currency,
    count: agg._count,
    totalBaseAmount:  agg._sum.baseAmount    ?? 0,
    totalSystemFee:   agg._sum.systemFeeAmount ?? 0,
    totalGatewayFee:  agg._sum.convenienceFee  ?? 0,
    totalCharged:     agg._sum.totalAmount   ?? 0,
  });

  res.json({
    success: true,
    data: transactions,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    summary: {
      total,
      byCurrency: [
        ...(mwkAgg._count > 0 ? [buildCurrencySummary(mwkAgg, 'MWK')] : []),
        ...(kesAgg._count > 0 ? [buildCurrencySummary(kesAgg, 'KES')] : []),
      ],
    },
  });
}
