import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { getAccessibleChurchIds } from '../lib/churchScope';
import { hasFeature } from '../lib/packageChecker';

// ─── Sort helper ──────────────────────────────────────────────────────────────

/**
 * Converts a sortBy query param into a Prisma orderBy clause.
 * Note: pct_desc / pct_asc sort by amountPaid / pledgedAmount ratio —
 * Prisma doesn't support computed sorts natively, so we approximate with
 * amountPaid (absolute) for those two and handle the true % sort in a
 * post-query step only when the result set is small (single page).
 */
function buildOrderBy(sortBy: string): object | object[] {
  switch (sortBy) {
    case 'oldest':       return { createdAt: 'asc' };
    case 'amount_desc':  return { pledgedAmount: 'desc' };
    case 'amount_asc':   return { pledgedAmount: 'asc' };
    case 'paid_desc':    return { amountPaid: 'desc' };   // most paid (absolute)
    case 'paid_asc':     return { amountPaid: 'asc' };    // least paid (absolute)
    case 'balance_desc': return [{ pledgedAmount: 'desc' }, { amountPaid: 'asc' }]; // largest outstanding approx
    case 'deadline_asc': return [{ fulfillmentDeadline: 'asc' }];
    case 'deadline_desc':return [{ fulfillmentDeadline: 'desc' }];
    case 'newest':
    default:             return { createdAt: 'desc' };
  }
}

function isBeforeToday(value: string): boolean {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return true;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);

  return date < today;
}

function campaignChurchIds(campaign: { churchId: string; linkedChurches?: Array<{ churchId: string }> }): string[] {
  const linked = campaign.linkedChurches?.map(link => link.churchId) ?? [];
  return [...new Set(linked.length > 0 ? linked : [campaign.churchId])];
}

function groupPledgeRowsByPersonCampaign(rows: any[]) {
  type GroupedPledgeRow = {
    pledgerKey: string;
    name: string;
    email: string;
    phone: string;
    pledgerType: string;
    campaign: string;
    category: string;
    church: string;
    currency: string;
    pledgedTotal: number;
    paidTotal: number;
    pledgeCount: number;
    statuses: Set<string>;
    earliestDeadline: Date | null;
    latestDeadline: Date | null;
    firstPledgeDate: Date | null;
    lastPledgeDate: Date | null;
  };

  const grouped = new Map<string, GroupedPledgeRow>();

  for (const row of rows) {
    const name = row.user
      ? `${row.user.firstName ?? ''} ${row.user.lastName ?? ''}`.trim() || 'Member'
      : row.pledgerName || 'Walk-in';
    const email = row.user?.email || row.pledgerEmail || '';
    const phone = row.user?.phone || row.pledgerPhone || '';
    const pledgerType = row.user ? 'Member' : 'Walk-in';
    const pledgerKey = row.user?.id || email || phone || name || row.id;
    const campaignName = row.campaign?.name || '';
    const category = row.campaign?.category || '';
    const churchName = row.church?.name || '';
    const currency = row.currency || row.campaign?.currency || '';
    const key = [pledgerType, pledgerKey, row.campaignId, campaignName, churchName, currency].join('|');

    const existing = grouped.get(key) ?? {
      pledgerKey,
      name,
      email,
      phone,
      pledgerType,
      campaign: campaignName,
      category,
      church: churchName,
      currency,
      pledgedTotal: 0,
      paidTotal: 0,
      pledgeCount: 0,
      statuses: new Set<string>(),
      earliestDeadline: null,
      latestDeadline: null,
      firstPledgeDate: null,
      lastPledgeDate: null,
    };

    existing.pledgedTotal += Number(row.pledgedAmount || 0);
    existing.paidTotal += Number(row.amountPaid || 0);
    existing.pledgeCount += 1;
    if (row.status) existing.statuses.add(row.status);

    const deadline = row.fulfillmentDeadline ? new Date(row.fulfillmentDeadline) : null;
    if (deadline) {
      if (!existing.earliestDeadline || deadline < existing.earliestDeadline) existing.earliestDeadline = deadline;
      if (!existing.latestDeadline || deadline > existing.latestDeadline) existing.latestDeadline = deadline;
    }

    const createdAt = row.createdAt ? new Date(row.createdAt) : null;
    if (createdAt) {
      if (!existing.firstPledgeDate || createdAt < existing.firstPledgeDate) existing.firstPledgeDate = createdAt;
      if (!existing.lastPledgeDate || createdAt > existing.lastPledgeDate) existing.lastPledgeDate = createdAt;
    }

    grouped.set(key, existing);
  }

  return Array.from(grouped.values())
    .map(row => ({
      pledgerKey: row.pledgerKey,
      name: row.name,
      email: row.email,
      phone: row.phone,
      pledgerType: row.pledgerType,
      campaign: row.campaign,
      category: row.category,
      church: row.church,
      currency: row.currency,
      pledgedTotal: row.pledgedTotal,
      paidTotal: row.paidTotal,
      outstandingTotal: row.pledgedTotal - row.paidTotal,
      pledgeCount: row.pledgeCount,
      statuses: Array.from(row.statuses).join('; '),
      earliestDeadline: row.earliestDeadline,
      latestDeadline: row.latestDeadline,
      firstPledgeDate: row.firstPledgeDate,
      lastPledgeDate: row.lastPledgeDate,
    }))
    .sort((a, b) => b.outstandingTotal - a.outstandingTotal || a.name.localeCompare(b.name) || a.campaign.localeCompare(b.campaign));
}

