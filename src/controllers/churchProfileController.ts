import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { hasFeature } from '../lib/packageChecker';
import { queueEmail } from '../lib/emailQueue';
import { visitRequestTemplate } from '../lib/emailTemplates';

// ─── Schemas ──────────────────────────────────────────────────────────────────

const profileSchema = z.object({
  // Branding
  logoUrl:      z.string().nullable().optional().or(z.literal('')),
  bannerUrl:    z.string().nullable().optional().or(z.literal('')),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  tagline:      z.string().max(200).nullable().optional(),
  // About
  aboutText:    z.string().max(5000).nullable().optional(),
  pastorName:   z.string().max(100).nullable().optional(),
  pastorPhoto:  z.string().nullable().optional().or(z.literal('')),
  pastorBio:    z.string().max(2000).nullable().optional(),
  visionText:   z.string().max(1000).nullable().optional(),
  missionText:  z.string().max(1000).nullable().optional(),
  // Service times — JSON string validated as array
  serviceTimes: z.string().nullable().optional(),
  // Contact
  phone:          z.string().max(30).nullable().optional(),
  email:          z.string().email().nullable().optional().or(z.literal('')),
  address:        z.string().max(300).nullable().optional(),
  facebookUrl:    z.string().nullable().optional().or(z.literal('')),
  youtubeUrl:     z.string().nullable().optional().or(z.literal('')),
  whatsappNumber: z.string().max(30).nullable().optional(),
  // Publish
  isPublished: z.boolean().optional(),
});

const sermonSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(150),
  youtubeUrl: z.string().trim().url('Enter a valid YouTube URL'),
  speaker: z.string().trim().max(100).nullable().optional().or(z.literal('')),
  series: z.string().trim().max(100).nullable().optional().or(z.literal('')),
  duration: z.string().trim().max(50).nullable().optional().or(z.literal('')),
  sermonDate: z.string().nullable().optional().or(z.literal('')),
  description: z.string().trim().max(2000).nullable().optional().or(z.literal('')),
  isActive: z.boolean().optional(),
  sortOrder: z.coerce.number().int().min(0).optional(),
});

const ministrySchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  description: z.string().trim().min(1, 'Description is required').max(2000),
  imageUrl: z.string().trim().max(500).nullable().optional().or(z.literal('')),
  icon: z.string().trim().max(50).nullable().optional().or(z.literal('')),
  isActive: z.boolean().optional(),
  sortOrder: z.coerce.number().int().min(0).optional(),
});

const visitRequestSchema = z.object({
  firstName: z.string().trim().min(1, 'First name is required').max(80),
  lastName: z.string().trim().min(1, 'Last name is required').max(80),
  email: z.string().trim().email('Valid email is required').max(150),
  phone: z.string().trim().max(40).nullable().optional().or(z.literal('')),
  serviceName: z.string().trim().max(120).nullable().optional().or(z.literal('')),
  notes: z.string().trim().max(1500).nullable().optional().or(z.literal('')),
});

// Fields that require the church_website package feature
const GATED_FIELDS = [
  'logoUrl', 'bannerUrl', 'primaryColor', 'tagline',
  'aboutText', 'pastorName', 'pastorPhoto', 'pastorBio', 'visionText', 'missionText',
  'serviceTimes',
  'phone', 'email', 'address', 'facebookUrl', 'youtubeUrl', 'whatsappNumber',
];

function getManagedMinistryAdminId(req: Request): string | null {
  const authUser = req.user as any;
  if (!authUser?.userId) return null;
  return authUser.ministryAdminId || authUser.userId;
}

function normalizeOptionalString(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function parseOptionalDate(value?: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// ─── GET /api/church-profile ──────────────────────────────────────────────────

export async function getMyProfile(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  if (!userId) { res.status(401).json({ success: false, message: 'Not authenticated' }); return; }

  const profile = await prisma.churchProfile.findUnique({
    where: { ministryAdminId: userId },
  });

  const hasWebsite = await hasFeature(userId, 'church_website');

  // Also return the subdomain so the admin can see their URL
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { subdomain: true, ministryName: true },
  });

  res.json({
    success: true,
    data: profile ?? null,
    subdomain: user?.subdomain ?? null,
    ministryName: user?.ministryName ?? null,
    hasWebsiteFeature: hasWebsite,
  });
}

