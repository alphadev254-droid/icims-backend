import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { hasFeature } from '../lib/packageChecker';

// ─── Schemas ──────────────────────────────────────────────────────────────────

const profileSchema = z.object({
  // Branding
  logoUrl:      z.string().optional().or(z.literal('')),
  bannerUrl:    z.string().optional().or(z.literal('')),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  tagline:      z.string().max(200).optional(),
  // About
  aboutText:    z.string().max(5000).optional(),
  pastorName:   z.string().max(100).optional(),
  pastorPhoto:  z.string().optional().or(z.literal('')),
  pastorBio:    z.string().max(2000).optional(),
  visionText:   z.string().max(1000).optional(),
  missionText:  z.string().max(1000).optional(),
  // Service times — JSON string validated as array
  serviceTimes: z.string().optional(),
  // Contact
  phone:          z.string().max(30).optional(),
  email:          z.string().email().optional().or(z.literal('')),
  address:        z.string().max(300).optional(),
  facebookUrl:    z.string().optional().or(z.literal('')),
  youtubeUrl:     z.string().optional().or(z.literal('')),
  whatsappNumber: z.string().max(30).optional(),
  // Publish
  isPublished: z.boolean().optional(),
});

// Fields that require the church_website package feature
const GATED_FIELDS = [
  'logoUrl', 'bannerUrl', 'primaryColor', 'tagline',
  'aboutText', 'pastorName', 'pastorPhoto', 'pastorBio', 'visionText', 'missionText',
  'serviceTimes',
  'phone', 'email', 'address', 'facebookUrl', 'youtubeUrl', 'whatsappNumber',
];

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
    where: { ministryAdminId: user.id },
    select: { id: true, name: true, address: true, latitude: true, longitude: true },
  }) as Array<{ id: string; name: string; address?: string | null; latitude?: number | null; longitude?: number | null }>;
  const churchIds = churches.map(c => c.id);

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
      },
    });
    return;
  }

  // Public events — upcoming, allowPublicTicketing
  const events = await prisma.event.findMany({
    where: {
      churchId: { in: churchIds },
      allowPublicTicketing: true,
      status: 'upcoming',
      date: { gte: new Date() },
    },
    select: {
      id: true, title: true, description: true, date: true, endDate: true,
      time: true, location: true, imageUrl: true, isFree: true,
      ticketPrice: true, currency: true, requiresTicket: true,
      church: { select: { name: true } },
    },
    orderBy: { date: 'asc' },
    take: 6,
  });

  // Public campaigns — active, allowPublicDonations
  const campaigns = await prisma.givingCampaign.findMany({
    where: {
      churchId: { in: churchIds },
      allowPublicDonations: true,
      status: 'active',
    },
    select: {
      id: true, name: true, description: true, category: true,
      targetAmount: true, currency: true, imageUrl: true,
      church: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 6,
  });

  res.json({
    success: true,
    data: {
      profile,
      ministryName: user.ministryName ?? `${user.firstName} ${user.lastName}`,
      churches,
      events,
      campaigns,
    },
  });
}
