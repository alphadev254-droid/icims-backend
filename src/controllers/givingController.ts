import { Request, Response } from 'express';
import { z } from 'zod';
import axios from 'axios';
import prisma from '../lib/prisma';
import { groupByDateRanges } from '../lib/dateGrouping';
import { getAccessibleChurchIds } from '../lib/churchScope';
import { queueChurchPush } from '../lib/notificationQueue';
import { queueChurchMemberEmails } from '../lib/churchMemberEmail';
import { givingCampaignCreatedTemplate } from '../lib/emailTemplates';
import { recordPaymentEvent } from '../middleware/metrics';
import { maskEmail, maskPhone } from '../utils/logger';
import { findDonationMemberByContact } from '../lib/donationMemberMatching';
import { hasFeature } from '../lib/packageChecker';

function donationLogMeta(traceId: string, pendingTx: any, metadata: any = {}, extra: Record<string, unknown> = {}) {
  return {
    traceId,
    pendingTransactionId: pendingTx?.id,
    reference: pendingTx?.reference,
    campaignId: metadata.campaignId,
    campaignName: metadata.campaignName,
    churchId: pendingTx?.churchId || metadata.churchId,
    userId: metadata.userId ?? pendingTx?.userId,
    userName: metadata.userName,
    isGuest: metadata.isGuest === true,
    guestName: metadata.guestName,
    donorName: metadata.donorName,
    guestEmail: maskEmail(metadata.guestEmail),
    donorEmail: maskEmail(metadata.donorEmail),
    guestPhone: maskPhone(metadata.guestPhone),
    donorPhone: maskPhone(metadata.donorPhone),
    amount: metadata.baseAmount,
    totalAmount: metadata.totalAmount ?? pendingTx?.amount,
    currency: pendingTx?.currency,
    ...extra,
  };
}

const createCampaignSchema = z.object({
  churchId: z.string().optional().default(''),
  scopeType: z.enum(['one_church', 'selected_churches', 'all_churches']).optional().default('one_church'),
  churchIds: z.array(z.string().min(1)).optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  category: z.enum(['tithe', 'offering', 'partnership', 'welfare', 'missions', 'fellowship_offering']),
  subcategory: z.string().optional(),
  targetAmount: z.number().positive().optional().or(z.literal(0)).or(z.nan()).transform(val => val && val > 0 ? val : undefined),
  currency: z.enum(['MWK', 'KES']).default('MWK'),
  endDate: z.string().optional(),
  imageUrl: z.string().optional(),
  allowPublicDonations: z.boolean().optional(),
  allowPledging: z.boolean().optional(),
});

const updateCampaignSchema = z.object({
  churchId: z.string().optional(),
  scopeType: z.enum(['one_church', 'selected_churches', 'all_churches']).optional(),
  churchIds: z.array(z.string().min(1)).optional(),
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  category: z.enum(['tithe', 'offering', 'partnership', 'welfare', 'missions', 'fellowship_offering']).optional(),
  subcategory: z.string().nullable().optional(),
  targetAmount: z.number().positive().optional().or(z.literal(0)).or(z.nan()).transform(val => val && val > 0 ? val : undefined),
  currency: z.enum(['MWK', 'KES']).optional(),
  status: z.enum(['active', 'completed', 'cancelled']).optional(),
  endDate: z.string().nullable().optional(),
  imageUrl: z.string().nullable().optional(),
  allowPublicDonations: z.boolean().optional(),
  allowPledging: z.boolean().optional(),
});

type CampaignWithChurchLinks = {
  id: string;
  churchId: string;
  scopeType?: string | null;
  linkedChurches?: Array<{ churchId: string; church?: { id?: string; name: string; ministryAdminId?: string | null } | null }>;
  church?: { id?: string; name: string; ministryAdminId?: string | null } | null;
};

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function getCampaignChurchIds(campaign: CampaignWithChurchLinks): string[] {
  const linkedIds = campaign.linkedChurches?.map(link => link.churchId) ?? [];
  return uniqueStrings(linkedIds.length > 0 ? linkedIds : [campaign.churchId]);
}

function decorateCampaignAvailability<T extends CampaignWithChurchLinks>(campaign: T, scopedChurchIds?: string[]) {
  const linkedChurches = campaign.linkedChurches ?? [];
  const allAvailableChurchIds = getCampaignChurchIds(campaign);
  const availableChurchIds = scopedChurchIds?.length
    ? intersection(allAvailableChurchIds, scopedChurchIds)
    : allAvailableChurchIds;
  const availableChurches = (linkedChurches.length > 0
    ? linkedChurches.map(link => ({
        id: link.churchId,
        name: link.church?.name ?? 'Church',
      }))
    : [{ id: campaign.churchId, name: campaign.church?.name ?? 'Church' }])
    .filter(church => availableChurchIds.includes(church.id));

  return {
    ...campaign,
    availableChurchIds,
    availableChurches,
  };
}

function campaignAccessWhere(churchIds: string[]) {
  return {
    OR: [
      { churchId: { in: churchIds } },
      { linkedChurches: { some: { churchId: { in: churchIds } } } },
    ],
  };
}

function intersection(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter(value => rightSet.has(value));
}

type CampaignFeatureCandidate = CampaignWithChurchLinks & {
  category?: string | null;
};

async function getCampaignFeatureOwnerId(campaign: CampaignFeatureCandidate): Promise<string | null> {
  const linkedOwnerId = campaign.linkedChurches?.find(link => link.church?.ministryAdminId)?.church?.ministryAdminId;
  if (linkedOwnerId) return linkedOwnerId;
  if (campaign.church?.ministryAdminId) return campaign.church.ministryAdminId;

  const church = await prisma.church.findUnique({
    where: { id: campaign.churchId },
    select: { ministryAdminId: true },
  });
  return church?.ministryAdminId ?? null;
}

async function campaignOwnerHasFeature(campaign: CampaignFeatureCandidate, featureName: string): Promise<boolean> {
  const ownerId = await getCampaignFeatureOwnerId(campaign);
  return !!ownerId && hasFeature(ownerId, featureName);
}

async function ensureCampaignOwnerFeature(campaign: CampaignFeatureCandidate, featureName: string, message: string) {
  if (!(await campaignOwnerHasFeature(campaign, featureName))) {
    return { error: message };
  }
  return null;
}

