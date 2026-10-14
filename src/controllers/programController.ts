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
import { generateProgramPDF } from '../lib/programPDF';

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
  sendAssignmentEmails: z.boolean().optional().default(false),
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
    const service = await prisma.service.findUnique({
      where: { id },
      include: {
        church: { select: { id: true, name: true, logoUrl: true, ministryAdminId: true } },
        linkedChurches: { select: { churchId: true, church: { select: { id: true, name: true, logoUrl: true } } } },
      },
    });
    if (!service) return { error: 404, message: 'Service not found' };
    const serviceChurchIds = [
      service.churchId,
      ...service.linkedChurches.map((link) => link.churchId),
    ];
    if (!serviceChurchIds.some((churchId) => ids.includes(churchId)))
      return { error: 403, message: 'Access denied' };
    const churches = [
      { id: service.church.id, name: service.church.name, logoUrl: service.church.logoUrl },
      ...service.linkedChurches.map((link) => ({ id: link.church.id, name: link.church.name, logoUrl: link.church.logoUrl })),
    ].filter((church, index, all) => all.findIndex((item) => item.id === church.id) === index);
    return {
      personChurchIds: serviceChurchIds.filter((churchId) => ids.includes(churchId)),
      serviceId: service.id,
      eventId: null,
      pdfTarget: {
        type: 'Service' as const,
        title: service.title,
        location: service.location,
        startsAt: service.startsAt,
        endsAt: service.endsAt,
        churches,
        ministryAdminId: service.church.ministryAdminId,
      },
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
    include: {
      linkedChurches: { select: { churchId: true, church: { select: { id: true, name: true, logoUrl: true } } } },
      church: { select: { id: true, name: true, logoUrl: true, ministryAdminId: true } },
    },
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
    pdfTarget: {
      type: 'Event' as const,
      title: event.title,
      location: event.location,
      startsAt: event.date,
      endsAt: event.endDate,
      churches: [
        { id: event.church.id, name: event.church.name, logoUrl: event.church.logoUrl },
        ...event.linkedChurches.map((link) => ({ id: link.church.id, name: link.church.name, logoUrl: link.church.logoUrl })),
      ].filter((church, index, all) => all.findIndex((item) => item.id === church.id) === index),
      ministryAdminId: event.church.ministryAdminId,
    },
    context: {
      targetType: 'events' as const, targetId: event.id, targetTitle: event.title,
      churchId: event.churchId, churchName: event.church.name,
      location: event.location, startsAt: event.date,
      timeZone: await resolveTimeZone({ req, churchId: event.churchId }),
    },
  };
}

export async function downloadProgram(req: Request, res: Response) {
  const resolved = await target(req);
  if (resolved.error)
    return res.status(resolved.error).json({ success: false, message: resolved.message });
  const program = await prisma.program.findFirst({
    where: resolved.serviceId
      ? { serviceId: resolved.serviceId }
      : { eventId: resolved.eventId! },
    include: programInclude,
  });
  if (!program) return res.status(404).json({ success: false, message: 'Program not found' });
  const pdfTarget = (resolved as any).pdfTarget;
  const profile = pdfTarget?.ministryAdminId
    ? await prisma.churchProfile.findUnique({
        where: { ministryAdminId: pdfTarget.ministryAdminId },
        select: { logoUrl: true, primaryColor: true },
      })
    : null;
  const pdf = await generateProgramPDF({
    program,
    target: pdfTarget,
    ministryLogoUrl: pdfTarget?.churches.find((church: any) => church.logoUrl)?.logoUrl || profile?.logoUrl || null,
    primaryColor: profile?.primaryColor || '#d89b12',
  });
  const filename = `${program.title || resolved.context!.targetTitle}-program`.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename || 'program'}.pdf"`);
  res.send(pdf);
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
  if (
    parsed.data.sendAssignmentEmails &&
    !req.user?.permissions?.includes('programs:send')
  ) {
    return res.status(403).json({
      success: false,
      message: 'You do not have permission to send program assignment emails',
    });
  }
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
  const { program, previousItems, wasCreated } = await prisma.$transaction(async (tx) => {
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
      wasCreated: !existing,
    };
  }).catch((error) => {
    if (error instanceof Error && error.message === 'INVALID_PROGRAM_ITEM') return null;
    throw error;
  }) || { program: null, previousItems: [], wasCreated: false };
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
  let assignmentEmailsQueued = 0;
  let assignmentEmailsSkipped = 0;
  if (wasCreated && parsed.data.sendAssignmentEmails) {
    const now = new Date();
    const eligibleItems = program.items.filter((item) => {
      const eligible = item.endsAt > now && !!assignmentRecipient(item);
      if (!eligible) assignmentEmailsSkipped += 1;
      return eligible;
    });
    const results = await Promise.allSettled(
      eligibleItems.map((item) =>
        queueAssignmentNotification({
          programId: program.id,
          item,
          context: resolved.context!,
          kind: 'assignment',
        }),
      ),
    );
    assignmentEmailsQueued = results.filter((result) => result.status === 'fulfilled').length;
    notificationWarnings += results.length - assignmentEmailsQueued;
  }
  return res.json({
    success: true,
    data: await decorateProgram(program, resolved.context!),
    notificationWarnings,
    assignmentEmailsQueued,
    assignmentEmailsSkipped,
  });
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