// ─── Recalculate pledge status ────────────────────────────────────────────────

/** Recalculate and persist pledge status after a payment is linked */
export async function recalculatePledgeStatus(pledgeId: string): Promise<void> {
  const pledge = await prisma.pledge.findUnique({ where: { id: pledgeId } });
  if (!pledge) return;

  const paid = await prisma.donationTransaction.aggregate({
    where: { pledgeId, status: 'completed' },
    _sum: { amount: true },
  });

  const amountPaid = paid._sum.amount ?? 0;
  const now = new Date();

  let status: string;
  if (amountPaid >= pledge.pledgedAmount) {
    status = 'fulfilled';
  } else if (amountPaid > 0) {
    status = pledge.fulfillmentDeadline && pledge.fulfillmentDeadline < now ? 'overdue' : 'partial';
  } else {
    status = pledge.fulfillmentDeadline && pledge.fulfillmentDeadline < now ? 'overdue' : 'pending';
  }

  await prisma.pledge.update({
    where: { id: pledgeId },
    data: { amountPaid, status },
  });
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const createPledgeSchema = z.object({
  campaignId: z.string().min(1, 'Campaign is required'),
  churchId: z.string().optional(),
  pledgedAmount: z.number().positive('Pledge amount must be greater than 0'),
  fulfillmentDeadline: z.string().optional(),
  notes: z.string().optional(),
  pledgerName: z.string().optional(),
  pledgerEmail: z.string().email().optional().or(z.literal('')),
  pledgerPhone: z.string().optional(),
  onBehalfOfUserId: z.string().optional(),
});

const updatePledgeSchema = z.object({
  pledgedAmount: z.number().positive('Pledge amount must be greater than 0').optional(),
  fulfillmentDeadline: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

const recordPledgePaymentSchema = z.object({
  amount: z.coerce.number().positive('Payment amount must be greater than 0'),
  paymentMethod: z.enum(['cash', 'bank_transfer', 'mobile_money', 'other']).default('cash'),
  reference: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  paidAt: z.string().optional().nullable(),
});

// ─── Create Pledge ────────────────────────────────────────────────────────────

export async function createPledge(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const roleName = req.user?.role;

  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  if (!roleName) {
    res.status(403).json({ success: false, message: 'Access denied' });
    return;
  }

  const parsed = createPledgeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const { campaignId, churchId: selectedChurchId, pledgedAmount, fulfillmentDeadline, notes, pledgerName, pledgerEmail, pledgerPhone, onBehalfOfUserId } = parsed.data;

  if (fulfillmentDeadline && isBeforeToday(fulfillmentDeadline)) {
    res.status(400).json({ success: false, message: 'Fulfillment deadline cannot be before today' });
    return;
  }

  const campaign = await prisma.givingCampaign.findUnique({
    where: { id: campaignId },
    include: { linkedChurches: { select: { churchId: true } } },
  });
  if (!campaign) {
    res.status(404).json({ success: false, message: 'Campaign not found' });
    return;
  }
  if (campaign.status !== 'active') {
    res.status(400).json({ success: false, message: 'Campaign is not active' });
    return;
  }
  if (!campaign.allowPledging) {
    res.status(400).json({ success: false, message: 'This campaign does not accept pledges' });
    return;
  }

  const availableChurchIds = campaignChurchIds(campaign);
  const isMember = roleName === 'member';
  const pledgeUserId = isMember ? userId : (onBehalfOfUserId ?? null);
  let resolvedChurchId = selectedChurchId || campaign.churchId;

  if (isMember) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { churchId: true } });
    if (!user?.churchId || !availableChurchIds.includes(user.churchId)) {
      res.status(403).json({ success: false, message: 'This campaign is not available for your church' });
      return;
    }
    resolvedChurchId = user.churchId;
    const existing = await prisma.pledge.findFirst({
      where: { campaignId, userId, status: { not: 'fulfilled' } },
    });
    if (existing) {
      res.status(409).json({ success: false, message: 'You already have an active pledge for this campaign' });
      return;
    }
  } else {
    const accessibleChurchIds = await getAccessibleChurchIds(
      roleName,
      req.user?.churchId,
      req.user?.districts,
      req.user?.traditionalAuthorities,
      req.user?.regions,
      userId
    );
    if (!availableChurchIds.includes(resolvedChurchId) || !accessibleChurchIds.includes(resolvedChurchId)) {
      res.status(403).json({ success: false, message: 'Access denied to this church' });
      return;
    }
  }

  const church = await prisma.church.findUnique({ where: { id: resolvedChurchId }, select: { ministryAdminId: true } });
  const featureOwnerId = church?.ministryAdminId ?? null;
  if (!featureOwnerId || !(await hasFeature(featureOwnerId, 'pledges_management'))) {
    res.status(403).json({ success: false, message: 'Pledge management is not available on the current package.' });
    return;
  }

  const pledge = await prisma.pledge.create({
    data: {
      campaignId,
      churchId: resolvedChurchId,
      userId: pledgeUserId,
      pledgerName: pledgeUserId ? null : (pledgerName ?? null),
      pledgerEmail: pledgeUserId ? null : (pledgerEmail || null),
      pledgerPhone: pledgeUserId ? null : (pledgerPhone ?? null),
      pledgedAmount,
      currency: campaign.currency,
      fulfillmentDeadline: fulfillmentDeadline ? new Date(fulfillmentDeadline) : null,
      notes: notes ?? null,
      createdById: userId,
    },
    include: {
      campaign: { select: { name: true, currency: true } },
      user: { select: { firstName: true, lastName: true, email: true } },
    },
  });

  res.status(201).json({ success: true, data: pledge });
}

