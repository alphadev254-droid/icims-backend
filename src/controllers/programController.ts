import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { searchActiveMembers } from '../lib/memberSearch';
import { accessibleChurchIds } from './serviceController';
import { resolveTimeZone } from '../lib/timezone';
import {
  assignmentFingerprint,
  assignmentRecipient,
  queueAssignmentNotification,
  type ProgramEmailContext,
} from '../services/programNotificationService';

const itemSchema = z
  .object({
    id: z.string().optional(),
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
  notifyPrevious: z.boolean().optional().default(false),
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
    const service = await prisma.service.findUnique({ where: { id }, include: { church: { select: { name: true } } } });
    if (!service) return { error: 404, message: 'Service not found' };
    if (!ids.includes(service.churchId))
      return { error: 403, message: 'Access denied' };
    return {
      personChurchIds: [service.churchId],
      serviceId: service.id,
      eventId: null,
      context: {
        targetType: 'services' as const, targetId: service.id, targetTitle: service.title,
        churchId: service.churchId, churchName: service.church.name,
        location: service.location, startsAt: service.startsAt,
        timeZone: await resolveTimeZone({ req, churchId: service.churchId }),
      },
    };
  }
  const event = await prisma.event.findUnique({
    where: { id },
    include: { linkedChurches: { select: { churchId: true } }, church: { select: { name: true } } },
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
    context: {
      targetType: 'events' as const, targetId: event.id, targetTitle: event.title,
      churchId: event.churchId, churchName: event.church.name,
      location: event.location, startsAt: event.date,
      timeZone: await resolveTimeZone({ req, churchId: event.churchId }),
    },
  };
}

async function decorateProgram(program: NonNullable<Awaited<ReturnType<typeof prisma.program.findFirst<{ include: typeof programInclude }>>>>, context: ProgramEmailContext) {
  const notifications = await prisma.programNotification.findMany({
    where: { programId: program.id },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: {
      id: true, itemId: true, kind: true, recipient: true, name: true,
      itemTitle: true, status: true, error: true, sentAt: true, createdAt: true, fingerprint: true,
    },
  });
  const latestNotifications = await prisma.programNotification.findMany({
    where: { programId: program.id },
    orderBy: { createdAt: 'desc' },
    distinct: ['itemId', 'recipient'],
    select: { itemId: true, recipient: true, kind: true, status: true, sentAt: true, fingerprint: true },
  });
  return {
    ...program,
    notifications,
    items: program.items.map((item) => {
      const recipient = assignmentRecipient(item);
      const latest = recipient && latestNotifications.find((log) => log.itemId === item.id && log.recipient === recipient.email);
      const status = !recipient ? 'no_email'
        : !latest || latest.kind === 'removal' ? 'not_sent'
        : latest.fingerprint !== assignmentFingerprint(item, context) && latest.status === 'sent' ? 'changed'
        : latest.status;
      return { ...item, emailStatus: status, lastEmailAt: latest?.sentAt ?? null };
    }),
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
  return res.json({ success: true, data: program ? await decorateProgram(program, resolved.context!) : null });
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
  const incomingIds = parsed.data.items.map((item) => item.id).filter((id): id is string => !!id);
  if (new Set(incomingIds).size !== incomingIds.length)
    return res.status(400).json({ success: false, message: 'Duplicate program item' });
  const { program, previousItems } = await prisma.$transaction(async (tx) => {
    const existing = await tx.program.findFirst({
      where,
      include: programInclude,
    });
    const existingIds = new Set(existing?.items.map((item) => item.id) || []);
    if (incomingIds.some((id) => !existingIds.has(id)))
      throw new Error('INVALID_PROGRAM_ITEM');
    const previousItems = (existing?.items || []).filter((item) => {
      const next = parsed.data.items.find((candidate) => candidate.id === item.id);
      return !next || (next.userId || null) !== item.userId || (next.guestEmail?.trim().toLowerCase() || null) !== (item.guestEmail?.trim().toLowerCase() || null);
    });
    const saved = existing
      ? await tx.program.update({ where: { id: existing.id }, data: { title: parsed.data.title, description: parsed.data.description || null } })
      : await tx.program.create({ data: { title: parsed.data.title, description: parsed.data.description || null, serviceId: resolved.serviceId, eventId: resolved.eventId } });
    if (existing) {
      await tx.programItem.deleteMany({
        where: { programId: saved.id, id: { notIn: incomingIds } },
      });
    }
    for (const [position, item] of parsed.data.items.entries()) {
      const data = {
          position,
          title: item.title,
          description: item.description || null,
          startsAt: new Date(item.startsAt),
          endsAt: new Date(item.endsAt),
          userId: item.userId || null,
          guestName: item.userId ? null : item.guestName || null,
          guestEmail: item.userId ? null : item.guestEmail || null,
          guestPhone: item.userId ? null : item.guestPhone || null,
      };
      if (item.id) await tx.programItem.update({ where: { id: item.id }, data });
      else await tx.programItem.create({ data: { ...data, programId: saved.id } });
    }
    return {
      program: await tx.program.findUniqueOrThrow({ where: { id: saved.id }, include: programInclude }),
      previousItems,
    };
  }).catch((error) => {
    if (error instanceof Error && error.message === 'INVALID_PROGRAM_ITEM') return null;
    throw error;
  }) || { program: null, previousItems: [] };
  if (!program) return res.status(400).json({ success: false, message: 'An item does not belong to this program' });
  let notificationWarnings = 0;
  if (parsed.data.notifyPrevious) {
    for (const item of previousItems) {
      if (item.endsAt <= new Date()) continue;
      const recipient = assignmentRecipient(item);
      if (!recipient) continue;
      const latest = await prisma.programNotification.findFirst({
        where: { itemId: item.id, recipient: recipient.email },
        orderBy: { createdAt: 'desc' },
      });
      if (!latest || latest.kind !== 'assignment' || !['sent', 'queued'].includes(latest.status)) continue;
      try {
        await queueAssignmentNotification({ programId: program.id, item, context: resolved.context!, kind: 'removal' });
      } catch {
        notificationWarnings += 1;
      }
    }
  }
  return res.json({ success: true, data: await decorateProgram(program, resolved.context!), notificationWarnings });
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

export async function sendProgramAssignment(req: Request, res: Response) {
  const resolved = await target(req);
  if (resolved.error)
    return res.status(resolved.error).json({ success: false, message: resolved.message });
  const program = await prisma.program.findFirst({
    where: resolved.serviceId ? { serviceId: resolved.serviceId } : { eventId: resolved.eventId! },
    include: programInclude,
  });
  if (!program) return res.status(404).json({ success: false, message: 'Program not found' });
  const item = program.items.find((entry) => entry.id === String(req.params.itemId));
  if (!item) return res.status(404).json({ success: false, message: 'Program item not found' });
  if (item.endsAt <= new Date())
    return res.status(400).json({ success: false, message: 'This assignment has already ended' });
  const recipient = assignmentRecipient(item);
  if (!recipient)
    return res.status(400).json({ success: false, message: 'The assigned person has no email address' });
  const latest = await prisma.programNotification.findFirst({
    where: { itemId: item.id, recipient: recipient.email },
    orderBy: { createdAt: 'desc' },
  });
  if (latest?.kind === 'assignment' && latest.status === 'queued' && latest.fingerprint === assignmentFingerprint(item, resolved.context!))
    return res.status(409).json({ success: false, message: 'An assignment email is already queued' });
  const notification = await queueAssignmentNotification({
    programId: program.id, item, context: resolved.context!, kind: 'assignment',
  });
  return res.status(202).json({ success: true, data: notification });
}
