import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { getAccessibleChurchIds } from '../lib/churchScope';
import { dateRangeInTimeZone, resolveTimeZone } from '../lib/timezone';

const serviceSchema = z
  .object({
    churchId: z.string().min(1),
    title: z.string().trim().min(1).max(191),
    type: z.string().trim().max(191).optional().nullable(),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime().optional().nullable(),
    location: z.string().trim().max(191).optional().nullable(),
    description: z.string().trim().optional().nullable(),
    status: z
      .enum(['scheduled', 'completed', 'cancelled'])
      .default('scheduled'),
  })
  .refine(
    (value) =>
      !value.endsAt || new Date(value.endsAt) > new Date(value.startsAt),
    {
      message: 'End time must be after start time',
      path: ['endsAt'],
    },
  );

export async function accessibleChurchIds(req: Request) {
  return getAccessibleChurchIds(
    req.user?.role ?? 'member',
    req.user?.churchId,
    req.user?.districts,
    req.user?.traditionalAuthorities,
    req.user?.regions,
    req.user?.userId,
  );
}

export async function listServices(req: Request, res: Response) {
  const ids = await accessibleChurchIds(req);
  const churchId =
    typeof req.query.churchId === 'string' ? req.query.churchId : undefined;
  if (churchId && !ids.includes(churchId))
    return res.status(403).json({ success: false, message: 'Access denied' });
  const filters = z.object({
    startDate: z.string().date().optional(),
    endDate: z.string().date().optional(),
    search: z.string().trim().max(100).optional(),
    page: z.coerce.number().int().min(1).optional(),
  }).safeParse(req.query);
  if (!filters.success || (filters.data.startDate && filters.data.endDate && filters.data.startDate > filters.data.endDate))
    return res.status(400).json({ success: false, message: 'Invalid service date range' });
  const { startDate, endDate, search, page } = filters.data;
  const timeZone = await resolveTimeZone({ req, churchId });
  const dateRange = dateRangeInTimeZone(startDate, endDate, timeZone);
  const limit = page ? 50 : 500;
  const where = {
    churchId: { in: churchId ? [churchId] : ids },
    ...(startDate || endDate ? { startsAt: dateRange } : {}),
    ...(search ? { OR: [
      { title: { contains: search } },
      { type: { contains: search } },
      { church: { name: { contains: search } } },
    ] } : {}),
  };
  const services = await prisma.service.findMany({
    where,
    include: {
      church: { select: { id: true, name: true } },
      attendance: { select: { id: true } },
      program: { select: { id: true } },
    },
    orderBy: [{ startsAt: 'desc' }, { id: 'desc' }],
    skip: page ? (page - 1) * limit : 0,
    take: page ? limit + 1 : limit,
  });
  return res.json({
    success: true,
    data: page ? services.slice(0, limit) : services,
    ...(page ? { hasMore: services.length > limit, total: await prisma.service.count({ where }) } : {}),
  });
}

export async function getService(req: Request, res: Response) {
  const service = await prisma.service.findUnique({
    where: { id: String(req.params.id) },
    include: {
      church: { select: { id: true, name: true } },
      attendance: { select: { id: true } },
      program: { select: { id: true } },
    },
  });
  if (!service)
    return res
      .status(404)
      .json({ success: false, message: 'Service not found' });
  if (!(await accessibleChurchIds(req)).includes(service.churchId))
    return res.status(403).json({ success: false, message: 'Access denied' });
  return res.json({ success: true, data: service });
}

export async function createService(req: Request, res: Response) {
  const parsed = serviceSchema.safeParse(req.body);
  if (!parsed.success)
    return res
      .status(400)
      .json({ success: false, message: parsed.error.errors[0].message });
  if (!(await accessibleChurchIds(req)).includes(parsed.data.churchId))
    return res.status(403).json({ success: false, message: 'Access denied' });
  const { startsAt, endsAt, ...fields } = parsed.data;
  const service = await prisma.service.create({
    data: {
      ...fields,
      startsAt: new Date(startsAt),
      endsAt: endsAt ? new Date(endsAt) : null,
    },
  });
  return res.status(201).json({ success: true, data: service });
}

export async function updateService(req: Request, res: Response) {
  const existing = await prisma.service.findUnique({
    where: { id: String(req.params.id) },
    include: { attendance: { select: { id: true } } },
  });
  if (!existing)
    return res
      .status(404)
      .json({ success: false, message: 'Service not found' });
  const ids = await accessibleChurchIds(req);
  if (!ids.includes(existing.churchId))
    return res.status(403).json({ success: false, message: 'Access denied' });
  const parsed = serviceSchema.safeParse(req.body);
  if (!parsed.success)
    return res
      .status(400)
      .json({ success: false, message: parsed.error.errors[0].message });
  if (!ids.includes(parsed.data.churchId))
    return res.status(403).json({ success: false, message: 'Access denied' });
  if (existing.attendance && parsed.data.churchId !== existing.churchId)
    return res
      .status(409)
      .json({
        success: false,
        message: 'A service with attendance cannot move to another church',
      });
  const { startsAt, endsAt, ...fields } = parsed.data;
  const service = await prisma.$transaction(async (tx) => {
    const updated = await tx.service.update({
      where: { id: existing.id },
      data: {
        ...fields,
        startsAt: new Date(startsAt),
        endsAt: endsAt ? new Date(endsAt) : null,
      },
    });
    if (existing.attendance)
      await tx.attendance.update({
        where: { id: existing.attendance.id },
        data: {
          date: updated.startsAt,
          serviceType: updated.type || updated.title,
        },
      });
    return updated;
  });
  return res.json({ success: true, data: service });
}

export async function deleteService(req: Request, res: Response) {
  const service = await prisma.service.findUnique({
    where: { id: String(req.params.id) },
    include: { attendance: { select: { id: true } } },
  });
  if (!service)
    return res
      .status(404)
      .json({ success: false, message: 'Service not found' });
  if (!(await accessibleChurchIds(req)).includes(service.churchId))
    return res.status(403).json({ success: false, message: 'Access denied' });
  if (service.attendance)
    return res
      .status(409)
      .json({
        success: false,
        message: 'This service has attendance and cannot be deleted',
      });
  await prisma.service.delete({ where: { id: service.id } });
  return res.json({ success: true });
}
