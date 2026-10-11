import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { emailQueue } from '../lib/bullQueue';

const campaignSchema = z.object({
  title: z.string().trim().min(2).max(191),
  summary: z.string().trim().max(500).optional().nullable(),
  message: z.string().trim().min(2).max(20000),
  category: z.enum(['system_update', 'maintenance', 'new_feature', 'billing', 'policy', 'security', 'general']).default('general'),
  priority: z.enum(['normal', 'important', 'urgent']).default('normal'),
  visibilityPolicy: z.enum(['standard', 'mandatory']).default('standard'),
  audienceType: z.enum(['all_ministries', 'selected_ministries', 'filtered']).default('all_ministries'),
  audienceFilters: z.object({
    ministryIds: z.array(z.string()).max(5000).optional(),
    country: z.string().trim().max(100).optional(),
    status: z.string().trim().max(50).optional(),
  }).default({}),
  channels: z.object({ inApp: z.literal(true).default(true), email: z.boolean().default(false), push: z.boolean().default(false) }).default({ inApp: true, email: false, push: false }),
  actionLabel: z.string().trim().max(80).optional().nullable(),
  actionUrl: z.string().trim().max(191).refine(value => !value || value.startsWith('/'), 'Action URL must be an internal path').optional().nullable(),
});

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function serializeCampaign(campaign: any) {
  return {
    ...campaign,
    audienceFilters: parseJson(campaign.audienceFilters, {}),
    channels: parseJson(campaign.channels, { inApp: true, email: false, push: false }),
  };
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char] as string));
}

function campaignEmailHtml(firstName: string, title: string, message: string, actionLabel?: string | null, actionUrl?: string | null) {
  const frontend = (process.env.FRONTEND_URL || 'http://localhost:8080').replace(/\/$/, '');
  const button = actionLabel && actionUrl
    ? `<p style="margin-top:24px"><a href="${frontend}${escapeHtml(actionUrl)}" style="background:#c58b18;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">${escapeHtml(actionLabel)}</a></p>`
    : '';
  return `<div class="container" style="font-family:Arial,sans-serif;max-width:640px;margin:auto;padding:24px"><p>Hello ${escapeHtml(firstName)},</p><h2>${escapeHtml(title)}</h2><div style="white-space:pre-wrap;line-height:1.6">${escapeHtml(message)}</div>${button}<p style="margin-top:28px;color:#666;font-size:12px">This is an official ICIMS system notification.</p></div>`;
}

async function ministryAudience(filters: z.infer<typeof campaignSchema>['audienceFilters'], audienceType: string) {
  const ministryRole = await prisma.role.findUnique({ where: { name: 'ministry_admin' }, select: { id: true } });
  if (!ministryRole) return [];
  const where: any = { roleId: ministryRole.id, loginEnabled: true, status: filters.status || 'active' };
  if (audienceType === 'selected_ministries') where.id = { in: filters.ministryIds || [] };
  if (filters.country) where.accountCountry = filters.country;
  return prisma.user.findMany({
    where,
    select: { id: true, firstName: true, lastName: true, email: true, ministryName: true, accountCountry: true, ownedChurches: { select: { name: true }, take: 1 } },
    orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
  });
}

export async function previewCampaignAudience(req: Request, res: Response) {
  const parsed = campaignSchema.pick({ audienceType: true, audienceFilters: true }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: parsed.error.errors[0].message });
  const users = await ministryAudience(parsed.data.audienceFilters, parsed.data.audienceType);
  return res.json({ success: true, data: { count: users.length, sample: users.slice(0, 10).map(user => ({ id: user.id, name: `${user.firstName} ${user.lastName}`, email: user.email, ministryName: user.ministryName || user.ownedChurches[0]?.name || null, country: user.accountCountry })) } });
}

