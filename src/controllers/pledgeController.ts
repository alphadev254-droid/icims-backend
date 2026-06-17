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

  const { campaignId, pledgedAmount, fulfillmentDeadline, notes, pledgerName, pledgerEmail, pledgerPhone, onBehalfOfUserId } = parsed.data;

  const campaign = await prisma.givingCampaign.findUnique({ where: { id: campaignId } });
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

  const church = await prisma.church.findUnique({ where: { id: campaign.churchId }, select: { ministryAdminId: true } });
  const featureOwnerId = church?.ministryAdminId ?? null;
  if (!featureOwnerId || !(await hasFeature(featureOwnerId, 'pledges_management'))) {
    res.status(403).json({ success: false, message: 'Pledge management is not available on the current package.' });
    return;
  }

  const isMember = roleName === 'member';
  const pledgeUserId = isMember ? userId : (onBehalfOfUserId ?? null);

  if (isMember) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { churchId: true } });
    if (!user?.churchId || user.churchId !== campaign.churchId) {
      res.status(403).json({ success: false, message: 'You do not belong to this church' });
      return;
    }
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
    if (!accessibleChurchIds.includes(campaign.churchId)) {
      res.status(403).json({ success: false, message: 'Access denied to this church' });
      return;
    }
  }

  const pledge = await prisma.pledge.create({
    data: {
      campaignId,
      churchId: campaign.churchId,
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
        payments: {
          where: { status: 'completed' },
          select: { id: true, amount: true, currency: true, createdAt: true, paymentMethod: true },
          orderBy: { createdAt: 'desc' },
        },
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
  const status         = typeof req.query.status        === 'string' ? req.query.status        : undefined;
  const filterChurchId = typeof req.query.churchId      === 'string' ? req.query.churchId      : undefined;
  const startDate      = typeof req.query.startDate     === 'string' ? req.query.startDate     : undefined;
  const endDate        = typeof req.query.endDate       === 'string' ? req.query.endDate       : undefined;
  const sortBy         = typeof req.query.sortBy        === 'string' ? req.query.sortBy        : 'newest';
  const isExport       = req.query.export === 'true';
  const page           = Math.max(parseInt(typeof req.query.page  === 'string' ? req.query.page  : '1',  10) || 1, 1);
  const limit          = isExport ? 10000 : Math.min(parseInt(typeof req.query.limit === 'string' ? req.query.limit : '20', 10) || 20, 100);
  const skip           = isExport ? 0 : (page - 1) * limit;

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

  const where: any = {
    churchId: { in: accessibleChurchIds },
    ...(campaignId && { campaignId }),
    ...(status && status !== 'all' && { status }),
    ...(Object.keys(dateFilter).length > 0 && { createdAt: dateFilter }),
  };

  // Apply church filter only if it's within the accessible scope
  if (filterChurchId) {
    if (!accessibleChurchIds.includes(filterChurchId)) {
      res.json({ success: true, data: [], pagination: { page, limit, total: 0, totalPages: 0 }, summary: { totalPledged: 0, totalPaid: 0, outstanding: 0, count: 0 } });
      return;
    }
    where.churchId = filterChurchId;
  }

  const [pledges, total, allStats] = await Promise.all([
    prisma.pledge.findMany({
      where,
      orderBy: buildOrderBy(sortBy),
      skip,
      take: limit,
      include: {
        campaign: { select: { id: true, name: true, category: true, currency: true } },
        church: { select: { name: true } },
        user: {
          select: {
            firstName: true, lastName: true, email: true, phone: true,
            cellMemberships: {
              where: { status: { not: 'inactive' } },
              select: { cell: { select: { name: true } } },
              take: 1,
            },
          },
        },
        payments: {
          where: { status: 'completed' },
          select: { id: true, amount: true, currency: true, createdAt: true, paymentMethod: true },
          orderBy: { createdAt: 'desc' },
        },
      },
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
