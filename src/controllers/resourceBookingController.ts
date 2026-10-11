import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import prisma from '../lib/prisma';
import { getAccessibleChurchIds } from '../lib/churchScope';
import { BookingError, blockedInterval, findConflict, lockResources, newBookingGroupId, resolveActivity, resolveBookingMinistry } from '../services/resourceBookingService';

const resourceSchema = z.object({
  churchId: z.string().min(1),
  name: z.string().trim().min(2).max(191),
  code: z.string().trim().max(80).optional().nullable(),
  category: z.enum(['room', 'hall', 'vehicle', 'instrument', 'media', 'projector', 'equipment', 'other']),
  description: z.string().trim().max(5000).optional().nullable(),
  location: z.string().trim().max(191).optional().nullable(),
  custodianName: z.string().trim().max(191).optional().nullable(),
  scope: z.enum(['own_church', 'all_ministry']).default('own_church'),
  status: z.enum(['active', 'maintenance', 'retired']).default('active'),
  approvalRequired: z.boolean().default(false),
  bufferBeforeMinutes: z.coerce.number().int().min(0).max(1440).default(0),
  bufferAfterMinutes: z.coerce.number().int().min(0).max(1440).default(0),
});
const requestSchema = z.object({
  churchId: z.string().min(1),
  resourceIds: z.array(z.string()).min(1).max(20),
  activityType: z.enum(['manual', 'service', 'event']).default('manual'),
  activityId: z.string().optional().nullable(),
  activityTitle: z.string().trim().max(191).optional(),
  purpose: z.string().trim().max(5000).optional().nullable(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
});
const includeBooking = {
  resource: { select: { id: true, name: true, category: true, churchId: true, location: true } },
  requester: { select: { id: true, firstName: true, lastName: true } },
  decidedBy: { select: { id: true, firstName: true, lastName: true } },
} as const;

function resourceImages(value: string | null): string[] {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch { return []; }
}

function withImages<T extends { imageUrls: string | null }>(resource: T) {
  const { imageUrls, ...fields } = resource;
  return { ...fields, images: resourceImages(imageUrls) };
}

async function deleteResourceImageFile(url: string) {
  if (!/^\/uploads\/bookable-resources\/[A-Za-z0-9._-]+$/.test(url)) return;
  await fs.promises.unlink(path.join(process.cwd(), 'uploads', 'bookable-resources', path.basename(url))).catch(error => {
    if (error?.code !== 'ENOENT') console.error('[Resource Booking] Could not remove image:', error);
  });
}

async function context(req: Request) {
  const userId = req.user!.userId;
  const [ministryAdminId, churchIds] = await Promise.all([
    resolveBookingMinistry(userId),
    getAccessibleChurchIds(req.user?.role || 'member', req.user?.churchId, req.user?.districts, req.user?.traditionalAuthorities, req.user?.regions, userId),
  ]);
  return { userId, ministryAdminId, churchIds };
}

function respondError(res: Response, error: unknown) {
  if (error instanceof BookingError) return res.status(error.statusCode).json({ success: false, message: error.message });
  throw error;
}

export async function listBookableResources(req: Request, res: Response) {
  const { ministryAdminId, churchIds } = await context(req);
  const churchId = typeof req.query.churchId === 'string' ? req.query.churchId : undefined;
  if (churchId && !churchIds.includes(churchId)) return res.status(403).json({ success: false, message: 'Branch access denied' });
  const resources = await prisma.bookableResource.findMany({
    where: {
      ministryAdminId,
      ...(churchId ? { OR: [{ churchId }, { scope: 'all_ministry' }] } : { OR: [{ churchId: { in: churchIds } }, { scope: 'all_ministry' }] }),
      ...(req.query.status ? { status: String(req.query.status) } : {}),
    },
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
  });
  return res.json({ success: true, data: resources.map(withImages) });
}

export async function createBookableResource(req: Request, res: Response) {
  const parsed = resourceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: parsed.error.errors[0].message });
  const { userId, ministryAdminId, churchIds } = await context(req);
  if (!churchIds.includes(parsed.data.churchId)) return res.status(403).json({ success: false, message: 'Branch access denied' });
  const asset = await prisma.bookableResource.create({ data: { ...parsed.data, ministryAdminId, createdById: userId } });
  return res.status(201).json({ success: true, data: withImages(asset) });
}