export async function listCampaigns(req: Request, res: Response) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 25));
  const where: any = req.query.status ? { status: String(req.query.status) } : {};
  const [items, total] = await Promise.all([
    prisma.systemCampaign.findMany({ where, include: { createdBy: { select: { firstName: true, lastName: true } }, _count: { select: { recipients: true } } }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    prisma.systemCampaign.count({ where }),
  ]);
  res.json({ success: true, data: items.map(serializeCampaign), pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
}

export async function getCampaign(req: Request, res: Response) {
  const item = await prisma.systemCampaign.findUnique({ where: { id: String(req.params.id) }, include: { createdBy: { select: { firstName: true, lastName: true } }, recipients: { orderBy: { createdAt: 'desc' }, take: 200 } } });
  if (!item) return res.status(404).json({ success: false, message: 'Campaign not found' });
  res.json({ success: true, data: serializeCampaign(item) });
}

export async function createCampaign(req: Request, res: Response) {
  const parsed = campaignSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: parsed.error.errors[0].message });
  const item = await prisma.systemCampaign.create({ data: { ...parsed.data, audienceFilters: JSON.stringify(parsed.data.audienceFilters), channels: JSON.stringify(parsed.data.channels), createdById: req.user!.userId } });
  res.status(201).json({ success: true, data: serializeCampaign(item) });
}

export async function updateCampaign(req: Request, res: Response) {
  const current = await prisma.systemCampaign.findUnique({ where: { id: String(req.params.id) } });
  if (!current) return res.status(404).json({ success: false, message: 'Campaign not found' });
  if (current.status !== 'draft') return res.status(409).json({ success: false, message: 'Only draft campaigns can be edited' });
  const parsed = campaignSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: parsed.error.errors[0].message });
  const item = await prisma.systemCampaign.update({ where: { id: current.id }, data: { ...parsed.data, audienceFilters: JSON.stringify(parsed.data.audienceFilters), channels: JSON.stringify(parsed.data.channels) } });
  res.json({ success: true, data: serializeCampaign(item) });
}

export async function deleteCampaign(req: Request, res: Response) {
  const result = await prisma.systemCampaign.deleteMany({ where: { id: String(req.params.id), status: 'draft' } });
  if (!result.count) return res.status(409).json({ success: false, message: 'Only draft campaigns can be deleted' });
  res.json({ success: true });
}

export async function sendCampaign(req: Request, res: Response) {
  const id = String(req.params.id);
  const campaign = await prisma.systemCampaign.findUnique({ where: { id } });
  if (!campaign) return res.status(404).json({ success: false, message: 'Campaign not found' });
  if (campaign.status !== 'draft') return res.status(409).json({ success: false, message: 'Campaign has already been sent or queued' });
  const filters = parseJson<any>(campaign.audienceFilters, {});
  const channels = parseJson<any>(campaign.channels, { inApp: true });
  const users = await ministryAudience(filters, campaign.audienceType);
  if (!users.length) return res.status(400).json({ success: false, message: 'The selected audience has no eligible ministry accounts' });

  const claimed = await prisma.systemCampaign.updateMany({ where: { id, status: 'draft' }, data: { status: 'sending', sendingStartedAt: new Date() } });
  if (!claimed.count) return res.status(409).json({ success: false, message: 'Campaign is already being processed' });

  await prisma.systemCampaignRecipient.createMany({
    data: users.map(user => ({ campaignId: id, userId: user.id, ministryAdminId: user.id, recipientName: `${user.firstName} ${user.lastName}`, recipientEmail: user.email, ministryName: user.ministryName || user.ownedChurches[0]?.name || null, country: user.accountCountry, inAppStatus: 'sent', emailStatus: channels.email ? 'queued' : 'not_requested', pushStatus: 'not_requested' })),
    skipDuplicates: true,
  });
  const recipients = await prisma.systemCampaignRecipient.findMany({ where: { campaignId: id } });
  if (channels.email) {
    const byId = new Map(users.map(user => [user.id, user]));
    await Promise.all(recipients.map(async recipient => {
      const user = byId.get(recipient.userId)!;
      try {
        await emailQueue.add('send-email', { to: recipient.recipientEmail, subject: campaign.title, html: campaignEmailHtml(user.firstName, campaign.title, campaign.message, campaign.actionLabel, campaign.actionUrl), emailType: 'system_campaign', campaignRecipientId: recipient.id }, { jobId: `campaign-${id}-${recipient.id}-email` });
      } catch (error: any) {
        await prisma.systemCampaignRecipient.update({ where: { id: recipient.id }, data: { emailStatus: 'failed', lastError: error.message } });
      }
    }));
  }
  const completed = await prisma.systemCampaign.update({ where: { id }, data: { status: 'sent', sentAt: new Date() } });
  res.json({ success: true, data: serializeCampaign(completed), message: `Campaign sent to ${recipients.length} ministry account${recipients.length === 1 ? '' : 's'}` });
}