// ─── PUT /api/church-profile ──────────────────────────────────────────────────

export async function updateMyProfile(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  if (!userId) { res.status(401).json({ success: false, message: 'Not authenticated' }); return; }

  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const data = parsed.data;
  const hasWebsite = await hasFeature(userId, 'church_website');

  // Strip gated fields if the admin doesn't have the feature
  if (!hasWebsite) {
    for (const field of GATED_FIELDS) {
      delete (data as any)[field];
    }
    // Also block publishing without the feature
    if (data.isPublished) {
      res.status(403).json({
        success: false,
        message: 'Upgrade to Standard or Premium to publish your church website.',
      });
      return;
    }
  }

  const profile = await prisma.churchProfile.upsert({
    where: { ministryAdminId: userId },
    update: { ...data, updatedAt: new Date() },
    create: { ministryAdminId: userId, ...data },
  });

  res.json({ success: true, data: profile });
}

export async function listWebsiteSermons(req: Request, res: Response): Promise<void> {
  const ministryAdminId = getManagedMinistryAdminId(req);
  if (!ministryAdminId) { res.status(401).json({ success: false, message: 'Not authenticated' }); return; }

  const sermons = await prisma.churchSermon.findMany({
    where: { ministryAdminId },
    orderBy: [{ sortOrder: 'asc' }, { sermonDate: 'desc' }, { createdAt: 'desc' }],
  });

  res.json({ success: true, data: sermons });
}

export async function createWebsiteSermon(req: Request, res: Response): Promise<void> {
  const ministryAdminId = getManagedMinistryAdminId(req);
  if (!ministryAdminId) { res.status(401).json({ success: false, message: 'Not authenticated' }); return; }

  const parsed = sermonSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const data = parsed.data;
  const sermon = await prisma.churchSermon.create({
    data: {
      ministryAdminId,
      title: data.title,
      youtubeUrl: data.youtubeUrl,
      speaker: normalizeOptionalString(data.speaker),
      series: normalizeOptionalString(data.series),
      duration: normalizeOptionalString(data.duration),
      sermonDate: parseOptionalDate(data.sermonDate),
      description: normalizeOptionalString(data.description),
      isActive: data.isActive ?? true,
      sortOrder: data.sortOrder ?? 0,
    },
  });

  res.status(201).json({ success: true, data: sermon });
}

export async function updateWebsiteSermon(req: Request, res: Response): Promise<void> {
  const ministryAdminId = getManagedMinistryAdminId(req);
  if (!ministryAdminId) { res.status(401).json({ success: false, message: 'Not authenticated' }); return; }
  const sermonId = String(req.params.id);

  const parsed = sermonSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const existing = await prisma.churchSermon.findFirst({
    where: { id: sermonId, ministryAdminId },
    select: { id: true },
  });
  if (!existing) { res.status(404).json({ success: false, message: 'Sermon not found' }); return; }

  const data = parsed.data;
  const sermon = await prisma.churchSermon.update({
    where: { id: existing.id },
    data: {
      title: data.title,
      youtubeUrl: data.youtubeUrl,
      speaker: normalizeOptionalString(data.speaker),
      series: normalizeOptionalString(data.series),
      duration: normalizeOptionalString(data.duration),
      sermonDate: parseOptionalDate(data.sermonDate),
      description: normalizeOptionalString(data.description),
      isActive: data.isActive ?? true,
      sortOrder: data.sortOrder ?? 0,
    },
  });

  res.json({ success: true, data: sermon });
}

export async function deleteWebsiteSermon(req: Request, res: Response): Promise<void> {
  const ministryAdminId = getManagedMinistryAdminId(req);
  if (!ministryAdminId) { res.status(401).json({ success: false, message: 'Not authenticated' }); return; }
  const sermonId = String(req.params.id);

  const existing = await prisma.churchSermon.findFirst({
    where: { id: sermonId, ministryAdminId },
    select: { id: true },
  });
  if (!existing) { res.status(404).json({ success: false, message: 'Sermon not found' }); return; }

  await prisma.churchSermon.delete({ where: { id: existing.id } });
  res.json({ success: true });
}