export async function updateBookableResource(req: Request, res: Response) {
  const parsed = resourceSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: parsed.error.errors[0].message });
  const { ministryAdminId, churchIds } = await context(req);
  const asset = await prisma.bookableResource.findFirst({ where: { id: String(req.params.id), ministryAdminId } });
  if (!asset) return res.status(404).json({ success: false, message: 'Resource not found' });
  if (!churchIds.includes(asset.churchId) || (parsed.data.churchId && !churchIds.includes(parsed.data.churchId))) return res.status(403).json({ success: false, message: 'Branch access denied' });
  if (parsed.data.churchId && parsed.data.churchId !== asset.churchId && await prisma.resourceBooking.count({ where: { resourceId: asset.id, status: { in: ['pending', 'approved'] } } })) return res.status(409).json({ success: false, message: 'Cancel active bookings before moving this resource to another branch' });
  if (parsed.data.status && parsed.data.status !== 'active' && asset.status === 'active' && await prisma.resourceBooking.count({ where: { resourceId: asset.id, status: { in: ['pending', 'approved'] }, endsAt: { gt: new Date() } } })) return res.status(409).json({ success: false, message: 'Cancel upcoming bookings before making this resource unavailable' });
  const updated = await prisma.bookableResource.update({ where: { id: asset.id }, data: parsed.data });
  return res.json({ success: true, data: withImages(updated) });
}

export async function authorizeResourceImageUpload(req: Request, res: Response, next: NextFunction) {
  const { ministryAdminId, churchIds } = await context(req);
  const asset = await prisma.bookableResource.findFirst({ where: { id: String(req.params.id), ministryAdminId, churchId: { in: churchIds } }, select: { id: true } });
  if (!asset) return res.status(404).json({ success: false, message: 'Resource not found' });
  (req as any).uploadSubDir = 'bookable-resources';
  next();
}

export async function uploadBookableResourceImage(req: Request, res: Response) {
  if (!req.file) return res.status(400).json({ success: false, message: 'Choose an image' });
  const url = `/uploads/bookable-resources/${req.file.filename}`;
  try {
    const asset = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM bookable_resources WHERE id = ${String(req.params.id)} FOR UPDATE`;
      const current = await tx.bookableResource.findUniqueOrThrow({ where: { id: String(req.params.id) } });
      const images = resourceImages(current.imageUrls);
      if (images.length >= 3) throw new BookingError('A resource can have at most 3 images', 409);
      return tx.bookableResource.update({ where: { id: current.id }, data: { imageUrls: JSON.stringify([...images, url]) } });
    });
    return res.status(201).json({ success: true, data: withImages(asset) });
  } catch (error) {
    await deleteResourceImageFile(url);
    return respondError(res, error);
  }
}

export async function removeBookableResourceImage(req: Request, res: Response) {
  const parsed = z.object({ url: z.string() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: 'Image URL is required' });
  const { ministryAdminId, churchIds } = await context(req);
  const asset = await prisma.bookableResource.findFirst({ where: { id: String(req.params.id), ministryAdminId, churchId: { in: churchIds } }, select: { id: true } });
  if (!asset) return res.status(404).json({ success: false, message: 'Resource not found' });
  try {
    const updated = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM bookable_resources WHERE id = ${asset.id} FOR UPDATE`;
      const current = await tx.bookableResource.findUniqueOrThrow({ where: { id: asset.id } });
      const images = resourceImages(current.imageUrls);
      if (!images.includes(parsed.data.url)) throw new BookingError('Image not found on this resource', 404);
      return tx.bookableResource.update({ where: { id: asset.id }, data: { imageUrls: JSON.stringify(images.filter(url => url !== parsed.data.url)) } });
    });
    await deleteResourceImageFile(parsed.data.url);
    return res.json({ success: true, data: withImages(updated) });
  } catch (error) { return respondError(res, error); }
}

