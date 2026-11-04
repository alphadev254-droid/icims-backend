import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { getAccessibleChurchIds } from '../lib/churchScope';
import { calculateNextReportRun, REPORT_DEFINITIONS, reportAutomationInputSchema } from '../lib/reportAutomation';
import { resolveTimeZone } from '../lib/timezone';

async function context(req: Request) {
  const user = req.user!;
  const accessibleChurchIds = await getAccessibleChurchIds(user.role, user.churchId, user.districts, user.traditionalAuthorities, user.regions, user.userId);
  const row = await prisma.user.findUnique({ where: { id: user.userId }, select: { ministryAdminId: true, church: { select: { ministryAdminId: true } } } });
  const ministryAdminId = user.role === 'ministry_admin' ? user.userId : row?.ministryAdminId ?? row?.church?.ministryAdminId ?? null;
  return { user, ministryAdminId, accessibleChurchIds };
}

function validateChurchFilter(filters: Record<string, string | string[]>, accessibleChurchIds: string[]) {
  const selected = filters.churchId;
  if (!selected || selected === 'all') return;
  const ids = Array.isArray(selected) ? selected : [selected];
  if (ids.some(id => !accessibleChurchIds.includes(id))) throw new Error('CHURCH_SCOPE');
}

async function validateRecipientUsers(userIds: string[], ministryAdminId: string) {
  if (!userIds.length) return;
  const count = await prisma.user.count({ where: { id: { in: [...new Set(userIds)] }, OR: [{ id: ministryAdminId }, { ministryAdminId }, { church: { ministryAdminId } }], status: 'active' } });
  if (count !== new Set(userIds).size) throw new Error('RECIPIENT_SCOPE');
}

export const reportAutomationController = {
  async contextInfo(req: Request, res: Response) {
    const { ministryAdminId } = await context(req);
    if (!ministryAdminId) return res.status(403).json({ success: false, message: 'Ministry context is required' });
    const timezone = await resolveTimeZone({ req, ministryAdminId });
    res.json({ success: true, data: { timezone } });
  },
  async definitions(_req: Request, res: Response) {
    res.json({ success: true, data: REPORT_DEFINITIONS });
  },
  async recipients(req: Request, res: Response) {
    const { ministryAdminId, accessibleChurchIds } = await context(req);
    if (!ministryAdminId) return res.status(403).json({ success: false, message: 'Ministry context is required' });
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    if (search.length > 0 && search.length < 3) {
      return res.json({ success: true, data: [] });
    }
    const users = await prisma.user.findMany({
      where: {
        status: 'active',
        email: { not: '' },
        AND: [
          { OR: [
            { id: ministryAdminId },
            { ministryAdminId },
            { churchId: { in: accessibleChurchIds } },
          ] },
          { OR: [{ id: ministryAdminId }, { role: { is: { name: { not: 'member' } } } }] },
          ...(search ? [{ OR: [
            { firstName: { contains: search } },
            { lastName: { contains: search } },
            { email: { contains: search } },
          ] }] : []),
        ],
      },
      select: { id: true, firstName: true, lastName: true, email: true, church: { select: { id: true, name: true } } },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }], take: search ? 100 : 50,
    });
    res.json({ success: true, data: users });
  },
  async list(req: Request, res: Response) {
    const { ministryAdminId } = await context(req);
    if (!ministryAdminId) return res.status(403).json({ success: false, message: 'Ministry context is required' });
    const reportType = typeof req.query.reportType === 'string' ? req.query.reportType : undefined;
    const data = await prisma.reportAutomation.findMany({ where: { ministryAdminId, ...(reportType ? { reportType } : {}) }, include: { runs: { orderBy: { createdAt: 'desc' }, take: 1 } }, orderBy: { createdAt: 'desc' } });
    res.json({ success: true, data });
  },
  async create(req: Request, res: Response) {
    try {
      const data = reportAutomationInputSchema.parse(req.body);
      const { user, ministryAdminId, accessibleChurchIds } = await context(req);
      if (!ministryAdminId) return res.status(403).json({ success: false, message: 'Ministry context is required' });
      validateChurchFilter(data.filters, accessibleChurchIds);
      await validateRecipientUsers(data.recipients.userIds, ministryAdminId);
      const created = await prisma.reportAutomation.create({ data: { ...data, filters: data.filters, recipients: data.recipients, ministryAdminId, createdById: user.userId, nextRunAt: calculateNextReportRun(data) } });
      res.status(201).json({ success: true, data: created });
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ success: false, message: 'Invalid report automation settings', errors: error.flatten() });
      if ((error as Error).message === 'CHURCH_SCOPE' || (error as Error).message === 'RECIPIENT_SCOPE') return res.status(403).json({ success: false, message: 'A selected church or recipient is outside your access scope' });
      throw error;
    }
  },
  async update(req: Request, res: Response) {
    try {
      const data = reportAutomationInputSchema.parse(req.body);
      const { ministryAdminId, accessibleChurchIds } = await context(req);
      if (!ministryAdminId) return res.status(403).json({ success: false, message: 'Ministry context is required' });
      const automationId = String(req.params.id);
      const existing = await prisma.reportAutomation.findFirst({ where: { id: automationId, ministryAdminId }, select: { id: true } });
      if (!existing) return res.status(404).json({ success: false, message: 'Report automation not found' });
      validateChurchFilter(data.filters, accessibleChurchIds);
      await validateRecipientUsers(data.recipients.userIds, ministryAdminId);
      const updated = await prisma.reportAutomation.update({ where: { id: existing.id }, data: { ...data, filters: data.filters, recipients: data.recipients, nextRunAt: calculateNextReportRun(data) } });
      res.json({ success: true, data: updated });
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ success: false, message: 'Invalid report automation settings', errors: error.flatten() });
      if ((error as Error).message === 'CHURCH_SCOPE' || (error as Error).message === 'RECIPIENT_SCOPE') return res.status(403).json({ success: false, message: 'A selected church or recipient is outside your access scope' });
      throw error;
    }
  },
  async remove(req: Request, res: Response) {
    const { ministryAdminId } = await context(req);
    if (!ministryAdminId) return res.status(403).json({ success: false, message: 'Ministry context is required' });
    const result = await prisma.reportAutomation.deleteMany({ where: { id: String(req.params.id), ministryAdminId } });
    if (!result.count) return res.status(404).json({ success: false, message: 'Report automation not found' });
    res.json({ success: true, message: 'Report automation deleted' });
  },
  async runs(req: Request, res: Response) {
    const { ministryAdminId } = await context(req);
    if (!ministryAdminId) return res.status(403).json({ success: false, message: 'Ministry context is required' });
    const automation = await prisma.reportAutomation.findFirst({ where: { id: String(req.params.id), ministryAdminId }, select: { id: true } });
    if (!automation) return res.status(404).json({ success: false, message: 'Report automation not found' });
    const data = await prisma.reportAutomationRun.findMany({ where: { automationId: automation.id }, orderBy: { createdAt: 'desc' }, take: 50 });
    res.json({ success: true, data });
  },
};