export async function listWebsiteMinistries(req: Request, res: Response): Promise<void> {
  const ministryAdminId = getManagedMinistryAdminId(req);
  if (!ministryAdminId) { res.status(401).json({ success: false, message: 'Not authenticated' }); return; }

  const ministries = await prisma.churchMinistry.findMany({
    where: { ministryAdminId },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
  });

  res.json({ success: true, data: ministries });
}

export async function createWebsiteMinistry(req: Request, res: Response): Promise<void> {
  const ministryAdminId = getManagedMinistryAdminId(req);
  if (!ministryAdminId) { res.status(401).json({ success: false, message: 'Not authenticated' }); return; }

  const parsed = ministrySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const data = parsed.data;
  const ministry = await prisma.churchMinistry.create({
    data: {
      ministryAdminId,
      name: data.name,
      description: data.description,
      imageUrl: normalizeOptionalString(data.imageUrl),
      icon: normalizeOptionalString(data.icon),
      isActive: data.isActive ?? true,
      sortOrder: data.sortOrder ?? 0,
    },
  });

  res.status(201).json({ success: true, data: ministry });
}

export async function updateWebsiteMinistry(req: Request, res: Response): Promise<void> {
  const ministryAdminId = getManagedMinistryAdminId(req);
  if (!ministryAdminId) { res.status(401).json({ success: false, message: 'Not authenticated' }); return; }
  const ministryId = String(req.params.id);

  const parsed = ministrySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const existing = await prisma.churchMinistry.findFirst({
    where: { id: ministryId, ministryAdminId },
    select: { id: true },
  });
  if (!existing) { res.status(404).json({ success: false, message: 'Ministry not found' }); return; }

  const data = parsed.data;
  const ministry = await prisma.churchMinistry.update({
    where: { id: existing.id },
    data: {
      name: data.name,
      description: data.description,
      imageUrl: normalizeOptionalString(data.imageUrl),
      icon: normalizeOptionalString(data.icon),
      isActive: data.isActive ?? true,
      sortOrder: data.sortOrder ?? 0,
    },
  });

  res.json({ success: true, data: ministry });
}

export async function deleteWebsiteMinistry(req: Request, res: Response): Promise<void> {
  const ministryAdminId = getManagedMinistryAdminId(req);
  if (!ministryAdminId) { res.status(401).json({ success: false, message: 'Not authenticated' }); return; }
  const ministryId = String(req.params.id);

  const existing = await prisma.churchMinistry.findFirst({
    where: { id: ministryId, ministryAdminId },
    select: { id: true },
  });
  if (!existing) { res.status(404).json({ success: false, message: 'Ministry not found' }); return; }

  await prisma.churchMinistry.delete({ where: { id: existing.id } });
  res.json({ success: true });
}

export async function submitVisitRequest(req: Request, res: Response): Promise<void> {
  const { slug } = req.params;
  const parsed = visitRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const slugStr = String(slug || '');
  const user = await prisma.user.findFirst({
    where: {
      OR: [
        { subdomain: slugStr },
        { subdomain: { startsWith: `${slugStr}.` } },
      ],
    },
    select: { id: true, email: true, ministryName: true, firstName: true, lastName: true },
  });

  if (!user) {
    res.status(404).json({ success: false, message: 'Church not found' });
    return;
  }

  const profile = await prisma.churchProfile.findUnique({
    where: { ministryAdminId: user.id },
    select: { email: true, isPublished: true },
  });

  if (!profile?.isPublished) {
    res.status(404).json({ success: false, message: 'This church page is not published yet' });
    return;
  }

  const data = parsed.data;
  const visitRequest = await prisma.visitRequest.create({
    data: {
      ministryAdminId: user.id,
      firstName: data.firstName,
      lastName: data.lastName,
      email: data.email,
      phone: normalizeOptionalString(data.phone),
      serviceName: normalizeOptionalString(data.serviceName),
      notes: normalizeOptionalString(data.notes),
      sourceSlug: slugStr,
    },
  });

  const ministryName = user.ministryName ?? `${user.firstName} ${user.lastName}`;
  const recipient = profile.email || user.email;
  await queueEmail(
    recipient,
    `New visit request - ${ministryName}`,
    visitRequestTemplate({
      ministryName,
      firstName: visitRequest.firstName,
      lastName: visitRequest.lastName,
      email: visitRequest.email,
      phone: visitRequest.phone,
      serviceName: visitRequest.serviceName,
      notes: visitRequest.notes,
      submittedAt: visitRequest.createdAt.toLocaleString('en-US', { timeZone: 'Africa/Nairobi' }),
    }),
    'visit_request'
  );

  res.status(201).json({ success: true, message: 'Visit request received' });
}

