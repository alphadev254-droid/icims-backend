import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { searchActiveMembers } from '../lib/memberSearch';
import { accessibleChurchIds } from './serviceController';

const itemSchema = z
  .object({
    title: z.string().trim().min(1).max(191),
    description: z.string().trim().optional().nullable(),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    userId: z.string().optional().nullable(),
    guestName: z.string().trim().max(191).optional().nullable(),
    guestEmail: z
      .union([z.string().trim().email(), z.literal('')])
      .optional()
      .nullable(),
    guestPhone: z.string().trim().max(191).optional().nullable(),
  })
  .superRefine((item, ctx) => {
    if (new Date(item.endsAt) <= new Date(item.startsAt))
      ctx.addIssue({
        code: 'custom',
        message: 'Item end time must be after start time',
        path: ['endsAt'],
      });
    if (item.userId && item.guestName)
      ctx.addIssue({
        code: 'custom',
        message: 'Choose a user or a guest',
        path: ['userId'],
      });
    if (!item.userId && !item.guestName)
      ctx.addIssue({
        code: 'custom',
        message: 'Choose a user or enter a guest name',
        path: ['guestName'],
      });
  });

const programSchema = z.object({
  title: z.string().trim().min(1).max(191),
  description: z.string().trim().optional().nullable(),
  items: z.array(itemSchema).max(100),
});

const programInclude = {
  items: {
    orderBy: { position: 'asc' as const },
    include: {
      user: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
        },
      },
    },
  },
};

async function target(req: Request) {
  const id = String(req.params.id);
  const ids = await accessibleChurchIds(req);
  if (req.baseUrl.endsWith('/services')) {
    const service = await prisma.service.findUnique({ where: { id } });
    if (!service) return { error: 404, message: 'Service not found' };
    if (!ids.includes(service.churchId))
      return { error: 403, message: 'Access denied' };
    return {
      personChurchIds: [service.churchId],
      serviceId: service.id,
      eventId: null,
    };
  }
  const event = await prisma.event.findUnique({
    where: { id },
    include: { linkedChurches: { select: { churchId: true } } },
  });
  if (!event) return { error: 404, message: 'Event not found' };
  if (
    !ids.includes(event.churchId) &&
    !event.linkedChurches.some((link) => ids.includes(link.churchId))
  ) {
    return { error: 403, message: 'Access denied' };
  }
  return {
    personChurchIds: [
      event.churchId,
      ...event.linkedChurches.map((link) => link.churchId),
    ].filter((id) => ids.includes(id)),
    serviceId: null,
    eventId: event.id,
  };
}

export async function getProgram(req: Request, res: Response) {
  const resolved = await target(req);
  if (resolved.error)
    return res
      .status(resolved.error)
      .json({ success: false, message: resolved.message });
  const program = await prisma.program.findFirst({
    where: resolved.serviceId
      ? { serviceId: resolved.serviceId }
      : { eventId: resolved.eventId! },
    include: programInclude,
  });
  return res.json({ success: true, data: program });
}

export async function saveProgram(req: Request, res: Response) {
  const resolved = await target(req);
  if (resolved.error)
    return res
      .status(resolved.error)
      .json({ success: false, message: resolved.message });
  const parsed = programSchema.safeParse(req.body);
  if (!parsed.success)
    return res
      .status(400)
      .json({ success: false, message: parsed.error.errors[0].message });
  const userIds = [
    ...new Set(
      parsed.data.items
        .map((item) => item.userId)
        .filter((id): id is string => !!id),
    ),
  ];
  if (userIds.length) {
    const count = await prisma.user.count({
      where: {
        id: { in: userIds },
        churchId: { in: resolved.personChurchIds },
        status: 'active',
      },
    });
    if (count !== userIds.length)
      return res
        .status(400)
        .json({
          success: false,
          message: 'An assigned user is not active in this church',
        });
  }
  const where = resolved.serviceId
    ? { serviceId: resolved.serviceId }
    : { eventId: resolved.eventId! };
  const program = await prisma.$transaction(async (tx) => {
    const existing = await tx.program.findFirst({
      where,
      select: { id: true },
    });
    if (existing)
      await tx.programItem.deleteMany({ where: { programId: existing.id } });
    const data = {
      title: parsed.data.title,
      description: parsed.data.description || null,
      items: {
        create: parsed.data.items.map((item, position) => ({
          position,
          title: item.title,
          description: item.description || null,
          startsAt: new Date(item.startsAt),
          endsAt: new Date(item.endsAt),
          userId: item.userId || null,
          guestName: item.userId ? null : item.guestName || null,
          guestEmail: item.userId ? null : item.guestEmail || null,
          guestPhone: item.userId ? null : item.guestPhone || null,
        })),
      },
    };
    return existing
      ? tx.program.update({
          where: { id: existing.id },
          data,
          include: programInclude,
        })
      : tx.program.create({
          data: {
            ...data,
            serviceId: resolved.serviceId,
            eventId: resolved.eventId,
          },
          include: programInclude,
        });
  });
  return res.json({ success: true, data: program });
}

export async function deleteProgram(req: Request, res: Response) {
  const resolved = await target(req);
  if (resolved.error)
    return res
      .status(resolved.error)
      .json({ success: false, message: resolved.message });
  await prisma.program.deleteMany({
    where: resolved.serviceId
      ? { serviceId: resolved.serviceId }
      : { eventId: resolved.eventId! },
  });
  return res.json({ success: true });
}

export async function searchProgramPeople(req: Request, res: Response) {
  const resolved = await target(req);
  if (resolved.error)
    return res
      .status(resolved.error)
      .json({ success: false, message: resolved.message });
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (query.length < 3) return res.json({ success: true, data: [] });
  const result = await searchActiveMembers({
    churchIds: resolved.personChurchIds!,
    query,
    page: 1,
    limit: 20,
  });
  return res.json({ success: true, data: result.members });
}
