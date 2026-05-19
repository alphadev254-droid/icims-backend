import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { getAccessibleChurchIds } from '../lib/churchScope';

export async function getTransactions(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const churchId = req.user?.churchId;
  const roleName = req.user?.role ?? 'member';
  
  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  // Pagination params
  const page  = Math.max(1, parseInt(req.query.page  as string) || 1);
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const skip  = (page - 1) * limit;

  // Search and filter params
  const search = (req.query.search as string)?.trim() || '';
  const type = req.query.type as string | undefined;
  const status = req.query.status as string | undefined;
  const paymentMethod = req.query.paymentMethod as string | undefined;
  const filterChurchId = req.query.churchId as string | undefined;
  const startDate = req.query.startDate as string | undefined;
  const endDate = req.query.endDate as string | undefined;

  let churchIds: string[] = [];

  if (roleName === 'member') {
    // Members see only their own transactions
    const whereClause: any = { userId };
    if (type) whereClause.type = type;
    if (status) whereClause.status = status;
    if (paymentMethod) whereClause.paymentMethod = paymentMethod;
    if (search) {
      whereClause.OR = [
        { user: { firstName: { contains: search } } },
        { user: { lastName: { contains: search } } },
        { user: { email: { contains: search } } },
      ];
    }
    if (startDate || endDate) {
      whereClause.createdAt = {};
      if (startDate) whereClause.createdAt.gte = new Date(startDate);
      if (endDate) whereClause.createdAt.lte = new Date(endDate);
    }

    const [transactions, total] = await Promise.all([
      prisma.transaction.findMany({
        where: whereClause,
        select: {
          id: true,
          amount: true,
          currency: true,
          status: true,
          type: true,
          paymentMethod: true,
          isManual: true,
          subaccountName: true,
          cardLast4: true,
          cardBank: true,
          baseAmount: true,
          gateway: true,
          isGuest: true,
          guestName: true,
          guestEmail: true,
          createdAt: true,
          church: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.transaction.count({ where: whereClause }),
    ]);
    res.json({ success: true, data: transactions, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
    return;
  } else {
    // All admin roles — use getAccessibleChurchIds which handles ministry_admin, sub-admins, etc.
    // Sub-admins have churchId: null in JWT but getAccessibleChurchIds resolves via ministryAdminId
    churchIds = await getAccessibleChurchIds(
      roleName,
      churchId,
      req.user?.districts,
      req.user?.traditionalAuthorities,
      req.user?.regions,
      userId,
    );

    if (churchIds.length === 0) {
      res.json({ success: true, data: [], pagination: { page, limit, total: 0, totalPages: 0 } });
      return;
    }
  }

  // Build where clause for admins
  const whereClause: any = { churchId: { in: churchIds } };
  if (filterChurchId && churchIds.includes(filterChurchId)) whereClause.churchId = filterChurchId;
  if (type) whereClause.type = type;
  if (status) whereClause.status = status;
  if (paymentMethod) whereClause.paymentMethod = paymentMethod;
  if (search) {
    whereClause.OR = [
      { user: { firstName: { contains: search } } },
      { user: { lastName: { contains: search } } },
      { user: { email: { contains: search } } },
    ];
  }
  if (startDate || endDate) {
    whereClause.createdAt = {};
    if (startDate) whereClause.createdAt.gte = new Date(startDate);
    if (endDate) whereClause.createdAt.lte = new Date(endDate);
  }

  const [transactions, total] = await Promise.all([
    prisma.transaction.findMany({
      where: whereClause,
      select: {
        id: true,
        amount: true,
        currency: true,
        status: true,
        type: true,
        paymentMethod: true,
        isManual: true,
        subaccountName: true,
        cardLast4: true,
        cardBank: true,
        baseAmount: true,
        gateway: true,
        isGuest: true,
        guestName: true,
        guestEmail: true,
        createdAt: true,
        user: { select: { firstName: true, lastName: true, email: true } },
        church: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.transaction.count({ where: whereClause }),
  ]);
  res.json({ success: true, data: transactions, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
}

export async function getTransaction(req: Request, res: Response): Promise<void> {
  const transaction = await prisma.transaction.findUnique({ 
    where: { id: String(req.params.id) },
    include: { 
      user: { select: { firstName: true, lastName: true, email: true } },
      church: { select: { name: true } },
      tickets: { include: { event: true } }
    }
  });
  if (!transaction) { res.status(404).json({ success: false, message: 'Transaction not found' }); return; }
  res.json({ success: true, data: transaction });
}

export async function updateTransactionStatus(req: Request, res: Response): Promise<void> {
  const { status } = req.body;
  if (!['pending', 'completed', 'failed', 'refunded'].includes(status)) {
    res.status(400).json({ success: false, message: 'Invalid status' });
    return;
  }

  const transaction = await prisma.transaction.update({
    where: { id: String(req.params.id) },
    data: { status },
  });
  res.json({ success: true, data: transaction });
}

// ─── GET /api/transactions/export — full export for CSV (admin only) ──────────

export async function exportTransactions(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const churchId = req.user?.churchId;
  const roleName = req.user?.role ?? 'member';

  if (!userId || roleName === 'member') {
    res.status(403).json({ success: false, message: 'Access denied' });
    return;
  }

  const type = req.query.type as string | undefined;
  const status = req.query.status as string | undefined;
  const startDate = req.query.startDate as string | undefined;
  const endDate = req.query.endDate as string | undefined;
  const filterChurchId = req.query.churchId as string | undefined;

  const churchIds = await getAccessibleChurchIds(
    roleName, churchId, req.user?.districts, req.user?.traditionalAuthorities, req.user?.regions, userId,
  );

  if (churchIds.length === 0) {
    res.json({ success: true, data: [] });
    return;
  }

  let scopedChurchIds = churchIds;
  if (filterChurchId) {
    if (!churchIds.includes(filterChurchId)) { res.json({ success: true, data: [] }); return; }
    scopedChurchIds = [filterChurchId];
  }

  const where: any = { churchId: { in: scopedChurchIds } };
  if (type) where.type = type;
  if (status) where.status = status;
  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = new Date(startDate);
    if (endDate) where.createdAt.lte = new Date(endDate);
  }

  const transactions = await prisma.transaction.findMany({
    where,
    select: {
      id: true, amount: true, currency: true, status: true, type: true,
      paymentMethod: true, isManual: true, isGuest: true,
      guestName: true, guestEmail: true,
      baseAmount: true, gateway: true, subaccountName: true,
      cardLast4: true, cardBank: true, reference: true, paidAt: true,
      createdAt: true,
      user: { select: { firstName: true, lastName: true, email: true } },
      church: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 10000,
  });

  // Enrich donation-type transactions with campaign name + category
  const donationTxIds = transactions.filter(t => t.type === 'donation').map(t => t.id);
  const donationDetails = donationTxIds.length > 0
    ? await prisma.donationTransaction.findMany({
        where: { transactionId: { in: donationTxIds } },
        select: { transactionId: true, campaign: { select: { name: true, category: true } } },
      })
    : [];
  const campaignMap = new Map(donationDetails.map((d: any) => [d.transactionId, d.campaign]));

  const enriched = transactions.map(t => ({
    ...t,
    campaignName: (campaignMap.get(t.id) as any)?.name ?? null,
    campaignCategory: (campaignMap.get(t.id) as any)?.category ?? null,
  }));

  res.json({ success: true, data: enriched });
}

// ─── GET /api/transactions/giving-by-member — giving totals per member ────────

export async function getGivingByMember(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const churchId = req.user?.churchId;
  const roleName = req.user?.role ?? 'member';

  if (!userId || roleName === 'member') {
    res.status(403).json({ success: false, message: 'Access denied' });
    return;
  }

  const filterChurchId = req.query.churchId as string | undefined;
  const startDate = req.query.startDate as string | undefined;
  const endDate = req.query.endDate as string | undefined;

  const churchIds = await getAccessibleChurchIds(
    roleName, churchId, req.user?.districts, req.user?.traditionalAuthorities, req.user?.regions, userId,
  );

  if (churchIds.length === 0) {
    res.json({ success: true, data: [] });
    return;
  }

  let scopedChurchIds = churchIds;
  if (filterChurchId) {
    if (!churchIds.includes(filterChurchId)) { res.json({ success: true, data: [] }); return; }
    scopedChurchIds = [filterChurchId];
  }

  const dateFilter: any = {};
  if (startDate) dateFilter.gte = new Date(startDate);
  if (endDate) dateFilter.lte = new Date(endDate);

  // Aggregate total giving per userId
  const grouped = await prisma.donationTransaction.groupBy({
    by: ['userId', 'churchId'],
    where: {
      churchId: { in: scopedChurchIds },
      status: 'completed',
      userId: { not: null },
      isGuest: false,
      isAnonymous: false,
      ...(Object.keys(dateFilter).length > 0 && { createdAt: dateFilter }),
    },
    _sum: { amount: true },
    _count: { id: true },
    orderBy: { _sum: { amount: 'desc' } },
    take: 10000,
  });

  if (grouped.length === 0) {
    res.json({ success: true, data: [] });
    return;
  }

  // Batch-fetch user names
  const userIds = grouped.map(g => g.userId!).filter(Boolean);
  const [users, churches] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, firstName: true, lastName: true, email: true, phone: true },
    }),
    prisma.church.findMany({
      where: { id: { in: scopedChurchIds } },
      select: { id: true, name: true },
    }),
  ]);

  const userMap = new Map(users.map(u => [u.id, u]));
  const churchMap = new Map(churches.map(c => [c.id, c.name]));

  const data = grouped.map(g => {
    const u = userMap.get(g.userId!);
    return {
      userId: g.userId,
      firstName: u?.firstName ?? '',
      lastName: u?.lastName ?? '',
      email: u?.email ?? '',
      phone: u?.phone ?? '',
      church: churchMap.get(g.churchId ?? '') ?? '',
      totalGiven: g._sum.amount ?? 0,
      donationCount: g._count.id,
    };
  });

  res.json({ success: true, data });
}