function resolveRequestedScopeChurchIds(params: {
  scopeType?: string;
  primaryChurchId?: string | null;
  requestedChurchIds?: string[];
  accessibleChurchIds: string[];
}): { churchIds?: string[]; error?: string } {
  const scopeType = params.scopeType || 'one_church';
  let churchIds: string[] = [];

  if (scopeType === 'all_churches') {
    churchIds = params.accessibleChurchIds;
  } else if (scopeType === 'selected_churches') {
    churchIds = uniqueStrings(params.requestedChurchIds ?? []);
    if (churchIds.length === 0 && params.primaryChurchId) churchIds = [params.primaryChurchId];
  } else {
    churchIds = params.primaryChurchId ? [params.primaryChurchId] : [];
  }

  if (churchIds.length === 0) {
    return { error: 'Select at least one church for this campaign' };
  }

  const inaccessible = churchIds.filter(id => !params.accessibleChurchIds.includes(id));
  if (inaccessible.length > 0) {
    return { error: 'Access denied to one or more selected churches' };
  }

  return { churchIds };
}

export async function createCampaign(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const churchId = req.user?.churchId;
  const roleName = req.user?.role;

  const { checkLimit } = await import('../lib/packageChecker');

  const parsed = createCampaignSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const { churchId: targetChurchId, scopeType, churchIds: requestedChurchIds, endDate, allowPublicDonations, allowPledging, ...data } = parsed.data;

  const accessibleChurchIds = await getAccessibleChurchIds(
    roleName!,
    churchId,
    req.user?.districts,
    req.user?.traditionalAuthorities,
    req.user?.regions,
    userId
  );

  const resolvedScope = resolveRequestedScopeChurchIds({
    scopeType,
    primaryChurchId: targetChurchId,
    requestedChurchIds,
    accessibleChurchIds,
  });
  if (resolvedScope.error || !resolvedScope.churchIds) {
    res.status(403).json({ success: false, message: resolvedScope.error });
    return;
  }
  const scopedCampaignChurchIds = resolvedScope.churchIds;
  const primaryChurchId = scopedCampaignChurchIds[0];

  // Check maxGivings limit
  let ministryAdminId: string | null = roleName === 'ministry_admin' ? userId! : null;
  if (!ministryAdminId) {
    const u = await prisma.user.findUnique({ where: { id: userId! }, select: { ministryAdminId: true } });
    ministryAdminId = u?.ministryAdminId ?? null;
  }
  if (ministryAdminId) {
    const churches = await prisma.church.findMany({ where: { ministryAdminId, status: 'active' }, select: { id: true } });
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
    const subaccounts = await prisma.subaccount.findMany({
      where: { churchId: { in: scopedCampaignChurchIds } },
      select: { churchId: true },
    });
    const coveredChurchIds = new Set(subaccounts.map(subaccount => subaccount.churchId));
    const missingSubaccount = scopedCampaignChurchIds.some(selectedChurchId => !coveredChurchIds.has(selectedChurchId));

    if (missingSubaccount) {
      res.status(400).json({
        success: false,
        message: 'To create giving campaigns for these churches, each selected church needs a Paystack subaccount first. Please go to Branches > Finance account management.'
      });
      return;
    }
  }

  const campaign = await prisma.givingCampaign.create({
    data: {
      ...data,
      churchId: primaryChurchId,
      scopeType,
      endDate: endDate ? new Date(endDate) : null,
      allowPublicDonations: allowPublicDonations === true,
      allowPledging: allowPledging === true,
      linkedChurches: {
        create: scopedCampaignChurchIds.map(selectedChurchId => ({ churchId: selectedChurchId })),
      },
    },
    include: {
      church: { select: { id: true, name: true } },
      linkedChurches: { select: { churchId: true, church: { select: { id: true, name: true } } } },
    },
  });

  res.status(201).json({ success: true, data: decorateCampaignAvailability(campaign) });

  // Fire-and-forget: worker resolves members and sends push/email off the request cycle.
  for (const targetNotificationChurchId of scopedCampaignChurchIds) {
    const church = campaign.linkedChurches.find(link => link.churchId === targetNotificationChurchId)?.church;
    queueChurchPush(
      targetNotificationChurchId,
      `${church?.name || 'Your Church'} - New Giving Campaign`,
      `${campaign.name} - ${campaign.category.replace('_', ' ')}`,
      { type: 'giving_campaign_created', campaignId: campaign.id, churchId: targetNotificationChurchId }
    ).catch(err => console.error('[Giving] Failed to queue push:', err));

    queueChurchMemberEmails({
      churchId: targetNotificationChurchId,
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

  // Default to active campaigns. Admins can explicitly request status=all.
  const requestedStatus = typeof status === 'string' ? status : undefined;
  const statusFilter = requestedStatus && requestedStatus !== 'all' ? requestedStatus : 'active';

  const campaigns = await prisma.givingCampaign.findMany({
    where: {
      ...campaignAccessWhere(scopedChurchIds),
      ...(category     && { category: String(category) }),
      ...(statusFilter && { status: statusFilter }),
    },
    include: {
      church: { select: { id: true, name: true } },
      linkedChurches: { select: { churchId: true, church: { select: { id: true, name: true } } } },
      _count: { select: { donations: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (campaigns.length === 0) {
    res.json({ success: true, data: [] });
    return;
  }

  const campaignIds = campaigns.map(c => c.id);
  const completedDonationScope = {
    campaignId: { in: campaignIds },
    churchId: { in: scopedChurchIds },
    status: 'completed',
  };

 const [raisedStats, memberDonorStats, guestDonorStats] = await Promise.all([
  // Total raised per campaign
  prisma.donationTransaction.groupBy({
    by: ['campaignId'],
    where: completedDonationScope,
    _sum: { amount: true },
  }),
  // Unique MEMBER donors (distinct userId)
  prisma.donationTransaction.findMany({
    where: { ...completedDonationScope, userId: { not: null } },
    select: { campaignId: true, userId: true },
    distinct: ['campaignId', 'userId'],
  }),
  // Unique GUEST donors (distinct by guestEmail per campaign)
  prisma.donationTransaction.findMany({
    where: { 
      ...completedDonationScope,
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
      ...decorateCampaignAvailability(campaign, scopedChurchIds),
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

export async function getCampaignSelect(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const roleName = req.user?.role;
  const filterChurchId = req.query.churchId as string | undefined;
  const category = req.query.category as string | undefined;
  const status = req.query.status as string | undefined;

  const accessibleChurchIds = await getAccessibleChurchIds(
    roleName!,
    req.user?.churchId,
    req.user?.districts,
    req.user?.traditionalAuthorities,
    req.user?.regions,
    userId,
  );

  let scopedChurchIds = accessibleChurchIds;
  if (filterChurchId) {
    if (!accessibleChurchIds.includes(filterChurchId)) {
      res.json({ success: true, data: [] });
      return;
    }
    scopedChurchIds = [filterChurchId];
  }

  if (scopedChurchIds.length === 0) {
    res.json({ success: true, data: [] });
    return;
  }

  // Default to active campaigns. Admins can explicitly request status=all.
  const statusFilter = status && status !== 'all' ? status : 'active';

  const campaigns = await prisma.givingCampaign.findMany({
    where: {
      ...campaignAccessWhere(scopedChurchIds),
      ...(category && { category }),
      ...(statusFilter && { status: statusFilter }),
    },
    select: {
      id: true,
      name: true,
      category: true,
      status: true,
      churchId: true,
      scopeType: true,
      currency: true,
      church: { select: { id: true, name: true } },
      linkedChurches: { select: { churchId: true, church: { select: { id: true, name: true } } } },
    },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });

  res.json({ success: true, data: campaigns.map(campaign => decorateCampaignAvailability(campaign, scopedChurchIds)) });
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
  const userId = req.user?.userId;
  const roleName = req.user?.role;
  const filterChurchId = req.query.churchId as string | undefined;
  const accessibleChurchIds = await getAccessibleChurchIds(
    roleName!,
    req.user?.churchId,
    req.user?.districts,
    req.user?.traditionalAuthorities,
    req.user?.regions,
    userId,
  );

  const campaign = await prisma.givingCampaign.findUnique({
    where: { id: String(id) },
    include: {
      church: { select: { id: true, name: true } },
      linkedChurches: { select: { churchId: true, church: { select: { id: true, name: true } } } },
      _count: { select: { donations: true } },
    },
  });

  if (!campaign) {
    res.status(404).json({ success: false, message: 'Campaign not found' });
    return;
  }

  const scopedCampaignChurchIds = intersection(getCampaignChurchIds(campaign), accessibleChurchIds);
  if (scopedCampaignChurchIds.length === 0) {
    res.status(403).json({ success: false, message: 'Access denied' });
    return;
  }

  let statChurchIds = scopedCampaignChurchIds;
  if (filterChurchId) {
    if (!scopedCampaignChurchIds.includes(filterChurchId)) {
      res.status(403).json({ success: false, message: 'Access denied for selected church' });
      return;
    }
    statChurchIds = [filterChurchId];
  }

  const stats = await prisma.donationTransaction.aggregate({
    where: { campaignId: String(id), churchId: { in: statChurchIds }, status: 'completed' },
    _sum: { amount: true },
  });

  const [uniqueMemberDonors, uniqueGuestDonors] = await Promise.all([
    prisma.donationTransaction.findMany({
      where: { campaignId: String(id), churchId: { in: statChurchIds }, status: 'completed', userId: { not: null } },
      select: { userId: true },
      distinct: ['userId'],
    }),
    prisma.donationTransaction.findMany({
      where: { campaignId: String(id), churchId: { in: statChurchIds }, status: 'completed', userId: null, guestEmail: { not: null } },
      select: { guestEmail: true },
      distinct: ['guestEmail'],
    }),
  ]);

  res.json({
    success: true,
    data: {
      ...decorateCampaignAvailability(campaign, scopedCampaignChurchIds),
      totalRaised: stats._sum?.amount || 0,
      donorCount: uniqueMemberDonors.length + uniqueGuestDonors.length,
      selectedChurchId: filterChurchId || null,
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
    include: {
      church: true,
      linkedChurches: { select: { churchId: true } },
    } 
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

  const existingChurchIds = getCampaignChurchIds(existingCampaign);
  let hasAccess = existingChurchIds.some(existingChurchId => accessibleChurchIds.includes(existingChurchId));
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

  const { churchId: targetChurchId, scopeType, churchIds: requestedChurchIds, endDate, ...data } = parsed.data;
  const nextScopeType = scopeType ?? existingCampaign.scopeType ?? 'one_church';
  const shouldUpdateScope = scopeType !== undefined || targetChurchId !== undefined || requestedChurchIds !== undefined;
  const resolvedScope = shouldUpdateScope
    ? resolveRequestedScopeChurchIds({
        scopeType: nextScopeType,
        primaryChurchId: targetChurchId ?? existingCampaign.churchId,
        requestedChurchIds: requestedChurchIds ?? existingChurchIds,
        accessibleChurchIds,
      })
    : { churchIds: existingChurchIds };

  if (resolvedScope.error || !resolvedScope.churchIds) {
    res.status(403).json({ success: false, message: resolvedScope.error });
    return;
  }

  const campaign = await prisma.$transaction(async tx => {
    if (shouldUpdateScope) {
      await tx.givingCampaignChurch.deleteMany({ where: { campaignId: String(id) } });
    }

    return tx.givingCampaign.update({
      where: { id: String(id) },
      data: {
        ...data,
        ...(endDate !== undefined ? { endDate: endDate ? new Date(endDate) : null } : {}),
        ...(shouldUpdateScope ? {
          churchId: resolvedScope.churchIds![0],
          scopeType: nextScopeType,
          linkedChurches: {
            create: resolvedScope.churchIds!.map(selectedChurchId => ({ churchId: selectedChurchId })),
          },
        } : {}),
      },
      include: {
        church: { select: { id: true, name: true } },
        linkedChurches: { select: { churchId: true, church: { select: { id: true, name: true } } } },
      },
    });
  });

  res.json({ success: true, data: decorateCampaignAvailability(campaign) });
}

export async function deleteCampaign(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const userId = req.user?.userId;
  const churchId = req.user?.churchId;
  const roleName = req.user?.role;

  // Check if campaign exists and user has access
  const existingCampaign = await prisma.givingCampaign.findUnique({ 
    where: { id: String(id) }, 
    include: { church: true, linkedChurches: { select: { churchId: true } } } 
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

  if (!getCampaignChurchIds(existingCampaign).some(existingChurchId => accessibleChurchIds.includes(existingChurchId))) {
    res.status(403).json({ success: false, message: 'Access denied' });
    return;
  }

  await prisma.givingCampaign.update({
    where: { id: String(id) },
    data: { status: 'cancelled' },
  });

  res.json({ success: true, message: 'Campaign cancelled' });
}

function groupDonationRowsByPersonCampaign(rows: any[]) {
  type GroupedGivingRow = {
    donorKey: string;
    name: string;
    email: string;
    phone: string;
    donorType: string;
    campaign: string;
    category: string;
    cell: string;
    church: string;
    currency: string;
    totalAmount: number;
    transactionCount: number;
    paymentMethods: Set<string>;
    statuses: Set<string>;
    firstDonationDate: Date | null;
    lastDonationDate: Date | null;
  };

  const grouped = new Map<string, GroupedGivingRow>();

  for (const row of rows) {
    const donorType = row.isAnonymous ? 'Anonymous' : row.isGuest ? 'Guest' : row.user ? 'Member' : 'Donor';
    const name = row.isAnonymous
      ? 'Anonymous'
      : row.isGuest
        ? (row.guestName || row.donorName || 'Guest')
        : `${row.user?.firstName ?? ''} ${row.user?.lastName ?? ''}`.trim() || row.donorName || 'Donor';
    const email = row.isAnonymous ? '' : row.isGuest ? (row.guestEmail || row.donorEmail || '') : (row.user?.email || row.donorEmail || '');
    const phone = row.isAnonymous ? '' : row.isGuest ? (row.guestPhone || row.donorPhone || '') : (row.user?.phone || row.donorPhone || '');
    const donorIdentity = row.user?.id || email || phone || name || row.id;
    const campaignName = row.campaign?.name || '';
    const categoryName = row.campaign?.category || '';
    const cellName = row.cell?.name || '';
    const churchName = row.church?.name || '';
    const currency = row.currency || '';
    const key = [donorType, donorIdentity, row.campaignId, campaignName, churchName, cellName, currency].join('|');

    const existing = grouped.get(key) ?? {
      donorKey: donorIdentity,
      name,
      email,
      phone,
      donorType,
      campaign: campaignName,
      category: categoryName,
      cell: cellName,
      church: churchName,
      currency,
      totalAmount: 0,
      transactionCount: 0,
      paymentMethods: new Set<string>(),
      statuses: new Set<string>(),
      firstDonationDate: null,
      lastDonationDate: null,
    };

    existing.totalAmount += Number(row.amount || 0);
    existing.transactionCount += 1;
    if (row.paymentMethod) existing.paymentMethods.add(row.paymentMethod);
    if (row.status) existing.statuses.add(row.status);
    const createdAt = row.createdAt ? new Date(row.createdAt) : null;
    if (createdAt) {
      if (!existing.firstDonationDate || createdAt < existing.firstDonationDate) existing.firstDonationDate = createdAt;
      if (!existing.lastDonationDate || createdAt > existing.lastDonationDate) existing.lastDonationDate = createdAt;
    }

    grouped.set(key, existing);
  }

  return Array.from(grouped.values())
    .map(row => ({
      donorKey: row.donorKey,
      name: row.name,
      email: row.email,
      phone: row.phone,
      donorType: row.donorType,
      campaign: row.campaign,
      category: row.category,
      cell: row.cell,
      church: row.church,
      currency: row.currency,
      totalAmount: row.totalAmount,
      transactionCount: row.transactionCount,
      paymentMethods: Array.from(row.paymentMethods).join('; '),
      statuses: Array.from(row.statuses).join('; '),
      firstDonationDate: row.firstDonationDate,
      lastDonationDate: row.lastDonationDate,
    }))
    .sort((a, b) => b.totalAmount - a.totalAmount || a.name.localeCompare(b.name) || a.campaign.localeCompare(b.campaign));
}

export async function getDonations(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const roleName = req.user?.role;
  const { campaignId, churchId: filterChurchId, category, cellId, startDate, endDate } = req.query;
  const groupByPersonCampaign = req.query.groupByPersonCampaign === 'true';

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
      ...(category && { campaign: { is: { category: String(category) } } }),
      ...(Object.keys(dateFilter).length > 0 && { createdAt: dateFilter }),
    };
    if (groupByPersonCampaign) {
      const rows = await prisma.donationTransaction.findMany({
        where,
        select: {
          id: true,
          campaignId: true,
          amount: true,
          currency: true,
          status: true,
          isAnonymous: true,
          isGuest: true,
          donorName: true,
          donorEmail: true,
          donorPhone: true,
          guestName: true,
          guestEmail: true,
          guestPhone: true,
          createdAt: true,
          paymentMethod: true,
          campaign: { select: { name: true, category: true } },
          church: { select: { name: true } },
          user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
          cell: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 50000,
      });
      const groupedRows = groupDonationRowsByPersonCampaign(rows);
      const total = groupedRows.length;
      res.json({ success: true, data: groupedRows.slice(skip, skip + limit), pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
      return;
    }
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
    ...(category && { campaign: { is: { category: String(category) } } }),
    ...(cellId && { cellId: String(cellId) }),
    ...(Object.keys(dateFilter).length > 0 && { createdAt: dateFilter }),
  };

  const donationSelect = {
    id: true,
    campaignId: true,
    amount: true,
    currency: true,
    status: true,
    isAnonymous: true,
    // isManual: true,
    reference: true,
    donorName: true,
    donorEmail: true,
    donorPhone: true,
    isGuest: true,
    guestName: true,
    guestEmail: true,
    guestPhone: true,
    notes: true,
    createdAt: true,
    paymentMethod: true,
    campaign: { select: { name: true, category: true } },
    church: { select: { name: true } },
    user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
    cell: { select: { name: true } },
  };

  if (groupByPersonCampaign) {
    const rows = await prisma.donationTransaction.findMany({
      where,
      select: donationSelect,
      orderBy: { createdAt: 'desc' },
      take: 50000,
    });
    const groupedRows = groupDonationRowsByPersonCampaign(rows);
    const total = groupedRows.length;
    res.json({ success: true, data: groupedRows.slice(skip, skip + limit), pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
    return;
  }

  if (isExport) {
    // Export mode: respects limit + page for batched downloads
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
  churchId: z.string().optional(),
  amount: z.number().positive(),
  isAnonymous: z.boolean().optional().default(false),
  donorName: z.string().optional(),
  donorEmail: z.string().email().optional(),
  donorPhone: z.string().optional(),
  notes: z.string().optional(),
  cellId: z.string().optional(),
  pledgeId: z.string().optional(), // optional: pay against a specific pledge
});

const donationItemSchema = z.object({
  campaignId: z.string().min(1),
  churchId: z.string().optional(),
  amount: z.number().positive(),
  cellId: z.string().optional(),
  pledgeId: z.string().optional(),
});

const createMultipleDonationSchema = z.object({
  items: z.array(donationItemSchema).min(1).max(20),
  churchId: z.string().optional(),
  isAnonymous: z.boolean().optional().default(false),
  donorName: z.string().optional(),
  donorEmail: z.string().email().optional(),
  donorPhone: z.string().optional(),
  notes: z.string().optional(),
});

const createGuestMultipleDonationSchema = z.object({
  items: z.array(donationItemSchema.omit({ pledgeId: true })).min(1).max(20),
  churchId: z.string().optional(),
  guestName: z.string().min(1),
  guestEmail: z.string().email().optional().or(z.literal('')),
  guestPhone: z.string().trim().min(1, 'Phone is required'),
  donorType: z.enum(['auto', 'member', 'guest']).optional().default('auto'),
});

async function resolveDonationCampaigns(
  items: Array<{ campaignId: string; churchId?: string; amount: number; cellId?: string }>,
  requirePublic: boolean,
  options: {
    selectedChurchId?: string | null;
    userChurchId?: string | null;
    validateCellSelection?: boolean;
    requiredFeature?: string;
    requiredFeatureMessage?: string;
  } = {},
) {
  const validateCellSelection = options.validateCellSelection !== false;
  const ids = [...new Set(items.map(item => item.campaignId))];

  const campaigns = await prisma.givingCampaign.findMany({
    where: { id: { in: ids } },
    include: {
      church: { select: { id: true, name: true, ministryAdminId: true } },
      linkedChurches: { select: { churchId: true, church: { select: { id: true, name: true, ministryAdminId: true } } } },
    },
  });
  if (campaigns.length !== ids.length) {
    return { error: 'One or more campaigns were not found' };
  }
  if (campaigns.some(campaign => campaign.status !== 'active')) {
    return { error: 'One or more campaigns are not active' };
  }
  if (requirePublic && campaigns.some(campaign => !campaign.allowPublicDonations)) {
    return { error: 'One or more campaigns are not publicly available' };
  }
  if (requirePublic) {
    for (const campaign of campaigns) {
      const hasPublicLinks = await campaignOwnerHasFeature(campaign, 'giving_public_links');
      const hasQrCodes = await campaignOwnerHasFeature(campaign, 'giving_qr_codes');
      if (!hasPublicLinks && !hasQrCodes) {
        return { error: 'Public giving links are not available for this campaign.' };
      }
    }
  }

  const currencies = [...new Set(campaigns.map(campaign => campaign.currency))];
  if (currencies.length !== 1) {
    return { error: 'Please give to campaigns using one currency at a time' };
  }

  const campaignMap = new Map(campaigns.map(campaign => [campaign.id, campaign]));
  const itemChurchIds: string[] = [];

  for (const [index, item] of items.entries()) {
    const campaign = campaignMap.get(item.campaignId);
    if (!campaign) continue;

    if (options.requiredFeature) {
      const featureError = await ensureCampaignOwnerFeature(
        campaign,
        options.requiredFeature,
        options.requiredFeatureMessage || 'This giving feature is not available for this campaign.',
      );
      if (featureError) return featureError;
    }

    if (campaign.category === 'fellowship_offering') {
      const cellFeatureError = await ensureCampaignOwnerFeature(
        campaign,
        'giving_cell_offering',
        'Cell/Fellowship Offering is not available for this campaign.',
      );
      if (cellFeatureError) return cellFeatureError;
    }

    const campaignChurchIds = getCampaignChurchIds(campaign);
    const fallbackChurchId = options.userChurchId || options.selectedChurchId || (campaignChurchIds.length === 1 ? campaignChurchIds[0] : undefined);
    const itemChurchId = options.userChurchId || item.churchId || fallbackChurchId;
    if (!itemChurchId || !campaignChurchIds.includes(itemChurchId)) {
      return { error: `${campaign.name} is not available for the selected church` };
    }
    if (options.userChurchId && item.churchId && item.churchId !== options.userChurchId) {
      return { error: 'This campaign is not available for your church' };
    }
    itemChurchIds[index] = itemChurchId;

    if (validateCellSelection && campaign.category === 'fellowship_offering' && !item.cellId) {
      return { error: `Please select a cell/fellowship for ${campaign.name}` };
    }
    if (validateCellSelection && campaign.category === 'fellowship_offering' && item.cellId) {
      const cell = await prisma.cell.findFirst({
        where: { id: item.cellId, churchId: itemChurchId, status: 'active' },
        select: { id: true },
      });
      if (!cell) {
        return { error: `The selected cell/fellowship is not available for ${campaign.name}` };
      }
    }
  }

  const duplicateLineKeys = itemChurchIds.map((churchId, index) => `${items[index].campaignId}:${churchId}`);
  if (new Set(duplicateLineKeys).size !== duplicateLineKeys.length) {
    return { error: 'Each giving line must use a different campaign and church combination' };
  }

  const gatewayChurchId = options.userChurchId || options.selectedChurchId || itemChurchIds[0];
  if (!gatewayChurchId) {
    return { error: 'Select the church this giving should go to' };
  }

  return { campaigns, campaignMap, churchId: gatewayChurchId, itemChurchIds, currency: currencies[0], availableChurchIds: [...new Set(itemChurchIds)] };
}

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

  const { campaignId, churchId: selectedChurchId, amount, isAnonymous, donorName, donorEmail, donorPhone, notes, cellId, pledgeId } = parsed.data;

  const member = await prisma.user.findUnique({ where: { id: userId! }, select: { churchId: true } });
  if (!member?.churchId) {
    res.status(403).json({ success: false, message: 'Your account is not linked to a church' });
    return;
  }
  const resolved = await resolveDonationCampaigns(
    [{ campaignId, amount, cellId }],
    false,
    { userChurchId: member?.churchId ?? null, selectedChurchId },
  );
  if ('error' in resolved) {
    res.status(400).json({ success: false, message: resolved.error });
    return;
  }
  const campaign = resolved.campaignMap.get(campaignId)!;

  // Determine gateway using existing function
  const { getPaymentGateway, getCurrency, getGatewayCountry } = await import('../utils/gatewayRouter');
  const { calculatePaymentFees } = await import('../utils/feeCalculations');
  
  const gateway = await getPaymentGateway(userId!);
  const currency = getCurrency(gateway);
  const gatewayCountry = getGatewayCountry(gateway);
  if (currency !== resolved.currency) {
    res.status(400).json({ success: false, message: `Selected campaign uses ${resolved.currency}, but your payment gateway uses ${currency}` });
    return;
  }
  
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
      churchId: resolved.churchId,
      type: 'donation',
      expiresAt,
      metadata: JSON.stringify({
        traceId,
        campaignId,
        campaignName: campaign.name,
        userId,
        userName: req.user?.userName,
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

export async function createMultipleDonation(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const userEmail = req.user?.email;
  const traceId = `MDON-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  const parsed = createMultipleDonationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const { items, churchId: selectedChurchId, isAnonymous, donorName, donorEmail, donorPhone, notes } = parsed.data;
  const member = await prisma.user.findUnique({ where: { id: userId! }, select: { churchId: true } });
  if (!member?.churchId) {
    res.status(403).json({ success: false, message: 'Your account is not linked to a church' });
    return;
  }
  const resolved = await resolveDonationCampaigns(items, false, {
    userChurchId: member?.churchId ?? null,
    selectedChurchId,
  });
  if ('error' in resolved) {
    res.status(400).json({ success: false, message: resolved.error });
    return;
  }

  const { getPaymentGateway, getCurrency, getGatewayCountry } = await import('../utils/gatewayRouter');
  const { calculatePaymentFees } = await import('../utils/feeCalculations');

  const gateway = await getPaymentGateway(userId!);
  const currency = getCurrency(gateway);
  if (currency !== resolved.currency) {
    res.status(400).json({ success: false, message: `Selected campaigns use ${resolved.currency}, but your payment gateway uses ${currency}` });
    return;
  }
  const gatewayCountry = getGatewayCountry(gateway);
  const baseAmount = items.reduce((sum, item) => sum + item.amount, 0);
  const fees = calculatePaymentFees(baseAmount, gatewayCountry);

  const expiresAt = new Date();
  expiresAt.setMinutes(expiresAt.getMinutes() + 30);

  const pendingTx = await prisma.pendingTransaction.create({
    data: {
      amount: fees.totalAmount,
      currency,
      userId: userId!,
      churchId: resolved.churchId,
      type: 'donation',
      expiresAt,
      metadata: JSON.stringify({
        traceId,
        campaignId: items[0].campaignId,
        campaignName: resolved.campaignMap.get(items[0].campaignId)?.name,
        userId,
        userName: req.user?.userName,
        items: items.map((item, index) => ({
          campaignId: item.campaignId,
          campaignName: resolved.campaignMap.get(item.campaignId)?.name,
          churchId: resolved.itemChurchIds[index] || resolved.churchId,
          amount: item.amount,
          cellId: item.cellId || null,
          pledgeId: item.pledgeId || null,
        })),
        isGuest: false,
        isAnonymous,
        donorName,
        donorEmail,
        donorPhone,
        notes,
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

  const firstCampaign = resolved.campaignMap.get(items[0].campaignId);
  if (gateway === 'paychangu') {
    return await initiatePaychanguDonation(pendingTx, userEmail!, donorEmail, fees, traceId, res);
  }
  return await initiatePaystackDonation(pendingTx, userEmail!, donorEmail, firstCampaign, fees, currency, traceId, res);
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
  const metadata = pendingTx.metadata ? JSON.parse(pendingTx.metadata) : {};

  try {
    const amountInKobo = Math.round(fees.totalAmount * 100);
    const isGuest = metadata.isGuest === true;
    const callbackUrl = isGuest
      ? `${BACKEND_URL}/api/payments/verify?guestEmail=${encodeURIComponent(metadata.guestEmail || '')}&guestName=${encodeURIComponent(metadata.guestName)}&isGuest=true&type=donation`
      : `${BACKEND_URL}/api/payments/verify`;
    
    // Get church subaccount
    const subaccount = await prisma.subaccount.findUnique({
      where: { churchId: pendingTx.churchId }
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
    recordPaymentEvent('paystack', pendingTx.type || 'donation', 'initialized', donationLogMeta(traceId, pendingTx, metadata, {
      reference: response.data.data.reference,
      currency,
      gatewayStatus: response.status,
    }));
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
    recordPaymentEvent('paystack', pendingTx.type || 'donation', 'failed', donationLogMeta(traceId, pendingTx, metadata, {
      currency,
      errorMessage: error.message,
      gatewayStatus: error.response?.status,
    }));
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
  const metadata = pendingTx.metadata ? JSON.parse(pendingTx.metadata) : {};

  try {
    const isGuest = metadata.isGuest === true;
    const returnUrl = isGuest
      ? `${FRONTEND_URL}/payment/callback?status=success&type=donation&isGuest=true&reference=${tx_ref}&guestEmail=${encodeURIComponent(metadata.guestEmail || '')}&guestName=${encodeURIComponent(metadata.guestName)}&amount=${metadata.baseAmount}&currency=MWK`
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
      data: {
        reference: tx_ref,
        metadata: JSON.stringify({
          ...metadata,
          gatewayPayload: paychanguPayload,
        }),
      },
    });

    console.log(`[${traceId}] Paychangu SUCCESS`);
    recordPaymentEvent('paychangu', pendingTx.type || 'donation', 'initialized', donationLogMeta(traceId, pendingTx, metadata, {
      reference: tx_ref,
      currency: 'MWK',
      gatewayStatus: response.status,
    }));
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
    recordPaymentEvent('paychangu', pendingTx.type || 'donation', 'failed', donationLogMeta(traceId, pendingTx, metadata, {
      reference: tx_ref,
      currency: 'MWK',
      errorMessage: error.message,
      gatewayStatus: error.response?.status,
    }));
    await prisma.pendingTransaction.delete({ where: { id: pendingTx.id } }).catch(() => {});
    console.error(`[${traceId}] Paychangu error:`, error.message);
    res.status(500).json({
      success: false,
      message: error.response?.data?.message || 'Failed to initialize payment',
    });
  }
}

export async function getGuestDonationFees(req: Request, res: Response): Promise<void> {
  const { campaignId, amount, churchId } = req.query as { campaignId: string; amount: string; churchId?: string };
  if (!campaignId || !amount) {
    res.status(400).json({ success: false, message: 'campaignId and amount required' });
    return;
  }
  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    res.status(400).json({ success: false, message: 'Invalid amount' });
    return;
  }

  const resolved = await resolveDonationCampaigns(
    [{ campaignId, amount: parsedAmount }],
    true,
    {
      selectedChurchId: churchId ?? null,
      validateCellSelection: false,
      requiredFeature: 'giving_online_payments',
      requiredFeatureMessage: 'Online giving payments are not available for this campaign.',
    },
  );
  if ('error' in resolved) {
    res.status(400).json({ success: false, message: resolved.error });
    return;
  }

  const { getPaymentGatewayByChurch, getCurrency, getGatewayCountry } = await import('../utils/gatewayRouter');
  const { calculatePaymentFees } = await import('../utils/feeCalculations');

  const gateway = await getPaymentGatewayByChurch(resolved.churchId);
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
    include: {
      church: { select: { id: true, name: true, ministryAdminId: true } },
      linkedChurches: { select: { churchId: true, church: { select: { id: true, name: true, ministryAdminId: true } } } },
    },
  });

  if (!campaign || !campaign.allowPublicDonations) {
    res.status(404).json({ success: false, message: 'Campaign not found or not publicly available' });
    return;
  }

  if (campaign.status !== 'active') {
    res.status(400).json({ success: false, message: 'This campaign is no longer active' });
    return;
  }

  const hasPublicLinkFeature = await campaignOwnerHasFeature(campaign, 'giving_public_links');
  const hasQrFeature = await campaignOwnerHasFeature(campaign, 'giving_qr_codes');
  if (!hasPublicLinkFeature && !hasQrFeature) {
    res.status(403).json({ success: false, message: 'Public giving links are not available for this campaign.' });
    return;
  }

  if (campaign.category === 'fellowship_offering') {
    const cellFeatureError = await ensureCampaignOwnerFeature(
      campaign,
      'giving_cell_offering',
      'Cell/Fellowship Offering is not available for this campaign.',
    );
    if (cellFeatureError) {
      res.status(403).json({ success: false, message: cellFeatureError.error });
      return;
    }
  }

  const { targetAmount, ...publicFields } = campaign;

  res.json({ success: true, data: decorateCampaignAvailability(publicFields as any) });
}

const guestDonationSchema = z.object({
  campaignId: z.string().min(1),
  churchId: z.string().optional(),
  amount: z.number().positive(),
  guestName: z.string().min(1),
  guestEmail: z.string().email().optional().or(z.literal('')),
  guestPhone: z.string().trim().min(1, 'Phone is required'),
  cellId: z.string().optional(),
  donorType: z.enum(['auto', 'member', 'guest']).optional().default('auto'),
});

export async function createGuestDonation(req: Request, res: Response): Promise<void> {
  const traceId = `GDON-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  console.log(`[${traceId}] ========== GUEST DONATION INITIATED ==========`);

  const parsed = guestDonationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const { campaignId, churchId: selectedChurchId, amount, guestName, guestEmail, guestPhone, cellId, donorType } = parsed.data;
  const resolved = await resolveDonationCampaigns(
    [{ campaignId, amount, cellId }],
    true,
    {
      selectedChurchId,
      requiredFeature: 'giving_online_payments',
      requiredFeatureMessage: 'Online giving payments are not available for this campaign.',
    },
  );
  if ('error' in resolved) {
    res.status(400).json({ success: false, message: resolved.error });
    return;
  }
  const campaign = resolved.campaignMap.get(campaignId)!;

  const { getPaymentGatewayByChurch, getCurrency, getGatewayCountry } = await import('../utils/gatewayRouter');
  const { calculatePaymentFees } = await import('../utils/feeCalculations');

  const gateway = await getPaymentGatewayByChurch(resolved.churchId);
  const currency = getCurrency(gateway);
  const gatewayCountry = getGatewayCountry(gateway);
  const fees = calculatePaymentFees(amount, gatewayCountry);
  const matchedMember = donorType !== 'guest'
    ? await findDonationMemberByContact({
        churchId: resolved.churchId,
        email: guestEmail,
        phone: guestPhone,
      })
    : null;
  if (donorType === 'member' && !matchedMember) {
    res.status(400).json({
      success: false,
      message: 'We could not find a church member account matching that church and contact details. Check the selected church, phone, or email, or continue as a guest.',
    });
    return;
  }
  const resolvedDonorType = matchedMember ? 'member' : 'guest';
  const checkoutEmail = guestEmail || matchedMember?.email || process.env.DEFAULT_PAYMENT_EMAIL || 'payments@churchcentral.church';

  const expiresAt = new Date();
  expiresAt.setMinutes(expiresAt.getMinutes() + 30);

  const pendingTx = await prisma.pendingTransaction.create({
    data: {
      amount: fees.totalAmount,
      currency,
      userId: null,
      churchId: resolved.churchId,
      type: 'donation',
      expiresAt,
      metadata: JSON.stringify({
        traceId,
        campaignId,
        campaignName: campaign.name,
        isGuest: true,
        donorType: resolvedDonorType,
        requestedDonorType: donorType,
        guestName,
        guestEmail: guestEmail || null,
        guestPhone,
        matchedMemberId: matchedMember?.id || null,
        matchedMemberName: matchedMember ? `${matchedMember.firstName} ${matchedMember.lastName}`.trim() : null,
        linkedFromGuestContact: !!matchedMember,
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
    return await initiatePaychanguDonation(pendingTx, checkoutEmail, guestEmail || matchedMember?.email || undefined, fees, traceId, res);
  } else {
    return await initiatePaystackDonation(pendingTx, checkoutEmail, guestEmail || matchedMember?.email || undefined, campaign, fees, currency, traceId, res);
  }
}

export async function createGuestMultipleDonation(req: Request, res: Response): Promise<void> {
  const traceId = `GMDON-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  const parsed = createGuestMultipleDonationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const { items, churchId: selectedChurchId, guestName, guestEmail, guestPhone, donorType } = parsed.data;
  const resolved = await resolveDonationCampaigns(items, true, {
    selectedChurchId,
    requiredFeature: 'giving_online_payments',
    requiredFeatureMessage: 'Online giving payments are not available for this campaign.',
  });
  if ('error' in resolved) {
    res.status(400).json({ success: false, message: resolved.error });
    return;
  }

  const { getPaymentGatewayByChurch, getCurrency, getGatewayCountry } = await import('../utils/gatewayRouter');
  const { calculatePaymentFees } = await import('../utils/feeCalculations');

  const gateway = await getPaymentGatewayByChurch(resolved.churchId);
  const currency = getCurrency(gateway);
  if (currency !== resolved.currency) {
    res.status(400).json({ success: false, message: `Selected campaigns use ${resolved.currency}, but this church accepts ${currency}` });
    return;
  }
  const gatewayCountry = getGatewayCountry(gateway);
  const baseAmount = items.reduce((sum, item) => sum + item.amount, 0);
  const fees = calculatePaymentFees(baseAmount, gatewayCountry);
  const matchedMember = donorType !== 'guest'
    ? await findDonationMemberByContact({
        churchId: resolved.churchId,
        email: guestEmail,
        phone: guestPhone,
      })
    : null;
  if (donorType === 'member' && !matchedMember) {
    res.status(400).json({
      success: false,
      message: 'We could not find a church member account matching that church and contact details. Check the selected church, phone, or email, or continue as a guest.',
    });
    return;
  }
  const resolvedDonorType = matchedMember ? 'member' : 'guest';
  const checkoutEmail = guestEmail || matchedMember?.email || process.env.DEFAULT_PAYMENT_EMAIL || 'payments@churchcentral.church';

  const expiresAt = new Date();
  expiresAt.setMinutes(expiresAt.getMinutes() + 30);

  const pendingTx = await prisma.pendingTransaction.create({
    data: {
      amount: fees.totalAmount,
      currency,
      userId: null,
      churchId: resolved.churchId,
      type: 'donation',
      expiresAt,
      metadata: JSON.stringify({
        traceId,
        campaignId: items[0].campaignId,
        campaignName: resolved.campaignMap.get(items[0].campaignId)?.name,
        items: items.map((item, index) => ({
          campaignId: item.campaignId,
          campaignName: resolved.campaignMap.get(item.campaignId)?.name,
          churchId: resolved.itemChurchIds[index] || resolved.churchId,
          amount: item.amount,
          cellId: item.cellId || null,
        })),
        isGuest: true,
        donorType: resolvedDonorType,
        requestedDonorType: donorType,
        guestName,
        guestEmail: guestEmail || null,
        guestPhone,
        matchedMemberId: matchedMember?.id || null,
        matchedMemberName: matchedMember ? `${matchedMember.firstName} ${matchedMember.lastName}`.trim() : null,
        linkedFromGuestContact: !!matchedMember,
        isAnonymous: false,
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

  const firstCampaign = resolved.campaignMap.get(items[0].campaignId);
  if (gateway === 'paychangu') {
    return await initiatePaychanguDonation(pendingTx, checkoutEmail, guestEmail || matchedMember?.email || undefined, fees, traceId, res);
  }
  return await initiatePaystackDonation(pendingTx, checkoutEmail, guestEmail || matchedMember?.email || undefined, firstCampaign, fees, currency, traceId, res);
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
  churchId: z.string().optional(),
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
  pledgeId: z.string().optional(),
});

export async function recordCashDonation(req: Request, res: Response): Promise<void> {
  const adminId = req.user?.userId;
  const roleName = req.user?.role;

  const parsed = recordCashDonationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const { campaignId, churchId: selectedChurchId, donorType, memberId, guestName, guestEmail, guestPhone, amount, currency, date, reference, notes, cellId, pledgeId } = parsed.data;

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


  // For member type — verify member exists and is in scope
  let resolvedUserId: string | null = null;
  let memberChurchId: string | null = null;
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
    memberChurchId = member.churchId ?? null;
  }

  const resolved = await resolveDonationCampaigns(
    [{ campaignId, amount, cellId }],
    false,
    { selectedChurchId: selectedChurchId ?? memberChurchId },
  );
  if ('error' in resolved) {
    res.status(400).json({ success: false, message: resolved.error });
    return;
  }
  if (!accessibleChurchIds.includes(resolved.churchId)) {
    res.status(403).json({ success: false, message: 'Access denied to this campaign' });
    return;
  }

  let resolvedPledgeId: string | null = null;
  if (donorType === 'member' && resolvedUserId) {
    if (pledgeId) {
      const pledge = await prisma.pledge.findFirst({
        where: {
          id: pledgeId,
          userId: resolvedUserId,
          campaignId,
          status: { in: ['pending', 'partial', 'overdue'] },
        },
        select: { id: true },
      });
      if (!pledge) {
        res.status(400).json({ success: false, message: 'Selected pledge is not active for this member and campaign' });
        return;
      }
      resolvedPledgeId = pledge.id;
    } else {
      const activePledge = await prisma.pledge.findFirst({
        where: {
          userId: resolvedUserId,
          campaignId,
          status: { in: ['pending', 'partial', 'overdue'] },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      resolvedPledgeId = activePledge?.id ?? null;
    }
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
      churchId: resolved.churchId,
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
      churchId: resolved.churchId,
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
      pledgeId: resolvedPledgeId || undefined,
    },
    include: {
      campaign: { select: { name: true, category: true } },
      user: { select: { firstName: true, lastName: true, email: true } },
      church: { select: { name: true } },
    },
  });

  if (resolvedPledgeId) {
    const { recalculatePledgeStatus } = await import('./pledgeController');
    await recalculatePledgeStatus(resolvedPledgeId);
  }

  res.status(201).json({ success: true, data: donation });
}

// ─── GET /api/giving/campaigns/:id/cells — public, no auth ───────────────────
// Returns active cells for the church that owns this campaign (for fellowship_offering)

export async function getPublicCampaignCells(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const selectedChurchId = req.query.churchId as string | undefined;

  const resolved = await resolveDonationCampaigns(
    [{ campaignId: String(id), amount: 1 }],
    true,
    {
      selectedChurchId: selectedChurchId ?? null,
      validateCellSelection: false,
      requiredFeature: 'giving_cell_offering',
      requiredFeatureMessage: 'Cell/Fellowship Offering is not available for this campaign.',
    },
  );
  if ('error' in resolved) {
    res.status(400).json({ success: false, message: resolved.error });
    return;
  }

  const cells = await prisma.cell.findMany({
    where: { churchId: resolved.churchId, status: 'active' },
    select: { id: true, name: true, zone: true },
    orderBy: { name: 'asc' },
  });

  res.json({ success: true, data: cells });
}