// ─── GET /api/p/:slug — fully public, no auth ─────────────────────────────────

export async function getPublicProfile(req: Request, res: Response): Promise<void> {
  const { slug } = req.params;

  if (!slug) {
    res.status(400).json({ success: false, message: 'Slug is required' });
    return;
  }

  // Find the ministry admin whose subdomain matches this slug
  // subdomain is stored as full domain e.g. "grace-church.churchcentral.church"
  // or just the slug "grace-church" — handle both
  const slugStr = String(slug);
  const user = await prisma.user.findFirst({
    where: {
      OR: [
        { subdomain: slugStr },
        { subdomain: { startsWith: `${slugStr}.` } },
      ],
    },
    select: { id: true, ministryName: true, firstName: true, lastName: true },
  });

  if (!user) {
    res.status(404).json({ success: false, message: 'Church not found' });
    return;
  }

  const profile = await prisma.churchProfile.findUnique({
    where: { ministryAdminId: user.id },
  });

  if (!profile?.isPublished) {
    res.status(404).json({ success: false, message: 'This church page is not published yet' });
    return;
  }

  // Get all church IDs belonging to this ministry admin
  const churches = await (prisma.church.findMany as any)({
    where: { ministryAdminId: user.id, status: 'active' },
    select: { id: true, name: true, address: true, latitude: true, longitude: true },
  }) as Array<{ id: string; name: string; address?: string | null; latitude?: number | null; longitude?: number | null }>;
  const churchIds = churches.map(c => c.id);

  const [sermons, ministries] = await Promise.all([
    prisma.churchSermon.findMany({
      where: { ministryAdminId: user.id, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { sermonDate: 'desc' }, { createdAt: 'desc' }],
      take: 6,
    }),
    prisma.churchMinistry.findMany({
      where: { ministryAdminId: user.id, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      take: 8,
    }),
  ]);

  // If no churches, return empty events/campaigns — don't risk a full-table scan
  if (churchIds.length === 0) {
    res.json({
      success: true,
      data: {
        profile,
        ministryName: user.ministryName ?? `${user.firstName} ${user.lastName}`,
        events: [],
        campaigns: [],
        churches: [],
        sermons,
        ministries,
      },
    });
    return;
  }

  // Public events — upcoming, allowPublicTicketing
  const events = await prisma.event.findMany({
    where: {
      churchId: { in: churchIds },
      status: 'upcoming',
      date: { gte: new Date() },
      OR: [
        { allowPublicTicketing: true },
        { requiresTicket: false },
      ],
    },
    select: {
      id: true, title: true, description: true, date: true, endDate: true,
      time: true, location: true, imageUrl: true, isFree: true,
      ticketPrice: true, currency: true, requiresTicket: true,
      church: { select: { name: true } },
    },
    orderBy: { date: 'asc' },
    take: 100,
  });

  // Public campaigns — active, allowPublicDonations
  const campaigns = await prisma.givingCampaign.findMany({
    where: {
      OR: [
        { churchId: { in: churchIds } },
        { linkedChurches: { some: { churchId: { in: churchIds } } } },
      ],
      allowPublicDonations: true,
      status: 'active',
    },
    select: {
      id: true, churchId: true, scopeType: true, name: true, description: true, category: true,
      targetAmount: true, currency: true, imageUrl: true,
      church: { select: { id: true, name: true } },
      linkedChurches: { select: { churchId: true, church: { select: { id: true, name: true } } } },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  const publicCampaigns = campaigns.map(campaign => ({
    ...campaign,
    availableChurches: campaign.linkedChurches.length > 0
      ? campaign.linkedChurches.map(link => ({ id: link.churchId, name: link.church.name }))
      : [{ id: campaign.churchId, name: campaign.church.name }],
  }));

  res.json({
    success: true,
    data: {
      profile,
      ministryName: user.ministryName ?? `${user.firstName} ${user.lastName}`,
      churches,
      events,
      campaigns: publicCampaigns,
      sermons,
      ministries,
    },
  });
}
