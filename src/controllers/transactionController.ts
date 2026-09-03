import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { getAccessibleChurchIds } from '../lib/churchScope';

function groupDonationDetails(rows: any[]) {
  const grouped = new Map<string, any[]>();

  for (const row of rows) {
    if (!row.transactionId) continue;
    if (!grouped.has(row.transactionId)) grouped.set(row.transactionId, []);
    grouped.get(row.transactionId)!.push({
      campaignId: row.campaignId,
      campaignName: row.campaign?.name ?? null,
      campaignCategory: row.campaign?.category ?? null,
      amount: row.amount,
      currency: row.currency,
      churchId: row.churchId ?? null,
      churchName: row.church?.name ?? null,
      cellName: row.cell?.name ?? null,
    });
  }

  return grouped;
}

function enrichDonationTransaction(transaction: any, donationLinesByTx: Map<string, any[]>) {
  const donationLines = donationLinesByTx.get(transaction.id) ?? [];
  const firstLine = donationLines[0];
  const isMultiLine = donationLines.length > 1;

  return {
    ...transaction,
    campaignName: isMultiLine ? 'Multiple giving items' : firstLine?.campaignName ?? null,
    campaignCategory: isMultiLine ? 'multiple' : firstLine?.campaignCategory ?? null,
    cellName: isMultiLine ? null : firstLine?.cellName ?? null,
    donationLines,
    isMultiDonation: isMultiLine,
  };
}

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
  const campaignId = req.query.campaignId as string | undefined;
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
          reference: true,
          notes: true,
          createdAt: true,
          church: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.transaction.count({ where: whereClause }),
    ]);

    const txList = transactions as any[];
    const donationTxIds = txList.filter(t => t.type === 'donation').map((t: any) => t.id);
    const donationDetails = donationTxIds.length > 0
      ? await prisma.donationTransaction.findMany({
          where: { transactionId: { in: donationTxIds } },
          select: { transactionId: true, campaignId: true, churchId: true, amount: true, currency: true, campaign: { select: { name: true, category: true } }, church: { select: { name: true } }, cell: { select: { name: true } } },
        })
      : [];
    const donationLinesByTx = groupDonationDetails(donationDetails);
    const eventTxIds = txList.filter(t => t.type === 'event_ticket').map((t: any) => t.id);
    const eventDetails = eventTxIds.length > 0
      ? await prisma.eventTicket.findMany({
          where: { transactionId: { in: eventTxIds } },
          select: { transactionId: true, event: { select: { title: true } } },
        })
      : [];
    const eventMap = new Map(eventDetails.map((e: any) => [e.transactionId, e]));
    const enriched = txList.map(t => ({
      ...enrichDonationTransaction(t, donationLinesByTx),
      eventTitle: (eventMap.get(t.id) as any)?.event?.title ?? null,
    }));

    res.json({ success: true, data: enriched, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
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
  if (filterChurchId) {
    if (!churchIds.includes(filterChurchId)) {
      res.json({ success: true, data: [], pagination: { page, limit, total: 0, totalPages: 0 } });
      return;
    }
    whereClause.churchId = filterChurchId;
  }
  if (type) whereClause.type = type;
  if (status) whereClause.status = status;
  if (paymentMethod) whereClause.paymentMethod = paymentMethod;
  if (campaignId) {
    whereClause.type = 'donation';
    const donationRows = await prisma.donationTransaction.findMany({
      where: { campaignId, churchId: { in: churchIds } },
      select: { transactionId: true },
    });
    const transactionIds = donationRows.map(row => row.transactionId).filter(Boolean) as string[];
    whereClause.id = transactionIds.length ? { in: transactionIds } : { in: ['__no_matching_campaign_transactions__'] };
  }
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
        reference: true,
        notes: true,
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

  const txList = transactions as any[];
  const donationTxIds = txList.filter(t => t.type === 'donation').map((t: any) => t.id);
  const donationDetails = donationTxIds.length > 0
    ? await prisma.donationTransaction.findMany({
        where: { transactionId: { in: donationTxIds } },
        select: { transactionId: true, campaignId: true, churchId: true, amount: true, currency: true, campaign: { select: { name: true, category: true } }, church: { select: { name: true } }, cell: { select: { name: true } } },
      })
    : [];
  const donationLinesByTx = groupDonationDetails(donationDetails);
  const eventTxIds = txList.filter(t => t.type === 'event_ticket').map((t: any) => t.id);
  const eventDetails = eventTxIds.length > 0
    ? await prisma.eventTicket.findMany({
        where: { transactionId: { in: eventTxIds } },
        select: { transactionId: true, event: { select: { title: true } } },
      })
    : [];
  const eventMap = new Map(eventDetails.map((e: any) => [e.transactionId, e]));
  const enriched = txList.map(t => ({
    ...enrichDonationTransaction(t, donationLinesByTx),
    eventTitle: (eventMap.get(t.id) as any)?.event?.title ?? null,
  }));

  res.json({ success: true, data: enriched, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
}

export async function getTransaction(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id);
  const transaction = await prisma.transaction.findUnique({ 
    where: { id },
    include: { 
      user: { select: { firstName: true, lastName: true, email: true } },
      church: { select: { name: true } },
      tickets: { include: { event: true } }
    }
  });
  if (!transaction) { res.status(404).json({ success: false, message: 'Transaction not found' }); return; }

  if (transaction.type !== 'donation') {
    res.json({ success: true, data: transaction });
    return;
  }

  const donationRows = await prisma.donationTransaction.findMany({
    where: { transactionId: id },
    select: {
      transactionId: true,
      campaignId: true,
      amount: true,
      currency: true,
      campaign: { select: { name: true, category: true } },
      cell: { select: { name: true } },
    },
  });

  const donationLinesByTx = groupDonationDetails(donationRows);
  res.json({ success: true, data: enrichDonationTransaction(transaction, donationLinesByTx) });
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
  const campaignId = req.query.campaignId as string | undefined;
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(parseInt(req.query.limit as string) || 5000, 5000);
  const skip = (page - 1) * limit;

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
  if (campaignId) {
    where.type = 'donation';
    const donationRows = await prisma.donationTransaction.findMany({
      where: { campaignId, churchId: { in: scopedChurchIds } },
      select: { transactionId: true },
    });
    const transactionIds = donationRows.map(row => row.transactionId).filter(Boolean) as string[];
    where.id = transactionIds.length ? { in: transactionIds } : { in: ['__no_matching_campaign_transactions__'] };
  }
  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = new Date(startDate);
    if (endDate) where.createdAt.lte = new Date(endDate);
  }

  const [transactions, total] = await Promise.all([
    prisma.transaction.findMany({
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
      skip,
      take: limit,
    }),
    prisma.transaction.count({ where }),
  ]);

  // Enrich donation-type transactions with campaign name + category
  const donationTxIds = transactions.filter(t => t.type === 'donation').map(t => t.id);
  const donationDetails = donationTxIds.length > 0
    ? await prisma.donationTransaction.findMany({
        where: { transactionId: { in: donationTxIds } },
        select: { transactionId: true, campaignId: true, churchId: true, amount: true, currency: true, campaign: { select: { name: true, category: true } }, church: { select: { name: true } }, cell: { select: { name: true } } },
      })
    : [];
  const donationLinesByTx = groupDonationDetails(donationDetails);

  // Enrich event-ticket transactions with event title
  const eventTxIds = transactions.filter(t => t.type === 'event_ticket').map(t => t.id);
  const eventDetails = eventTxIds.length > 0
    ? await prisma.eventTicket.findMany({
        where: { transactionId: { in: eventTxIds } },
        select: { transactionId: true, event: { select: { title: true } } },
      })
    : [];
  const eventMap = new Map(eventDetails.map((e: any) => [e.transactionId, e]));

  const enriched = transactions.map(t => ({
    ...enrichDonationTransaction(t, donationLinesByTx),
    eventTitle: (eventMap.get(t.id) as any)?.event?.title ?? null,
  }));

  res.json({ success: true, data: enriched, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
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
  const campaignId = req.query.campaignId as string | undefined;
  const category = req.query.category as string | undefined;
  const groupByCampaign = req.query.groupByCampaign === 'true';
  const startDate = req.query.startDate as string | undefined;
  const endDate = req.query.endDate as string | undefined;
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(parseInt(req.query.limit as string) || 10000, 10000);

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
  if (endDate) {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    dateFilter.lte = end;
  }

  const donationWhere: any = {
    churchId: { in: scopedChurchIds },
    status: 'completed',
    userId: { not: null },
    isGuest: false,
    isAnonymous: false,
    ...(campaignId && { campaignId }),
    ...(category && category !== 'all' && { campaign: { is: { category } } }),
    ...(Object.keys(dateFilter).length > 0 && { createdAt: dateFilter }),
  };

  // Aggregate giving per member, optionally split by campaign.
  const grouped = groupByCampaign
    ? await prisma.donationTransaction.groupBy({
        by: ['userId', 'churchId', 'campaignId', 'currency'],
        where: donationWhere,
        _sum: { amount: true },
        _count: { id: true },
        orderBy: { _sum: { amount: 'desc' } },
        take: 10000,
      })
    : await prisma.donationTransaction.groupBy({
        by: ['userId', 'churchId', 'currency'],
        where: donationWhere,
        _sum: { amount: true },
        _count: { id: true },
        orderBy: { _sum: { amount: 'desc' } },
        take: 10000,
      });

  if (grouped.length === 0) {
    res.json({ success: true, data: [], pagination: { page, limit, total: 0, totalPages: 0 } });
    return;
  }

  // Batch-fetch all enrichment data in parallel
  const userIds = grouped.map(g => g.userId!).filter(Boolean);
  const campaignIds = groupByCampaign
    ? [...new Set(grouped.map((g: any) => g.campaignId).filter(Boolean))]
    : [];
  const [users, churches, campaigns, userCampaigns] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: userIds } },
      select: {
        id: true, firstName: true, lastName: true, email: true, phone: true,
        gender: true, membershipType: true, status: true,
        cellMemberships: {
          where: { status: { not: 'inactive' } },
          select: { cell: { select: { name: true } } },
          take: 1,
        },
      },
    }),
    prisma.church.findMany({
      where: { id: { in: scopedChurchIds } },
      select: { id: true, name: true },
    }),
    campaignIds.length > 0
      ? prisma.givingCampaign.findMany({
          where: { id: { in: campaignIds } },
          select: { id: true, name: true, category: true },
        })
      : Promise.resolve([]),
    prisma.donationTransaction.findMany({
      where: {
        ...donationWhere,
        userId: { in: userIds },
      },
      select: { userId: true, campaignId: true, campaign: { select: { name: true } } },
      distinct: ['userId', 'campaignId'],
    }),
  ]);
  const userMap = new Map(users.map(u => [u.id, u]));
  const churchMap = new Map(churches.map(c => [c.id, c.name]));
  const campaignMap = new Map(campaigns.map(c => [c.id, c]));
  const campaignsByUser = new Map<string, string[]>();
  for (const uc of userCampaigns) {
    if (!uc.userId) continue;
    if (!campaignsByUser.has(uc.userId)) campaignsByUser.set(uc.userId, []);
    const name = (uc as any).campaign?.name;
    if (name) campaignsByUser.get(uc.userId)!.push(name);
  }

  const data = grouped.map(g => {
    const u = userMap.get(g.userId!) as any;
    const campaign = groupByCampaign ? campaignMap.get((g as any).campaignId) : null;
    return {
      userId: g.userId,
      firstName: u?.firstName ?? '',
      lastName: u?.lastName ?? '',
      email: u?.email ?? '',
      phone: u?.phone ?? '',
      gender: u?.gender ?? '',
      membershipType: u?.membershipType ?? '',
      status: u?.status ?? '',
      cell: u?.cellMemberships?.[0]?.cell?.name ?? '',
      church: churchMap.get(g.churchId ?? '') ?? '',
      campaignId: groupByCampaign ? (g as any).campaignId : undefined,
      campaign: campaign?.name ?? '',
      campaignCategory: campaign?.category ?? '',
      campaigns: groupByCampaign ? (campaign?.name ?? '') : (campaignsByUser.get(g.userId!)?.join('; ') ?? ''),
      currency: (g as any).currency ?? '',
      totalGiven: g._sum.amount ?? 0,
      transactionCount: g._count.id,
    };
  });

  const total = data.length;
  const pagedData = data.slice((page - 1) * limit, page * limit);
  res.json({ success: true, data: pagedData, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
}