export async function listResourceBookings(req: Request, res: Response) {
  const { ministryAdminId, churchIds, userId } = await context(req);
  const canSeeAll = ['resource_booking:read', 'resource_booking:approve', 'resource_booking:manage'].some(permission => req.user?.permissions?.includes(permission));
  const requestedChurchId = typeof req.query.churchId === 'string' ? req.query.churchId : undefined;
  if (requestedChurchId && !churchIds.includes(requestedChurchId)) return res.status(403).json({ success: false, message: 'Branch access denied' });
  const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
  const limit = Math.min(100, Math.max(10, Math.floor(Number(req.query.limit) || 30)));
  const where: any = {
    ministryAdminId,
    OR: [{ churchId: { in: requestedChurchId ? [requestedChurchId] : churchIds } }, { resource: { churchId: { in: requestedChurchId ? [requestedChurchId] : churchIds } } }],
    ...(!canSeeAll ? { requesterId: userId } : {}),
    ...(req.query.status ? { status: String(req.query.status) } : {}),
    ...(req.query.resourceId ? { resourceId: String(req.query.resourceId) } : {}),
    ...(req.query.activityType && req.query.activityId ? { activityType: String(req.query.activityType), activityId: String(req.query.activityId) } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.resourceBooking.findMany({ where, include: includeBooking, orderBy: { startsAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    prisma.resourceBooking.count({ where }),
  ]);
  return res.json({ success: true, data: items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
}

export async function getBookingActivityWindow(req: Request, res: Response) {
  const parsed = z.object({ churchId: z.string().min(1), activityType: z.enum(['service', 'event']), activityId: z.string().min(1) }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ success: false, message: 'Select a service or event' });
  const { ministryAdminId, churchIds } = await context(req);
  if (!churchIds.includes(parsed.data.churchId)) return res.status(403).json({ success: false, message: 'Branch access denied' });
  try {
    const activity = await resolveActivity({ ministryAdminId, churchId: parsed.data.churchId, activityType: parsed.data.activityType, activityId: parsed.data.activityId });
    return res.json({ success: true, data: activity });
  } catch (error) { return respondError(res, error); }
}

export async function checkResourceAvailability(req: Request, res: Response) {
  const parsed = z.object({ resourceIds: z.array(z.string()).min(1).max(20), startsAt: z.string().datetime(), endsAt: z.string().datetime(), churchId: z.string() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: parsed.error.errors[0].message });
  const { ministryAdminId, churchIds } = await context(req);
  if (!churchIds.includes(parsed.data.churchId)) return res.status(403).json({ success: false, message: 'Branch access denied' });
  const startsAt = new Date(parsed.data.startsAt);
  const endsAt = new Date(parsed.data.endsAt);
  if (startsAt >= endsAt) return res.status(400).json({ success: false, message: 'End time must be after start time' });
  const resources = await prisma.bookableResource.findMany({ where: { id: { in: parsed.data.resourceIds }, ministryAdminId, OR: [{ churchId: parsed.data.churchId }, { scope: 'all_ministry' }] } });
  if (resources.length !== new Set(parsed.data.resourceIds).size) return res.status(403).json({ success: false, message: 'One or more resources are unavailable for this branch' });
  const data = await Promise.all(resources.map(async resource => {
    const interval = blockedInterval(resource, startsAt, endsAt);
    const conflict = await findConflict(prisma, resource.id, interval.blockedFrom, interval.blockedUntil);
    return { resourceId: resource.id, available: resource.status === 'active' && !conflict, conflict };
  }));
  return res.json({ success: true, data });
}

export async function requestResourceBooking(req: Request, res: Response) {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: parsed.error.errors[0].message });
  const { userId, ministryAdminId, churchIds } = await context(req);
  const input = parsed.data;
  if (!churchIds.includes(input.churchId)) return res.status(403).json({ success: false, message: 'Branch access denied' });
  const ids = [...new Set(input.resourceIds)];
  if (ids.length !== input.resourceIds.length) return res.status(400).json({ success: false, message: 'Select each resource only once' });
  try {
    const activity = await resolveActivity({ ministryAdminId, ...input });
    if (activity.startsAt < new Date()) throw new BookingError('Booking start time must be in the future');
    const groupId = newBookingGroupId();
    const bookings = await prisma.$transaction(async tx => {
      await lockResources(tx, ids);
      const resources = await tx.bookableResource.findMany({ where: { id: { in: ids }, ministryAdminId, status: 'active', OR: [{ churchId: input.churchId }, { scope: 'all_ministry' }] } });
      if (resources.length !== ids.length) throw new BookingError('One or more resources are unavailable for this branch', 403);
      for (const resource of resources) {
        const interval = blockedInterval(resource, activity.startsAt, activity.endsAt);
        const conflict = await findConflict(tx, resource.id, interval.blockedFrom, interval.blockedUntil);
        if (conflict) throw new BookingError(`${resource.name} is reserved for ${conflict.activityTitle} from ${conflict.startsAt.toISOString()} to ${conflict.endsAt.toISOString()}`, 409);
        if (activity.activityId && await tx.resourceBooking.count({ where: { resourceId: resource.id, activityType: input.activityType, activityId: activity.activityId, status: 'pending' } })) throw new BookingError(`${resource.name} already has a pending request for this activity`, 409);
      }
      const created = [];
      for (const resource of resources) {
        const interval = blockedInterval(resource, activity.startsAt, activity.endsAt);
        created.push(await tx.resourceBooking.create({
          data: {
            groupId, resourceId: resource.id, ministryAdminId, churchId: input.churchId, requesterId: userId,
            activityType: input.activityType, activityId: activity.activityId, activityTitle: activity.activityTitle,
            purpose: input.purpose || null, startsAt: activity.startsAt, endsAt: activity.endsAt, ...interval,
            status: resource.approvalRequired ? 'pending' : 'approved',
            ...(!resource.approvalRequired ? { decidedById: userId, decidedAt: new Date() } : {}),
          },
          include: includeBooking,
        }));
      }
      return created;
    });
    return res.status(201).json({ success: true, data: bookings });
  } catch (error) { return respondError(res, error); }
}

export async function decideResourceBooking(req: Request, res: Response) {
  const parsed = z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().trim().max(2000).optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: parsed.error.errors[0].message });
  const { ministryAdminId, churchIds, userId } = await context(req);
  const existing = await prisma.resourceBooking.findFirst({ where: { id: String(req.params.id), ministryAdminId, OR: [{ churchId: { in: churchIds } }, { resource: { churchId: { in: churchIds } } }] } });
  if (!existing) return res.status(404).json({ success: false, message: 'Booking not found' });
  try {
    const booking = await prisma.$transaction(async tx => {
      await lockResources(tx, [existing.resourceId]);
      const current = await tx.resourceBooking.findUnique({ where: { id: existing.id }, include: { resource: true } });
      if (!current || current.status !== 'pending') throw new BookingError('Only pending requests can be decided', 409);
      if (parsed.data.decision === 'approved') {
        if (current.resource.status !== 'active') throw new BookingError('Resource is unavailable', 409);
        const conflict = await findConflict(tx, current.resourceId, current.blockedFrom, current.blockedUntil, current.id);
        if (conflict) throw new BookingError(`${current.resource.name} was already booked for ${conflict.activityTitle}`, 409);
      }
      return tx.resourceBooking.update({ where: { id: current.id }, data: { status: parsed.data.decision, decidedById: userId, decidedAt: new Date(), decisionNote: parsed.data.note || null }, include: includeBooking });
    });
    return res.json({ success: true, data: booking });
  } catch (error) { return respondError(res, error); }
}

