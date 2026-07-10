import { Request, Response } from 'express';
import { z } from 'zod';
import axios from 'axios';
import prisma from '../lib/prisma';
import { groupByDateRanges } from '../lib/dateGrouping';
import { getAccessibleChurchIds } from '../lib/churchScope';
import { queueChurchPush } from '../lib/notificationQueue';
import { queueChurchMemberEmails } from '../lib/churchMemberEmail';
import { givingCampaignCreatedTemplate } from '../lib/emailTemplates';

const createCampaignSchema = z.object({
  churchId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  category: z.enum(['tithe', 'offering', 'partnership', 'welfare', 'missions', 'fellowship_offering']),
  subcategory: z.string().optional(),
  targetAmount: z.number().positive().optional().or(z.literal(0)).or(z.nan()).transform(val => val && val > 0 ? val : undefined),
  currency: z.enum(['MWK', 'KES']).default('MWK'),
  endDate: z.string().optional(),
  imageUrl: z.string().optional(),
});

const updateCampaignSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  category: z.enum(['tithe', 'offering', 'partnership', 'welfare', 'missions', 'fellowship_offering']).optional(),
  subcategory: z.string().optional(),
  targetAmount: z.number().positive().optional().or(z.literal(0)).or(z.nan()).transform(val => val && val > 0 ? val : undefined),
  currency: z.enum(['MWK', 'KES']).optional(),
  status: z.enum(['active', 'completed', 'cancelled']).optional(),
  endDate: z.string().optional(),
  imageUrl: z.string().optional(),
  allowPublicDonations: z.boolean().optional(),
  allowPledging: z.boolean().optional(),
});

export async function createCampaign(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const churchId = req.user?.churchId;
  const roleName = req.user?.role;

  // Check if user has giving_tracking feature
  const { hasFeature, checkLimit } = await import('../lib/packageChecker');
  if (!(await hasFeature(userId!, 'giving_tracking'))) {
    res.status(403).json({ success: false, message: 'Your package does not include Giving & Donations. Please upgrade to access this feature.' });
    return;
  }

  const parsed = createCampaignSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const { churchId: targetChurchId, endDate, ...data } = parsed.data;

  // Check maxGivings limit
  let ministryAdminId: string | null = roleName === 'ministry_admin' ? userId! : null;
  if (!ministryAdminId) {
    const u = await prisma.user.findUnique({ where: { id: userId! }, select: { ministryAdminId: true } });
    ministryAdminId = u?.ministryAdminId ?? null;
  }
  if (ministryAdminId) {
    const churches = await prisma.church.findMany({ where: { ministryAdminId }, select: { id: true } });
    const churchIds = churches.map((c: { id: string }) => c.id);
    const currentCampaigns = await prisma.givingCampaign.count({ where: { churchId: { in: churchIds }, status: 'active' } });
    const limitCheck = await checkLimit(ministryAdminId, 'max_givings', currentCampaigns);
    if (!limitCheck.allowed) {
      res.status(403).json({ success: false, message: limitCheck.message });
      return;
    }
  }

  // Check if Kenya account has subaccount for receiving donations
  const { getPaymentGateway } = await import('../utils/gatewayRouter');
  const gateway = await getPaymentGateway(userId!);
  
  if (gateway === 'paystack') {
    // Kenya account - check for subaccount
    const subaccount = await prisma.subaccount.findUnique({
      where: { churchId: targetChurchId }
    });
    
    if (!subaccount) {
      res.status(400).json({ 
        success: false, 
        message: 'To create giving campaigns, you need to set up a Paystack subaccount first. Please go to Branches > Finance account management to create your finance account.' 
      });
      return;
    }
  }

  // Verify user has access to this church
  const accessibleChurchIds = await getAccessibleChurchIds(
    roleName!,
    churchId,
    req.user?.districts,
    req.user?.traditionalAuthorities,
    req.user?.regions,
    userId
  );

  if (!accessibleChurchIds.includes(targetChurchId)) {
    res.status(403).json({ success: false, message: 'Access denied to this church' });
    return;
  }

  const campaign = await prisma.givingCampaign.create({
    data: {
      ...data,
      churchId: targetChurchId,
      endDate: endDate ? new Date(endDate) : null,
      allowPublicDonations: (req.body.allowPublicDonations === true || req.body.allowPublicDonations === 'true') ? true : false,
      allowPledging: (req.body.allowPledging === true || req.body.allowPledging === 'true') ? true : false,
    },
  });

  res.status(201).json({ success: true, data: campaign });

  // Fire-and-forget: worker resolves members and sends push off the request cycle
  const church = await prisma.church.findUnique({ where: { id: targetChurchId }, select: { name: true } });
  queueChurchPush(
    targetChurchId,
    `${church?.name || 'Your Church'} · New Giving Campaign`,
    `${campaign.name} — ${campaign.category.replace('_', ' ')}`,
    { type: 'giving_campaign_created', campaignId: campaign.id, churchId: targetChurchId }
  ).catch(err => console.error('[Giving] Failed to queue push:', err));

  queueChurchMemberEmails({
    churchId: targetChurchId,
    subject: `${church?.name || 'Your Church'} - New Giving Campaign: ${campaign.name}`,
    buildHtml: member => givingCampaignCreatedTemplate({
      firstName: member.firstName,
      campaignName: campaign.name,
      category: campaign.category,
      currency: campaign.currency,
      targetAmount: campaign.targetAmount,
      endDate: campaign.endDate ? new Date(campaign.endDate).toLocaleDateString() : null,
      description: campaign.description,
      churchName: church?.name || 'Your Church',
    }),
    emailType: 'notification',
  }).catch(err => console.error('[Giving] Failed to queue member emails:', err));
}