// ─── Get My Pledges (member) ──────────────────────────────────────────────────

export async function getMyPledges(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const status  = typeof req.query.status  === 'string' ? req.query.status  : undefined;
  const sortBy  = typeof req.query.sortBy  === 'string' ? req.query.sortBy  : 'newest';
  const page    = Math.max(parseInt(typeof req.query.page  === 'string' ? req.query.page  : '1',  10) || 1, 1);
  const limit   = Math.min(parseInt(typeof req.query.limit === 'string' ? req.query.limit : '20', 10) || 20, 100);
  const skip    = (page - 1) * limit;

  const where: any = { userId };
  if (status && status !== 'all') where.status = status;

  const [pledges, total] = await Promise.all([
    prisma.pledge.findMany({
      where,
      orderBy: buildOrderBy(sortBy),
      skip,
      take: limit,
      include: {
        campaign: { select: { id: true, name: true, category: true, currency: true, status: true } },
        church: { select: { name: true } },
      },
    }),
    prisma.pledge.count({ where }),
  ]);

  res.json({
    success: true,
    data: pledges,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
}

// ─── Get Ministry Pledges (admin) ─────────────────────────────────────────────

export async function getMinistryPledges(req: Request, res: Response): Promise<void> {
  const userId   = req.user?.userId;
  const roleName = req.user?.role;

  if (!(await hasFeature(userId!, 'pledges_management'))) {
    res.status(403).json({ success: false, message: 'Pledge management is not available on your current package.' });
    return;
  }

  const campaignId     = typeof req.query.campaignId    === 'string' ? req.query.campaignId    : undefined;
  const category       = typeof req.query.category      === 'string' ? req.query.category      : undefined;
  const status         = typeof req.query.status        === 'string' ? req.query.status        : undefined;
  const filterChurchId = typeof req.query.churchId      === 'string' ? req.query.churchId      : undefined;
  const startDate      = typeof req.query.startDate     === 'string' ? req.query.startDate     : undefined;
  const endDate        = typeof req.query.endDate       === 'string' ? req.query.endDate       : undefined;
  const dueStartDate   = typeof req.query.dueStartDate  === 'string' ? req.query.dueStartDate  : undefined;
  const dueEndDate     = typeof req.query.dueEndDate    === 'string' ? req.query.dueEndDate    : undefined;
  const sortBy         = typeof req.query.sortBy        === 'string' ? req.query.sortBy        : 'newest';
  const isExport       = req.query.export === 'true';
  const groupByPersonCampaign = req.query.groupByPersonCampaign === 'true';
  const page           = Math.max(parseInt(typeof req.query.page  === 'string' ? req.query.page  : '1',  10) || 1, 1);
  const limit          = isExport
    ? Math.min(parseInt(typeof req.query.limit === 'string' ? req.query.limit : '10000', 10) || 10000, 10000)
    : Math.min(parseInt(typeof req.query.limit === 'string' ? req.query.limit : '20', 10) || 20, 100);
  const skip           = (page - 1) * limit;

  const accessibleChurchIds = await getAccessibleChurchIds(
    roleName!,
    req.user?.churchId,
    req.user?.districts,
    req.user?.traditionalAuthorities,
    req.user?.regions,
    userId
  );

  const dateFilter: any = {};
  if (startDate) dateFilter.gte = new Date(startDate);
  if (endDate) {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    dateFilter.lte = end;
  }

  const dueDateFilter: any = {};
  if (dueStartDate) dueDateFilter.gte = new Date(dueStartDate);
  if (dueEndDate) {
    const end = new Date(dueEndDate);
    end.setHours(23, 59, 59, 999);
    dueDateFilter.lte = end;
  }

  const where: any = {
    churchId: { in: accessibleChurchIds },
    ...(campaignId && { campaignId }),
    ...(category && category !== 'all' && { campaign: { is: { category } } }),
    ...(status && status !== 'all' && { status }),
    ...(Object.keys(dateFilter).length > 0 && { createdAt: dateFilter }),
    ...(Object.keys(dueDateFilter).length > 0 && { fulfillmentDeadline: dueDateFilter }),
  };

  // Apply church filter only if it's within the accessible scope
  if (filterChurchId) {
    if (!accessibleChurchIds.includes(filterChurchId)) {
      res.json({ success: true, data: [], pagination: { page, limit, total: 0, totalPages: 0 }, summary: { totalPledged: 0, totalPaid: 0, outstanding: 0, count: 0 } });
      return;
    }
    where.churchId = filterChurchId;
  }

  const pledgeInclude = {
    campaign: { select: { id: true, name: true, category: true, currency: true } },
    church: { select: { name: true } },
    user: {
      select: {
        id: true, firstName: true, lastName: true, email: true, phone: true,
      },
    },
  };

  if (groupByPersonCampaign) {
    const [allPledges, allStats] = await Promise.all([
      prisma.pledge.findMany({
        where,
        orderBy: buildOrderBy(sortBy),
        include: pledgeInclude,
        take: 50000,
      }),
      prisma.pledge.aggregate({
        where,
        _sum: { pledgedAmount: true, amountPaid: true },
        _count: { id: true },
      }),
    ]);

    const grouped = groupPledgeRowsByPersonCampaign(allPledges);
    const total = grouped.length;
    const totalPledged = allStats._sum.pledgedAmount ?? 0;
    const totalPaid = allStats._sum.amountPaid ?? 0;

    res.json({
      success: true,
      data: grouped.slice(skip, skip + limit),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      summary: { totalPledged, totalPaid, outstanding: totalPledged - totalPaid, count: allStats._count.id },
    });
    return;
  }

  const [pledges, total, allStats] = await Promise.all([
    prisma.pledge.findMany({
      where,
      orderBy: buildOrderBy(sortBy),
      skip,
      take: limit,
      include: pledgeInclude,
    }),
    prisma.pledge.count({ where }),
    // Summary always across ALL matching pledges (not just this page)
    prisma.pledge.aggregate({
      where,
      _sum: { pledgedAmount: true, amountPaid: true },
      _count: { id: true },
    }),
  ]);

  const totalPledged = allStats._sum.pledgedAmount ?? 0;
  const totalPaid    = allStats._sum.amountPaid    ?? 0;

  res.json({
    success: true,
    data: pledges,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    summary: { totalPledged, totalPaid, outstanding: totalPledged - totalPaid, count: allStats._count.id },
  });
}

// ─── Get single pledge ────────────────────────────────────────────────────────

export async function getPledge(req: Request, res: Response): Promise<void> {
  const userId   = req.user?.userId;
  const roleName = req.user?.role;
  const { id }   = req.params;

  const pledge = await prisma.pledge.findUnique({
    where: { id: String(id) },
    include: {
      campaign: { select: { id: true, name: true, category: true, currency: true, status: true, allowPledging: true } },
      church: { select: { name: true } },
      user: { select: { firstName: true, lastName: true, email: true, phone: true } },
      payments: {
        where: { status: 'completed' },
        select: { id: true, amount: true, currency: true, createdAt: true, paymentMethod: true, reference: true },
        orderBy: { createdAt: 'desc' },
      },
    },
  });

  if (!pledge) {
    res.status(404).json({ success: false, message: 'Pledge not found' });
    return;
  }

  if (roleName === 'member' && pledge.userId !== userId) {
    res.status(403).json({ success: false, message: 'Access denied' });
    return;
  }

  if (roleName !== 'member') {
    const accessibleChurchIds = await getAccessibleChurchIds(
      roleName!,
      req.user?.churchId,
      req.user?.districts,
      req.user?.traditionalAuthorities,
      req.user?.regions,
      userId
    );
    if (!accessibleChurchIds.includes(pledge.churchId)) {
      res.status(403).json({ success: false, message: 'Access denied' });
      return;
    }
  }

  res.json({ success: true, data: pledge });
}

// ─── Update pledge ─────────────────────────────────────────────────────────────

export async function recordPledgePayment(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const roleName = req.user?.role;
  const { id } = req.params;

  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  if (!roleName || roleName === 'member') {
    res.status(403).json({ success: false, message: 'Only admins can record manual pledge payments' });
    return;
  }

  const parsed = recordPledgePaymentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const pledge = await prisma.pledge.findUnique({
    where: { id: String(id) },
    include: {
      campaign: { select: { id: true, name: true, category: true, currency: true, status: true, allowPledging: true } },
      church: { select: { name: true } },
      user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
    },
  });

  if (!pledge) {
    res.status(404).json({ success: false, message: 'Pledge not found' });
    return;
  }

  const accessibleChurchIds = await getAccessibleChurchIds(
    roleName,
    req.user?.churchId,
    req.user?.districts,
    req.user?.traditionalAuthorities,
    req.user?.regions,
    userId
  );

  if (!accessibleChurchIds.includes(pledge.churchId)) {
    res.status(403).json({ success: false, message: 'Access denied' });
    return;
  }

  if (pledge.status === 'fulfilled') {
    res.status(400).json({ success: false, message: 'This pledge has already been fulfilled' });
    return;
  }

  const outstanding = Math.max(0, pledge.pledgedAmount - pledge.amountPaid);
  if (parsed.data.amount > outstanding) {
    res.status(400).json({
      success: false,
      message: `Payment cannot exceed the outstanding balance (${pledge.currency} ${outstanding.toLocaleString()})`,
    });
    return;
  }

  const paidAt = parsed.data.paidAt ? new Date(parsed.data.paidAt) : new Date();
  if (Number.isNaN(paidAt.getTime())) {
    res.status(400).json({ success: false, message: 'Invalid payment date' });
    return;
  }

  const reference = parsed.data.reference?.trim()
    || `PLEDGE-${parsed.data.paymentMethod.toUpperCase().replace(/_/g, '-')}-${Date.now()}`;
  const donorName = pledge.user
    ? `${pledge.user.firstName} ${pledge.user.lastName}`.trim()
    : (pledge.pledgerName ?? null);

  await prisma.donationTransaction.create({
    data: {
      campaignId: pledge.campaignId,
      churchId: pledge.churchId,
      userId: pledge.userId,
      amount: parsed.data.amount,
      currency: pledge.currency,
      paymentMethod: parsed.data.paymentMethod,
      reference,
      status: 'completed',
      isAnonymous: false,
      isGuest: !pledge.userId,
      guestName: pledge.userId ? null : (pledge.pledgerName ?? null),
      guestEmail: pledge.userId ? null : (pledge.pledgerEmail ?? null),
      guestPhone: pledge.userId ? null : (pledge.pledgerPhone ?? null),
      donorName,
      donorEmail: pledge.user?.email ?? pledge.pledgerEmail ?? null,
      donorPhone: pledge.user?.phone ?? pledge.pledgerPhone ?? null,
      notes: parsed.data.notes?.trim() || null,
      pledgeId: pledge.id,
      createdAt: paidAt,
    },
  });

  await recalculatePledgeStatus(pledge.id);

  const updated = await prisma.pledge.findUnique({
    where: { id: pledge.id },
    include: {
      campaign: { select: { id: true, name: true, category: true, currency: true, status: true, allowPledging: true } },
      church: { select: { name: true } },
      user: { select: { firstName: true, lastName: true, email: true, phone: true } },
      payments: {
        where: { status: 'completed' },
        select: { id: true, amount: true, currency: true, createdAt: true, paymentMethod: true, reference: true },
        orderBy: { createdAt: 'desc' },
      },
    },
  });

  res.status(201).json({ success: true, data: updated });
}

export async function updatePledge(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const roleName = req.user?.role;
  const { id } = req.params;

  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const parsed = updatePledgeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const existing = await prisma.pledge.findUnique({
    where: { id: String(id) },
    include: {
      campaign: { select: { id: true, name: true, category: true, currency: true, status: true, allowPledging: true } },
      church: { select: { name: true } },
      user: { select: { firstName: true, lastName: true, email: true, phone: true } },
      payments: {
        where: { status: 'completed' },
        select: { id: true, amount: true, currency: true, createdAt: true, paymentMethod: true, reference: true },
        orderBy: { createdAt: 'desc' },
      },
    },
  });

  if (!existing) {
    res.status(404).json({ success: false, message: 'Pledge not found' });
    return;
  }

  if (roleName === 'member') {
    if (existing.userId !== userId) {
      res.status(403).json({ success: false, message: 'Access denied' });
      return;
    }
  } else {
    const accessibleChurchIds = await getAccessibleChurchIds(
      roleName!,
      req.user?.churchId,
      req.user?.districts,
      req.user?.traditionalAuthorities,
      req.user?.regions,
      userId
    );
    if (!accessibleChurchIds.includes(existing.churchId)) {
      res.status(403).json({ success: false, message: 'Access denied' });
      return;
    }
  }

  if (existing.status === 'fulfilled') {
    res.status(400).json({ success: false, message: 'Fulfilled pledges cannot be edited' });
    return;
  }

  if (parsed.data.pledgedAmount !== undefined && parsed.data.pledgedAmount < existing.amountPaid) {
    res.status(400).json({
      success: false,
      message: `Pledge amount cannot be less than the amount already paid (${existing.currency} ${existing.amountPaid.toLocaleString()})`,
    });
    return;
  }

  if (parsed.data.fulfillmentDeadline && isBeforeToday(parsed.data.fulfillmentDeadline)) {
    res.status(400).json({ success: false, message: 'Fulfillment deadline cannot be before today' });
    return;
  }

  await prisma.pledge.update({
    where: { id: String(id) },
    data: {
      pledgedAmount: parsed.data.pledgedAmount,
      fulfillmentDeadline:
        parsed.data.fulfillmentDeadline === undefined
          ? undefined
          : parsed.data.fulfillmentDeadline
            ? new Date(parsed.data.fulfillmentDeadline)
            : null,
      notes: parsed.data.notes === undefined ? undefined : (parsed.data.notes || null),
    },
  });

  await recalculatePledgeStatus(String(id));

  const updated = await prisma.pledge.findUnique({
    where: { id: String(id) },
    include: {
      campaign: { select: { id: true, name: true, category: true, currency: true, status: true, allowPledging: true } },
      church: { select: { name: true } },
      user: { select: { firstName: true, lastName: true, email: true, phone: true } },
      payments: {
        where: { status: 'completed' },
        select: { id: true, amount: true, currency: true, createdAt: true, paymentMethod: true, reference: true },
        orderBy: { createdAt: 'desc' },
      },
    },
  });

  res.json({ success: true, data: updated });
}