export async function cancelResourceBooking(req: Request, res: Response) {
  const { ministryAdminId, churchIds, userId } = await context(req);
  const existing = await prisma.resourceBooking.findFirst({ where: { id: String(req.params.id), ministryAdminId, churchId: { in: churchIds } } });
  if (!existing) return res.status(404).json({ success: false, message: 'Booking not found' });
  if (existing.requesterId !== userId && !req.user?.permissions?.includes('resource_booking:manage') && !req.user?.permissions?.includes('resource_booking:approve')) return res.status(403).json({ success: false, message: 'You cannot cancel this booking' });
  const allowedStatuses = req.user?.permissions?.includes('resource_booking:manage') ? ['pending', 'approved', 'blocked'] : ['pending', 'approved'];
  if (!allowedStatuses.includes(existing.status)) return res.status(409).json({ success: false, message: 'Booking is already closed' });
  const result = await prisma.resourceBooking.updateMany({ where: { id: existing.id, status: { in: allowedStatuses } }, data: { status: 'cancelled', decidedById: userId, decidedAt: new Date() } });
  if (!result.count) return res.status(409).json({ success: false, message: 'Booking was changed by someone else' });
  return res.json({ success: true });
}

export async function blockResource(req: Request, res: Response) {
  const parsed = z.object({ startsAt: z.string().datetime(), endsAt: z.string().datetime(), reason: z.string().trim().min(2).max(191) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: parsed.error.errors[0].message });
  const { ministryAdminId, churchIds, userId } = await context(req);
  const resource = await prisma.bookableResource.findFirst({ where: { id: String(req.params.id), ministryAdminId, churchId: { in: churchIds } } });
  if (!resource) return res.status(404).json({ success: false, message: 'Resource not found' });
  const startsAt = new Date(parsed.data.startsAt), endsAt = new Date(parsed.data.endsAt);
  if (startsAt >= endsAt) return res.status(400).json({ success: false, message: 'End time must be after start time' });
  try {
    const booking = await prisma.$transaction(async tx => {
      await lockResources(tx, [resource.id]);
      const interval = blockedInterval(resource, startsAt, endsAt);
      const conflict = await findConflict(tx, resource.id, interval.blockedFrom, interval.blockedUntil);
      if (conflict) throw new BookingError(`Resource already booked for ${conflict.activityTitle}`, 409);
      return tx.resourceBooking.create({ data: { groupId: newBookingGroupId(), resourceId: resource.id, ministryAdminId, churchId: resource.churchId, requesterId: userId, activityType: 'maintenance', activityTitle: parsed.data.reason, startsAt, endsAt, ...interval, status: 'blocked', decidedById: userId, decidedAt: new Date() } });
    });
    return res.status(201).json({ success: true, data: booking });
  } catch (error) { return respondError(res, error); }
}