export async function getCampaigns(req: Request, res: Response): Promise<void> {
  const userId   = req.user?.userId;
  const roleName = req.user?.role;
  const { category, status } = req.query;
  const filterChurchId = req.query.churchId as string | undefined;

  // Get user's accessible churches based on role — always ministry-scoped
  const accessibleChurchIds = await getAccessibleChurchIds(
    roleName!,
    req.user?.churchId,
    req.user?.districts,
    req.user?.traditionalAuthorities,
    req.user?.regions,
    userId
  );

  // If no accessible churches (e.g. member with no churchId in JWT), return empty
  if (accessibleChurchIds.length === 0) {
    res.json({ success: true, data: [] });
    return;
  }

  // filterChurchId: only allow if it's within the accessible scope
  let scopedChurchIds = accessibleChurchIds;
  if (filterChurchId) {
    if (!accessibleChurchIds.includes(filterChurchId)) {
      res.json({ success: true, data: [] });
      return;
    }
    scopedChurchIds = [filterChurchId];
  }

  // Members always see only active campaigns — ignore any status query param
  const statusFilter = roleName === 'member' ? 'active' : (status ? String(status) : undefined);

  const campaigns = await prisma.givingCampaign.findMany({
    where: {
      churchId: { in: scopedChurchIds },
      ...(category     && { category: String(category) }),
      ...(statusFilter && { status: statusFilter }),
    },
    include: {
      church: { select: { name: true } },
      _count: { select: { donations: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (campaigns.length === 0) {
    res.json({ success: true, data: [] });
    return;
  }

  const campaignIds = campaigns.map(c => c.id);

 const [raisedStats, memberDonorStats, guestDonorStats] = await Promise.all([
  // Total raised per campaign
  prisma.donationTransaction.groupBy({
    by: ['campaignId'],
    where: { campaignId: { in: campaignIds }, status: 'completed' },
    _sum: { amount: true },
  }),
  // Unique MEMBER donors (distinct userId)
  prisma.donationTransaction.findMany({
    where: { campaignId: { in: campaignIds }, status: 'completed', userId: { not: null } },
    select: { campaignId: true, userId: true },
    distinct: ['campaignId', 'userId'],
  }),
  // Unique GUEST donors (distinct by guestEmail per campaign)
  prisma.donationTransaction.findMany({
    where: { 
      campaignId: { in: campaignIds }, 
      status: 'completed', 
      userId: null,
      guestEmail: { not: null },
    },
    select: { campaignId: true, guestEmail: true },
    distinct: ['campaignId', 'guestEmail'],
  }),
]);

const raisedMap = new Map(raisedStats.map(r => [r.campaignId, r._sum.amount ?? 0]));

// Build donor count map combining members + unique guests per campaign
const donorCountMap = new Map<string, number>();

for (const d of memberDonorStats) {
  donorCountMap.set(d.campaignId, (donorCountMap.get(d.campaignId) ?? 0) + 1);
}
for (const d of guestDonorStats) {
  donorCountMap.set(d.campaignId, (donorCountMap.get(d.campaignId) ?? 0) + 1);
}

  // For members: batch-fetch their donations across all campaigns in one query
  let memberDonationMap = new Map<string, { hasDonated: boolean; total: number }>();
  if (roleName === 'member' && userId) {
    const memberDonations = await prisma.donationTransaction.findMany({
      where: { campaignId: { in: campaignIds }, userId, status: 'completed' },
      select: { campaignId: true, amount: true },
    });
    for (const d of memberDonations) {
      const existing = memberDonationMap.get(d.campaignId) ?? { hasDonated: false, total: 0 };
      memberDonationMap.set(d.campaignId, { hasDonated: true, total: existing.total + d.amount });
    }
  }

  const campaignsWithStats = campaigns.map(campaign => {
    const memberData = memberDonationMap.get(campaign.id);
    return {
      ...campaign,
      totalRaised: raisedMap.get(campaign.id) ?? 0,
      donorCount: donorCountMap.get(campaign.id) ?? 0,
      userHasDonated: memberData?.hasDonated ?? false,
      userTotalDonated: memberData?.total ?? 0,
    };
  });

  // Group by date ranges
  const grouped = groupByDateRanges(campaignsWithStats);

  res.json({ success: true, data: grouped });
}

export async function getGivingSummary(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const roleName = req.user?.role;
  const filterChurchId = req.query.churchId as string | undefined;
  const category = req.query.category as string | undefined;
  const startDate = req.query.startDate as string | undefined;
  const endDate = req.query.endDate as string | undefined;

  const accessibleChurchIds = await getAccessibleChurchIds(
    roleName!,
    req.user?.churchId,
    req.user?.districts,
    req.user?.traditionalAuthorities,
    req.user?.regions,
    userId
  );

  if (accessibleChurchIds.length === 0) {
    res.json({ success: true, data: { totalRaised: 0, donorCount: 0, topCampaigns: [] } });
    return;
  }

  let scopedChurchIds = accessibleChurchIds;
  if (filterChurchId) {
    if (!accessibleChurchIds.includes(filterChurchId)) {
      res.json({ success: true, data: { totalRaised: 0, donorCount: 0, topCampaigns: [] } });
      return;
    }
    scopedChurchIds = [filterChurchId];
  }

  const dateFilter: any = {};
  if (startDate) dateFilter.gte = new Date(startDate);
  if (endDate) {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    dateFilter.lte = end;
  }

  const where: any = {
    churchId: { in: scopedChurchIds },
    status: 'completed',
    ...(Object.keys(dateFilter).length > 0 && { createdAt: dateFilter }),
    ...(category && category !== 'all' && { campaign: { is: { category } } }),
  };

  const [total, grouped, memberDonors, guestDonors] = await Promise.all([
    prisma.donationTransaction.aggregate({
      where,
      _sum: { amount: true },
    }),
    prisma.donationTransaction.groupBy({
      by: ['campaignId', 'currency'],
      where,
      _sum: { amount: true },
      _count: { id: true },
      orderBy: { _sum: { amount: 'desc' } },
      take: 3,
    }),
    prisma.donationTransaction.findMany({
      where: { ...where, userId: { not: null } },
      select: { userId: true },
      distinct: ['userId'],
    }),
    prisma.donationTransaction.findMany({
      where: { ...where, userId: null, guestEmail: { not: null } },
      select: { guestEmail: true },
      distinct: ['guestEmail'],
    }),
  ]);

  const topRows = grouped.map(row => ({
    campaignId: row.campaignId,
    currency: row.currency,
    totalRaised: row._sum.amount ?? 0,
    donationCount: row._count.id,
  }));

  const campaigns = topRows.length
    ? await prisma.givingCampaign.findMany({
        where: { id: { in: topRows.map(row => row.campaignId) } },
        select: {
          id: true,
          name: true,
          category: true,
          church: { select: { name: true } },
        },
      })
    : [];
  const campaignMap = new Map(campaigns.map(campaign => [campaign.id, campaign]));

  res.json({
    success: true,
    data: {
      totalRaised: total._sum.amount ?? 0,
      donorCount: memberDonors.length + guestDonors.length,
      topCampaigns: topRows.map(row => ({
        ...row,
        campaign: campaignMap.get(row.campaignId) ?? null,
      })),
    },
  });
}

export async function getCampaign(req: Request, res: Response): Promise<void> {
  const { id } = req.params;

  const campaign = await prisma.givingCampaign.findUnique({
    where: { id: String(id) },
    include: {
      church: { select: { name: true } },
      _count: { select: { donations: true } },
    },
  });

  if (!campaign) {
    res.status(404).json({ success: false, message: 'Campaign not found' });
    return;
  }

  const stats = await prisma.donationTransaction.aggregate({
    where: { campaignId: String(id), status: 'completed' },
    _sum: { amount: true },
  });

  // Count unique donors
  const uniqueDonors = await prisma.donationTransaction.findMany({
    where: { campaignId: String(id), status: 'completed' },
    select: { userId: true },
    distinct: ['userId'],
  });

  res.json({
    success: true,
    data: {
      ...campaign,
      totalRaised: stats._sum?.amount || 0,
      donorCount: uniqueDonors.length,
    },
  });
}

export async function updateCampaign(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const userId = req.user?.userId;
  const churchId = req.user?.churchId;
  const roleName = req.user?.role;

  console.log(`[updateCampaign] ── campaign=${id} user=${userId} role=${roleName} jwtChurchId=${churchId ?? 'null'}`);

  const parsed = updateCampaignSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  // Check if campaign exists and user has access
  const existingCampaign = await prisma.givingCampaign.findUnique({ 
    where: { id: String(id) }, 
    include: { church: true } 
  });
  if (!existingCampaign) {
    res.status(404).json({ success: false, message: 'Campaign not found' });
    return;
  }

  console.log(`[updateCampaign] campaign.churchId=${existingCampaign.churchId} church.ministryAdminId=${existingCampaign.church?.ministryAdminId ?? 'null'}`);

  // Verify user has access to this church
  const accessibleChurchIds = await getAccessibleChurchIds(
    roleName!,
    churchId,
    req.user?.districts,
    req.user?.traditionalAuthorities,
    req.user?.regions,
    userId
  );

  console.log(`[updateCampaign] accessibleChurchIds=${JSON.stringify(accessibleChurchIds)}`);

  let hasAccess = accessibleChurchIds.includes(existingCampaign.churchId);
  console.log(`[updateCampaign] hasAccess via getAccessibleChurchIds=${hasAccess}`);

  // Fallback for ministry_admin: directly check church.ministryAdminId
  // handles cases where getAccessibleChurchIds returns empty (church not yet linked)
  if (!hasAccess && roleName === 'ministry_admin') {
    hasAccess = existingCampaign.church?.ministryAdminId === userId;
    console.log(`[updateCampaign] fallback ministryAdminId check: church.ministryAdminId=${existingCampaign.church?.ministryAdminId} === userId=${userId} → ${hasAccess}`);
  }

  if (!hasAccess) {
    console.log(`[updateCampaign] ✗ ACCESS DENIED`);
    res.status(403).json({ success: false, message: 'Access denied' });
    return;
  }

  console.log(`[updateCampaign] ✓ access granted — proceeding with update`);

  const { endDate, ...data } = parsed.data;

  const campaign = await prisma.givingCampaign.update({
    where: { id: String(id) },
    data: {
      ...data,
      ...(endDate !== undefined ? { endDate: endDate ? new Date(endDate) : null } : {}),
    },
  });

  res.json({ success: true, data: campaign });
}

export async function deleteCampaign(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const userId = req.user?.userId;
  const churchId = req.user?.churchId;
  const roleName = req.user?.role;

  // Check if campaign exists and user has access
  const existingCampaign = await prisma.givingCampaign.findUnique({ 
    where: { id: String(id) }, 
    include: { church: true } 
  });
  if (!existingCampaign) {
    res.status(404).json({ success: false, message: 'Campaign not found' });
    return;
  }

  // Verify user has access to this church
  const accessibleChurchIds = await getAccessibleChurchIds(
    roleName!,
    churchId,
    req.user?.districts,
    req.user?.traditionalAuthorities,
    req.user?.regions,
    userId
  );

  if (!accessibleChurchIds.includes(existingCampaign.churchId)) {
    res.status(403).json({ success: false, message: 'Access denied' });
    return;
  }

  await prisma.givingCampaign.delete({ where: { id: String(id) } });

  res.json({ success: true, message: 'Campaign deleted' });
}

export async function getDonations(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const roleName = req.user?.role;
  const { campaignId, churchId: filterChurchId, category, cellId, startDate, endDate } = req.query;

  // Pagination
  const page  = Math.max(1, parseInt(req.query.page  as string) || 1);
  const isExport = req.query.export === 'true';
  const limit = isExport
    ? Math.min(parseInt(req.query.limit as string) || 10000, 10000)
    : Math.min(parseInt(req.query.limit as string) || 50, 500);
  const skip  = (page - 1) * limit;

  // Build date filter
  const dateFilter: any = {};
  if (startDate && typeof startDate === 'string') dateFilter.gte = new Date(startDate);
  if (endDate && typeof endDate === 'string') {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    dateFilter.lte = end;
  }

  // Members see only their own donations
  if (roleName === 'member') {
    const where: any = {
      userId,
      ...(campaignId && { campaignId: String(campaignId) }),
      ...(category && { campaign: { category: String(category) } }),
      ...(Object.keys(dateFilter).length > 0 && { createdAt: dateFilter }),
    };
    const [donations, total] = await Promise.all([
      prisma.donationTransaction.findMany({
        where,
        include: {
          campaign: { select: { name: true, category: true } },
          user: { select: { firstName: true, lastName: true, email: true } },
          church: { select: { name: true } },
          cell: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.donationTransaction.count({ where }),
    ]);
    res.json({ success: true, data: donations, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
    return;
  }

  // Get user's accessible churches based on role
  const accessibleChurchIds = await getAccessibleChurchIds(
    roleName!,
    req.user?.churchId,
    req.user?.districts,
    req.user?.traditionalAuthorities,
    req.user?.regions,
    userId
  );

  if (accessibleChurchIds.length === 0) {
    res.json({ success: true, data: [], pagination: { page, limit, total: 0, totalPages: 0 } });
    return;
  }

  // Validate filterChurchId is within scope — never let it bypass accessibleChurchIds
  let scopedChurchIds = accessibleChurchIds;
  if (filterChurchId && typeof filterChurchId === 'string') {
    if (!accessibleChurchIds.includes(filterChurchId)) {
      res.json({ success: true, data: [], pagination: { page, limit, total: 0, totalPages: 0 } });
      return;
    }
    scopedChurchIds = [filterChurchId];
  }

  const where: any = {
    churchId: { in: scopedChurchIds },
    ...(campaignId && { campaignId: String(campaignId) }),
    ...(category && { campaign: { category: String(category) } }),
    ...(cellId && { cellId: String(cellId) }),
    ...(Object.keys(dateFilter).length > 0 && { createdAt: dateFilter }),
  };

  const donationSelect = {
    id: true,
    amount: true,
    currency: true,
    status: true,
    isAnonymous: true,
    // isManual: true,
    reference: true,
    donorName: true,
    donorEmail: true,
    isGuest: true,
    guestName: true,
    guestEmail: true,
    guestPhone: true,
    notes: true,
    createdAt: true,
    paymentMethod: true,
    campaign: { select: { name: true, category: true } },
    church: { select: { name: true } },
    user: { select: { firstName: true, lastName: true, email: true, phone: true } },
    cell: { select: { name: true } },
  };

  if (isExport) {
    // Export mode: respects limit + page for batched downloads
    const donations = await prisma.donationTransaction.findMany({
      where,
      select: donationSelect,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    });
    res.json({ success: true, data: donations });
    return;
  }

  const [donations, total] = await Promise.all([
    prisma.donationTransaction.findMany({
      where,
      select: donationSelect,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.donationTransaction.count({ where }),
  ]);

  res.json({ success: true, data: donations, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
}

const createDonationSchema = z.object({
  campaignId: z.string().min(1),
  amount: z.number().positive(),
  isAnonymous: z.boolean().optional().default(false),
  donorName: z.string().optional(),
  donorEmail: z.string().email().optional(),
  donorPhone: z.string().optional(),
  notes: z.string().optional(),
  cellId: z.string().optional(),
  pledgeId: z.string().optional(), // optional: pay against a specific pledge
});

export async function createDonation(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const userEmail = req.user?.email;
  const traceId = `DON-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  console.log(`[${traceId}] ========== DONATION INITIATED ==========`);
  console.log(`[${traceId}] User ID: ${userId}`);

  const parsed = createDonationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const { campaignId, amount, isAnonymous, donorName, donorEmail, donorPhone, notes, cellId, pledgeId } = parsed.data;

  const campaign = await prisma.givingCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign) {
    res.status(404).json({ success: false, message: 'Campaign not found' });
    return;
  }

  if (campaign.status !== 'active') {
    res.status(400).json({ success: false, message: 'Campaign is not active' });
    return;
  }

  // Determine gateway using existing function
  const { getPaymentGateway, getCurrency, getGatewayCountry } = await import('../utils/gatewayRouter');
  const { calculatePaymentFees } = await import('../utils/feeCalculations');
  
  const gateway = await getPaymentGateway(userId!);
  const currency = getCurrency(gateway);
  const gatewayCountry = getGatewayCountry(gateway);
  
  console.log(`[${traceId}] Gateway: ${gateway}, Country: ${gatewayCountry}, Currency: ${currency}`);
  
  // Calculate fees
  const fees = calculatePaymentFees(amount, gatewayCountry);
  
  console.log(`[${traceId}] Fees - Base: ${fees.baseAmount}, Convenience: ${fees.convenienceFee}, Tax: ${fees.systemFeeAmount}, Total: ${fees.totalAmount}`);

  // Create pending transaction
  const expiresAt = new Date();
  expiresAt.setMinutes(expiresAt.getMinutes() + 30);

  const pendingTx = await prisma.pendingTransaction.create({
    data: {
      amount: fees.totalAmount,
      currency,
      userId: userId!,
      churchId: campaign.churchId,
      type: 'donation',
      expiresAt,
      metadata: JSON.stringify({
        traceId,
        campaignId,
        campaignName: campaign.name,
        isGuest: false,
        isAnonymous,
        donorName,
        donorPhone,
        notes,
        cellId: cellId || null,
        pledgeId: pledgeId || null,
        baseAmount: fees.baseAmount,
        convenienceFee: fees.convenienceFee,
        systemFeeAmount: fees.systemFeeAmount,
        ceilRoundingAmount: fees.ceilRoundingAmount,
        totalAmount: fees.totalAmount,
        gateway,
        gatewayCountry,
      }),
    },
  });

  console.log(`[${traceId}] Pending transaction created: ${pendingTx.id}`);

  // Route to gateway
  if (gateway === 'paychangu') {
    return await initiatePaychanguDonation(pendingTx, userEmail!, donorEmail, fees, traceId, res);
  } else {
    return await initiatePaystackDonation(pendingTx, userEmail!, donorEmail, campaign, fees, currency, traceId, res);
  }
}

async function initiatePaystackDonation(
  pendingTx: any,
  userEmail: string,
  donorEmail: string | undefined,
  campaign: any,
  fees: any,
  currency: string,
  traceId: string,
  res: Response
): Promise<void> {
  console.log(`[${traceId}] Routing to Paystack`);
  
  const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY!;
  const PAYSTACK_BASE_URL = process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co';
  const BACKEND_URL = process.env.BACKEND_URL!;

  try {
    const metadata = JSON.parse(pendingTx.metadata);
    const amountInKobo = Math.round(fees.totalAmount * 100);
    const isGuest = metadata.isGuest === true;
    const callbackUrl = isGuest
      ? `${BACKEND_URL}/api/payments/verify?guestEmail=${encodeURIComponent(metadata.guestEmail)}&guestName=${encodeURIComponent(metadata.guestName)}&isGuest=true&type=donation`
      : `${BACKEND_URL}/api/payments/verify`;
    
    // Get church subaccount
    const subaccount = await prisma.subaccount.findUnique({
      where: { churchId: campaign.churchId }
    });

    console.log(`[${traceId}] Subaccount found: ${subaccount ? subaccount.subaccountCode : 'NONE'}`);
    console.log(`[${traceId}] Subaccount name: ${subaccount ? subaccount.businessName : 'NONE'}`);

    const paystackPayload = {
      email: donorEmail || userEmail,
      amount: amountInKobo,
      currency: 'KES',
      callback_url: callbackUrl,
      metadata: {
        ...metadata,
        type: 'donation',
        pendingTxId: pendingTx.id,
        userId: pendingTx.userId,
        subaccountCode: subaccount?.subaccountCode,
        subaccountName: subaccount?.businessName,
      },
      ...(subaccount && {
        subaccount: subaccount.subaccountCode,
        transaction_charge: Math.round((fees.totalAmount - fees.baseAmount) * 100),
        bearer: 'account',
      }),
    };

    const response = await axios.post(
      `${PAYSTACK_BASE_URL}/transaction/initialize`,
      paystackPayload,
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    await prisma.pendingTransaction.update({
      where: { id: pendingTx.id },
      data: { reference: response.data.data.reference },
    });

    console.log(`[${traceId}] Paystack SUCCESS`);
    res.json({
      success: true,
      data: {
        authorization_url: response.data.data.authorization_url,
        reference: response.data.data.reference,
        baseAmount: fees.baseAmount,
        convenienceFee: fees.convenienceFee,
        systemFeeAmount: fees.systemFeeAmount,
        totalAmount: fees.totalAmount,
        currency,
      },
    });
  } catch (error: any) {
    await prisma.pendingTransaction.delete({ where: { id: pendingTx.id } }).catch(() => {});
    console.error(`[${traceId}] Paystack error:`, error.message);
    res.status(500).json({
      success: false,
      message: error.response?.data?.message || 'Failed to initialize payment',
    });
  }
}

async function initiatePaychanguDonation(
  pendingTx: any,
  userEmail: string,
  donorEmail: string | undefined,
  fees: any,
  traceId: string,
  res: Response
): Promise<void> {
  console.log(`[${traceId}] Routing to Paychangu`);
  
  const PAYCHANGU_SECRET_KEY = process.env.PAYCHANGU_SECRET_KEY!;
  const BACKEND_URL = process.env.BACKEND_URL!;
  const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:8080';
  const tx_ref = `DON-${Date.now()}`;

  try {
    const metadata = JSON.parse(pendingTx.metadata);
    const isGuest = metadata.isGuest === true;
    const returnUrl = isGuest
      ? `${FRONTEND_URL}/payment/callback?status=success&type=donation&isGuest=true&reference=${tx_ref}&guestEmail=${encodeURIComponent(metadata.guestEmail)}&guestName=${encodeURIComponent(metadata.guestName)}&amount=${metadata.baseAmount}&currency=MWK`
      : `${FRONTEND_URL}/payment/callback?status=success&type=donation&reference=${tx_ref}`;
    
    const paychanguPayload = {
      amount: fees.totalAmount,
      currency: 'MWK',
      email: donorEmail || userEmail,
      tx_ref,
      callback_url: `${BACKEND_URL}/api/webhooks/paychangu/callback`,
      return_url: returnUrl,
      customization: {
        title: `Donation: ${metadata.campaignName}`,
        description: 'Campaign donation'
      }
    };

    const response = await axios.post(
      'https://api.paychangu.com/payment',
      paychanguPayload,
      {
        headers: {
          Authorization: `Bearer ${PAYCHANGU_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    await prisma.pendingTransaction.update({
      where: { id: pendingTx.id },
      data: { reference: tx_ref },
    });

    console.log(`[${traceId}] Paychangu SUCCESS`);
    res.json({
      success: true,
      data: {
        authorization_url: response.data.data?.checkout_url,
        reference: tx_ref,
        baseAmount: fees.baseAmount,
        convenienceFee: fees.convenienceFee,
        systemFeeAmount: fees.systemFeeAmount,
        totalAmount: fees.totalAmount,
        currency: 'MWK',
      },
    });
  } catch (error: any) {
    await prisma.pendingTransaction.delete({ where: { id: pendingTx.id } }).catch(() => {});
    console.error(`[${traceId}] Paychangu error:`, error.message);
    res.status(500).json({
      success: false,
      message: error.response?.data?.message || 'Failed to initialize payment',
    });
  }
}

export async function getGuestDonationFees(req: Request, res: Response): Promise<void> {
  const { campaignId, amount } = req.query as { campaignId: string; amount: string };
  if (!campaignId || !amount) {
    res.status(400).json({ success: false, message: 'campaignId and amount required' });
    return;
  }
  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    res.status(400).json({ success: false, message: 'Invalid amount' });
    return;
  }

  const campaign = await prisma.givingCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign || !campaign.allowPublicDonations) {
    res.status(404).json({ success: false, message: 'Campaign not found' });
    return;
  }

  const { getPaymentGatewayByChurch, getCurrency, getGatewayCountry } = await import('../utils/gatewayRouter');
  const { calculatePaymentFees } = await import('../utils/feeCalculations');

  const gateway = await getPaymentGatewayByChurch(campaign.churchId);
  const currency = getCurrency(gateway);
  const gatewayCountry = getGatewayCountry(gateway);
  const fees = calculatePaymentFees(parsedAmount, gatewayCountry);

  res.json({
    success: true,
    data: {
      currency,
      baseAmount: fees.baseAmount,
      convenienceFee: fees.convenienceFee,
      systemFeeAmount: fees.systemFeeAmount,
      ceilRoundingAmount: fees.ceilRoundingAmount,
      totalAmount: fees.totalAmount,
    },
  });
}

export async function getPublicCampaign(req: Request, res: Response): Promise<void> {
  const { id } = req.params;

  const campaign = await prisma.givingCampaign.findUnique({
    where: { id: String(id) },
    include: { church: { select: { name: true } } },
  });

  if (!campaign || !campaign.allowPublicDonations) {
    res.status(404).json({ success: false, message: 'Campaign not found or not publicly available' });
    return;
  }

  if (campaign.status !== 'active') {
    res.status(400).json({ success: false, message: 'This campaign is no longer active' });
    return;
  }

  const { targetAmount, ...publicFields } = campaign;

  res.json({ success: true, data: publicFields });
}

const guestDonationSchema = z.object({
  campaignId: z.string().min(1),
  amount: z.number().positive(),
  guestName: z.string().min(1),
  guestEmail: z.string().email(),
  guestPhone: z.string().optional(),
  cellId: z.string().optional(),
});

export async function createGuestDonation(req: Request, res: Response): Promise<void> {
  const traceId = `GDON-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  console.log(`[${traceId}] ========== GUEST DONATION INITIATED ==========`);

  const parsed = guestDonationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const { campaignId, amount, guestName, guestEmail, guestPhone, cellId } = parsed.data;

  const campaign = await prisma.givingCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign || !campaign.allowPublicDonations) {
    res.status(404).json({ success: false, message: 'Campaign not found or not publicly available' });
    return;
  }
  if (campaign.status !== 'active') {
    res.status(400).json({ success: false, message: 'Campaign is not active' });
    return;
  }

  const { getPaymentGatewayByChurch, getCurrency, getGatewayCountry } = await import('../utils/gatewayRouter');
  const { calculatePaymentFees } = await import('../utils/feeCalculations');

  const gateway = await getPaymentGatewayByChurch(campaign.churchId);
  const currency = getCurrency(gateway);
  const gatewayCountry = getGatewayCountry(gateway);
  const fees = calculatePaymentFees(amount, gatewayCountry);

  const expiresAt = new Date();
  expiresAt.setMinutes(expiresAt.getMinutes() + 30);

  const pendingTx = await prisma.pendingTransaction.create({
    data: {
      amount: fees.totalAmount,
      currency,
      userId: null,
      churchId: campaign.churchId,
      type: 'donation',
      expiresAt,
      metadata: JSON.stringify({
        traceId,
        campaignId,
        campaignName: campaign.name,
        isGuest: true,
        guestName,
        guestEmail,
        guestPhone: guestPhone || null,
        isAnonymous: false,
        cellId: cellId || null,
        baseAmount: fees.baseAmount,
        convenienceFee: fees.convenienceFee,
        systemFeeAmount: fees.systemFeeAmount,
        ceilRoundingAmount: fees.ceilRoundingAmount,
        totalAmount: fees.totalAmount,
        gateway,
        gatewayCountry,
      }),
    },
  });

  console.log(`[${traceId}] Pending transaction created: ${pendingTx.id}`);

  if (gateway === 'paychangu') {
    return await initiatePaychanguDonation(pendingTx, guestEmail, guestEmail, fees, traceId, res);
  } else {
    return await initiatePaystackDonation(pendingTx, guestEmail, guestEmail, campaign, fees, currency, traceId, res);
  }
}

export async function getDonationTransaction(req: Request, res: Response): Promise<void> {
  const donationId = String(req.params.id);
  const userId = req.user?.userId;
  const roleName = req.user?.role ?? 'member';

  const donation = await prisma.donationTransaction.findUnique({
    where: { id: donationId },
    select: { userId: true, transactionId: true },
  });

  if (!donation) {
    res.status(404).json({ success: false, message: 'Donation not found' });
    return;
  }

  // Members can only see their own donation transactions
  if (roleName === 'member' && donation.userId !== userId) {
    res.status(403).json({ success: false, message: 'Access denied' });
    return;
  }

  if (!donation.transactionId) {
    res.status(404).json({ success: false, message: 'No transaction found' });
    return;
  }

  // Fetch transaction with role-based fields
  if (roleName === 'member') {
    // Members see limited fields (no totalFees)
    const transaction = await prisma.transaction.findUnique({
      where: { id: donation.transactionId },
      select: {
        amount: true,
        currency: true,
        paymentMethod: true,
        status: true,
        reference: true,
        paidAt: true,
        channel: true,
        baseAmount: true,
        gateway: true,
      },
    });
    res.json({ success: true, data: transaction });
  } else {
    // Admins see all fields including totalFees
    const transaction = await prisma.transaction.findUnique({
      where: { id: donation.transactionId },
      select: {
        amount: true,
        currency: true,
        paymentMethod: true,
        status: true,
        reference: true,
        paidAt: true,
        channel: true,
        gatewayResponse: true,
        customerEmail: true,
        customerPhone: true,
        type: true,
        isManual: true,
        notes: true,
        createdAt: true,
        subaccountName: true,
          baseAmount: true,
        gateway: true,
      },
    });
    res.json({ success: true, data: transaction });
  }
}

// ─── POST /api/giving/donations/cash ─────────────────────────────────────────

const recordCashDonationSchema = z.object({
  campaignId: z.string().min(1),
  donorType: z.enum(['member', 'guest', 'anonymous']),
  memberId: z.string().optional(),
  guestName: z.string().optional(),
  guestEmail: z.string().email().optional().or(z.literal('')),
  guestPhone: z.string().optional(),
  amount: z.number().positive('Amount must be positive'),
  currency: z.string().min(1),
  date: z.string().min(1, 'Date is required'),
  reference: z.string().optional(),
  notes: z.string().optional(),
  cellId: z.string().optional(),
});

export async function recordCashDonation(req: Request, res: Response): Promise<void> {
  const adminId = req.user?.userId;
  const roleName = req.user?.role;

  const parsed = recordCashDonationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const { campaignId, donorType, memberId, guestName, guestEmail, guestPhone, amount, currency, date, reference, notes, cellId } = parsed.data;

  // Validate required fields per donor type
  if (donorType === 'member' && !memberId) {
    res.status(400).json({ success: false, message: 'Member is required' });
    return;
  }
  if (donorType === 'guest' && !guestName) {
    res.status(400).json({ success: false, message: 'Guest name is required' });
    return;
  }

  // Verify campaign exists
  const campaign = await prisma.givingCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign) {
    res.status(404).json({ success: false, message: 'Campaign not found' });
    return;
  }

  // Verify admin has access to this campaign's church
  const { getAccessibleChurchIds } = await import('../lib/churchScope');
  const accessibleChurchIds = await getAccessibleChurchIds(
    roleName!,
    req.user?.churchId,
    req.user?.districts,
    req.user?.traditionalAuthorities,
    req.user?.regions,
    adminId
  );

  if (!accessibleChurchIds.includes(campaign.churchId)) {
    res.status(403).json({ success: false, message: 'Access denied to this campaign' });
    return;
  }

  // For member type — verify member exists and is in scope
  let resolvedUserId: string | null = null;
  if (donorType === 'member' && memberId) {
    const member = await prisma.user.findUnique({
      where: { id: memberId },
      select: { id: true, churchId: true },
    });
    if (!member) {
      res.status(404).json({ success: false, message: 'Member not found' });
      return;
    }
    if (member.churchId && !accessibleChurchIds.includes(member.churchId)) {
      res.status(403).json({ success: false, message: 'Access denied to this member' });
      return;
    }
    resolvedUserId = member.id;
  }

  // Create Transaction record for consistency (cash type)
  const transaction = await prisma.transaction.create({
    data: {
      amount,
      currency,
      status: 'completed',
      paymentMethod: 'cash',
      type: 'donation',
      isManual: true,
      reference: reference || undefined,
      notes: notes || undefined,
      baseAmount: amount,
      userId: resolvedUserId,
      churchId: campaign.churchId,
      paidAt: new Date(date),
      createdAt: new Date(date),
      // donor info
      isGuest: donorType === 'guest',
      guestName: donorType === 'guest' ? guestName : undefined,
      guestEmail: donorType === 'guest' ? (guestEmail || undefined) : undefined,
      guestPhone: donorType === 'guest' ? (guestPhone || undefined) : undefined,
    },
  });

  const donation = await prisma.donationTransaction.create({
    data: {
      campaignId,
      churchId: campaign.churchId,
      amount,
      currency,
      paymentMethod: 'cash',
      status: 'completed',
      transactionId: transaction.id,
      reference: reference || undefined,
      notes: notes || undefined,
      createdAt: new Date(date),
      // donor type fields
      userId: resolvedUserId,
      isGuest: donorType === 'guest',
      isAnonymous: donorType === 'anonymous',
      guestName: donorType === 'guest' ? guestName : undefined,
      guestEmail: donorType === 'guest' ? (guestEmail || undefined) : undefined,
      guestPhone: donorType === 'guest' ? (guestPhone || undefined) : undefined,
      cellId: cellId || undefined,
    },
    include: {
      campaign: { select: { name: true, category: true } },
      user: { select: { firstName: true, lastName: true, email: true } },
      church: { select: { name: true } },
    },
  });

  res.status(201).json({ success: true, data: donation });
}

// ─── GET /api/giving/campaigns/:id/cells — public, no auth ───────────────────
// Returns active cells for the church that owns this campaign (for fellowship_offering)

export async function getPublicCampaignCells(req: Request, res: Response): Promise<void> {
  const { id } = req.params;

  const campaign = await prisma.givingCampaign.findUnique({
    where: { id: String(id) },
    select: { churchId: true, allowPublicDonations: true, category: true },
  });

  if (!campaign || !campaign.allowPublicDonations) {
    res.status(404).json({ success: false, message: 'Campaign not found' });
    return;
  }

  const cells = await prisma.cell.findMany({
    where: { churchId: campaign.churchId, status: 'active' },
    select: { id: true, name: true, zone: true },
    orderBy: { name: 'asc' },
  });

  res.json({ success: true, data: cells });
}
