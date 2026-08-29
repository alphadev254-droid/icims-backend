import { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import path from 'path';
import fs from 'fs';
import prisma from '../lib/prisma';
import { getAccessibleChurchIds } from '../lib/churchScope';
import { generateTicketPDF } from '../lib/ticketPDF';
import { groupByDateRanges } from '../lib/dateGrouping';
import { queueChurchPush } from '../lib/notificationQueue';
import { queueChurchMemberEmails } from '../lib/churchMemberEmail';
import { eventCreatedTemplate } from '../lib/emailTemplates';
import { hasFeature } from '../lib/packageChecker';

const TICKET_NUMBER_RETRY_LIMIT = 5;

function buildTicketNumber(event: { title: string; date: Date | string }, sequence: number): string {
  const eventDate = new Date(event.date).toISOString().slice(0, 10).replace(/-/g, '');
  const eventPrefix = event.title.replace(/\s+/g, '').substring(0, 6).toUpperCase();
  return `${eventPrefix}-${eventDate}-${String(sequence).padStart(6, '0')}`;
}

function isUniqueTicketNumberError(error: unknown): boolean {
  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: string }).code === 'P2002'
    && (
      (Array.isArray(target) && target.includes('ticketNumber'))
      || (typeof target === 'string' && target.includes('ticketNumber'))
    );
}

async function createEventTicketWithUniqueNumber(
  event: { id: string; title: string; date: Date | string },
  data: Omit<Prisma.EventTicketUncheckedCreateInput, 'id' | 'ticketNumber' | 'eventId' | 'createdAt' | 'updatedAt'>,
  include?: Parameters<typeof prisma.eventTicket.create>[0]['include'],
) {
  const latestTicket = await prisma.eventTicket.findFirst({
    where: { eventId: event.id },
    orderBy: { createdAt: 'desc' },
    select: { ticketNumber: true },
  });

  const latestSequence = Number(latestTicket?.ticketNumber.match(/-(\d+)$/)?.[1] ?? 0);
  const countSequence = await prisma.eventTicket.count({ where: { eventId: event.id } });
  let nextSequence = Math.max(latestSequence, countSequence) + 1;

  for (let attempt = 0; attempt < TICKET_NUMBER_RETRY_LIMIT; attempt += 1) {
    try {
      return await prisma.eventTicket.create({
        data: {
          ...data,
          eventId: event.id,
          ticketNumber: buildTicketNumber(event, nextSequence + attempt),
        },
        ...(include ? { include } : {}),
      });
    } catch (error) {
      if (!isUniqueTicketNumberError(error) || attempt === TICKET_NUMBER_RETRY_LIMIT - 1) {
        throw error;
      }
    }
  }

  throw new Error('Unable to generate a unique ticket number');
}

const baseEventSchema = z.object({
  title: z.string().min(1, 'Title required'),
  description: z.string().optional().default(''),
  date: z.string().min(1, 'Date required'),
  endDate: z.string().min(1, 'End date required'),
  time: z.string().min(1, 'Time required'),
  location: z.string().min(1, 'Location required'),
  contactEmail: z.string().email().optional().or(z.literal('')),
  contactPhone: z.string().optional(),
  type: z.enum(['service', 'meeting', 'conference', 'outreach', 'fellowship']),
  status: z.enum(['upcoming', 'ongoing', 'completed', 'cancelled']).optional().default('upcoming'),
  attendeeCount: z.number().optional().default(0),
  churchId: z.string().min(1, 'Church ID required'),
  requiresTicket: z.boolean().optional().default(false),
  isFree: z.boolean().optional().default(true),
  ticketPrice: z.number().nullable().optional(),
  currency: z.enum(['MWK', 'KES']).optional(),
  totalTickets: z.number().optional(),
  ticketSalesCutoff: z.string().optional(),
  allowPublicTicketing: z.boolean().optional().default(false),
  imageUrl: z.string().nullable().optional(),
  scopeType: z.enum(['one_church', 'selected_churches', 'all_churches']).optional().default('one_church'),
  churchIds: z.array(z.string().min(1)).optional(),
});

const eventSchema = baseEventSchema.refine(data => new Date(data.endDate) >= new Date(data.date), {
  message: 'End date must be on or after start date',
  path: ['endDate'],
});

const bookTicketSchema = z.object({
  eventId: z.string().min(1),
  memberId: z.string().optional(),
  paymentMethod: z.enum(['cash', 'mobile_money', 'card', 'bank_transfer']).optional().default('cash'),
  reference: z.string().optional(),
  amount: z.number().optional(),
  currency: z.enum(['MWK', 'KES']).optional(),
  transactionStatus: z.enum(['pending', 'completed', 'failed']).optional().default('completed'),
  ticketStatus: z.enum(['confirmed', 'pending', 'cancelled', 'used']).optional().default('confirmed'),
  notes: z.string().optional(),
  useExistingTransaction: z.boolean().optional(),
  existingTransactionId: z.string().optional(),
});

const manualTicketSchema = bookTicketSchema.extend({
  attendeeType: z.enum(['member', 'guest']).optional().default('member'),
  churchId: z.string().optional(),
  guestName: z.string().optional(),
  guestEmail: z.string().email('Valid guest email required').optional(),
  guestPhone: z.string().optional(),
});

type EventWithChurchLinks = {
  id: string;
  churchId: string;
  scopeType?: string | null;
  linkedChurches?: Array<{ churchId: string; church?: { id?: string; name: string } | null }>;
  church?: { id?: string; name: string } | null;
};

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function intersection(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter(value => rightSet.has(value));
}

function getEventChurchIds(event: EventWithChurchLinks): string[] {
  const linkedIds = event.linkedChurches?.map(link => link.churchId) ?? [];
  return uniqueStrings(linkedIds.length > 0 ? linkedIds : [event.churchId]);
}

function decorateEventAvailability<T extends EventWithChurchLinks>(event: T, scopedChurchIds?: string[]) {
  const linkedChurches = event.linkedChurches ?? [];
  const allAvailableChurchIds = getEventChurchIds(event);
  const availableChurchIds = scopedChurchIds?.length
    ? intersection(allAvailableChurchIds, scopedChurchIds)
    : allAvailableChurchIds;
  const availableChurches = (linkedChurches.length > 0
    ? linkedChurches.map(link => ({ id: link.churchId, name: link.church?.name ?? 'Church' }))
    : [{ id: event.churchId, name: event.church?.name ?? 'Church' }])
    .filter(church => availableChurchIds.includes(church.id));

  return { ...event, availableChurchIds, availableChurches };
}

function eventAccessWhere(churchIds: string[]): Prisma.EventWhereInput {
  return {
    OR: [
      { churchId: { in: churchIds } },
      { linkedChurches: { some: { churchId: { in: churchIds } } } },
    ],
  };
}

function resolveRequestedEventChurchIds(params: {
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

  if (churchIds.length === 0) return { error: 'Select at least one church for this event' };

  const inaccessible = churchIds.filter(id => !params.accessibleChurchIds.includes(id));
  if (inaccessible.length > 0) return { error: 'Access denied to one or more selected churches' };

  return { churchIds };
}

async function eventOwnerHasFeature(eventId: string, featureName: string): Promise<boolean> {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: {
      church: { select: { ministryAdminId: true } },
    },
  });
  const ministryAdminId = event?.church?.ministryAdminId;
  return ministryAdminId ? hasFeature(ministryAdminId, featureName) : false;
}

function featureUnavailableMessage(featureName: string) {
  return `This event feature is not available in the current package. Please enable ${featureName.replace(/_/g, ' ')}.`;
}

export async function getEventSelect(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const churchId = req.user?.churchId;
  const roleName = req.user?.role ?? 'member';
  const filterChurchId = req.query.churchId as string | undefined;
  const requestedStatus = (req.query.status as string | undefined)?.trim();
  const filterStatus = requestedStatus && ['upcoming', 'ongoing', 'completed', 'cancelled', 'all'].includes(requestedStatus)
    ? requestedStatus
    : 'current';

  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const churchIds = await getAccessibleChurchIds(
    roleName,
    churchId,
    req.user?.districts,
    req.user?.traditionalAuthorities,
    req.user?.regions,
    userId,
  );

  let scopedChurchIds = churchIds;
  if (filterChurchId) {
    if (!churchIds.includes(filterChurchId)) {
      res.json({ success: true, data: [] });
      return;
    }
    scopedChurchIds = [filterChurchId];
  }

  if (scopedChurchIds.length === 0) {
    res.json({ success: true, data: [] });
    return;
  }

  const where: Prisma.EventWhereInput = { AND: [eventAccessWhere(scopedChurchIds)] };
  if (filterStatus === 'current') {
    (where.AND as Prisma.EventWhereInput[]).push({ status: { not: 'cancelled' } });
  } else if (filterStatus !== 'all') {
    (where.AND as Prisma.EventWhereInput[]).push({ status: filterStatus });
  }

  const events = await prisma.event.findMany({
    where,
    select: {
      id: true,
      title: true,
      date: true,
      time: true,
      churchId: true,
      scopeType: true,
      requiresTicket: true,
      linkedChurches: { select: { churchId: true, church: { select: { id: true, name: true } } } },
      church: { select: { id: true, name: true } },
    },
    orderBy: { date: 'desc' },
    take: 500,
  });

  res.json({ success: true, data: events.map(event => decorateEventAvailability(event, scopedChurchIds)) });
}

export async function getEvents(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const churchId = req.user?.churchId;
  const roleName = req.user?.role ?? 'member';
  const filterChurchId = req.query.churchId as string | undefined;
  const startDate = req.query.startDate as string | undefined;
  const endDate = req.query.endDate as string | undefined;
  const requestedStatus = (req.query.status as string | undefined)?.trim();
  const filterStatus = requestedStatus && ['upcoming', 'ongoing', 'completed', 'cancelled', 'all'].includes(requestedStatus)
    ? requestedStatus
    : 'current';
  const isSimple = req.query.simple === 'true'; // lightweight dropdown mode

  // Pagination
  const page  = Math.max(1, parseInt(req.query.page  as string) || 1);
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const skip  = (page - 1) * limit;
  
  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  // Resolve accessible church IDs using the shared helper for all roles
  const churchIds = await getAccessibleChurchIds(
    roleName,
    churchId,
    req.user?.districts,
    req.user?.traditionalAuthorities,
    req.user?.regions,
    userId,
  );

  if (churchIds.length === 0) {
    res.json({ success: true, data: isSimple ? [] : {} });
    return;
  }

  // Apply church filter if provided
  let scopedChurchIds = churchIds;
  if (filterChurchId) {
    if (!churchIds.includes(filterChurchId)) {
      res.json({ success: true, data: isSimple ? [] : {} });
      return;
    }
    scopedChurchIds = [filterChurchId];
  }

  const whereClause: Prisma.EventWhereInput = { AND: [eventAccessWhere(scopedChurchIds)] };
  if (filterStatus === 'current') {
    (whereClause.AND as Prisma.EventWhereInput[]).push({ status: { not: 'cancelled' } });
  } else if (filterStatus !== 'all') {
    (whereClause.AND as Prisma.EventWhereInput[]).push({ status: filterStatus });
  }

  // Apply date filters
  if (startDate) {
    (whereClause.AND as Prisma.EventWhereInput[]).push({ date: { gte: new Date(startDate) } });
  }

  if (isSimple) {
    // Lightweight mode for dropdowns — only id, title, date, time, churchId
    // No pagination, no grouping, no ticket lookup
    const events = await prisma.event.findMany({
      where: whereClause,
      select: {
        id: true,
        title: true,
        date: true,
        time: true,
        churchId: true,
        scopeType: true,
        requiresTicket: true,
        linkedChurches: { select: { churchId: true, church: { select: { id: true, name: true } } } },
        church: { select: { id: true, name: true } },
      },
      orderBy: { date: 'desc' },
      take: 500,
    });
    res.json({ success: true, data: events.map(event => decorateEventAvailability(event, scopedChurchIds)) });
    return;
  }
  if (endDate) {
    const endDateTime = new Date(endDate);
    endDateTime.setHours(23, 59, 59, 999);
    (whereClause.AND as Prisma.EventWhereInput[]).push({ date: { lte: endDateTime } });
  }

  const [events, total] = await Promise.all([
    prisma.event.findMany({
      where: whereClause,
      // Exclude heavy Text fields (description) from list view — fetch on demand via getEvent
      select: {
        id: true,
        title: true,
        date: true,
        endDate: true,
        time: true,
        location: true,
        type: true,
        status: true,
        attendeeCount: true,
        requiresTicket: true,
        isFree: true,
        ticketPrice: true,
        currency: true,
        totalTickets: true,
        ticketsSold: true,
        ticketSalesCutoff: true,
        allowPublicTicketing: true,
        imageUrl: true,
        churchId: true,
        scopeType: true,
        createdById: true,
        createdAt: true,
        updatedAt: true,
        contactEmail: true,
        contactPhone: true,
        linkedChurches: { select: { churchId: true, church: { select: { id: true, name: true } } } },
        church: { select: { id: true, name: true } },
      },
      orderBy: { date: 'asc' },
      skip,
      take: limit,
    }),
    prisma.event.count({ where: whereClause }),
  ]);

  // Fetch all user tickets in one query
  const eventIds = events.map(e => e.id);
  const userTickets = await prisma.eventTicket.findMany({
    where: { eventId: { in: eventIds }, userId },
    select: { eventId: true, id: true, ticketNumber: true },
  });

  // Create a Map for O(1) lookup
  const ticketMap = new Map(userTickets.map(t => [t.eventId, { id: t.id, ticketNumber: t.ticketNumber }]));

  // Map events with ticket status
  const eventsWithTicketStatus = events.map(event => {
    const ticket = ticketMap.get(event.id);
    return {
      ...decorateEventAvailability(event, scopedChurchIds),
      userHasTicket: !!ticket,
      userTicketId: ticket?.id,
      userTicketNumber: ticket?.ticketNumber,
    };
  });

  // Group by date ranges
  const grouped = groupByDateRanges(eventsWithTicketStatus);

  res.json({ success: true, data: grouped, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
}

export async function getPublicEvent(req: Request, res: Response): Promise<void> {
  const eventId = String(req.params.id);
  const event = await prisma.event.findUnique({ 
    where: { id: eventId },
    include: {
      church: { select: { id: true, name: true, ministryAdminId: true } },
      linkedChurches: { select: { churchId: true, church: { select: { id: true, name: true } } } },
    }
  });
  
  if (!event) { 
    res.status(404).json({ success: false, message: 'Event not found' }); 
    return; 
  }

  if (!(await eventOwnerHasFeature(event.id, 'event_public_links'))) {
    res.status(403).json({ success: false, message: featureUnavailableMessage('event_public_links') });
    return;
  }
  
  res.json({ success: true, data: decorateEventAvailability(event) });
}

export async function getEvent(req: Request, res: Response): Promise<void> {
  const event = await prisma.event.findUnique({
    where: { id: String(req.params.id) },
    include: {
      church: { select: { id: true, name: true } },
      linkedChurches: { select: { churchId: true, church: { select: { id: true, name: true } } } },
    },
  });
  if (!event) { res.status(404).json({ success: false, message: 'Event not found' }); return; }
  res.json({ success: true, data: decorateEventAvailability(event) });
}

export async function createEvent(req: Request, res: Response): Promise<void> {
  const userId = req.user!.userId;
  
  // Check if user has events_management feature
  const { hasFeature, checkEventLimit } = await import('../lib/packageChecker');
  if (!(await hasFeature(userId, 'events_management'))) {
    res.status(403).json({ success: false, message: 'Your package does not include Events Management. Please upgrade to access this feature.' });
    return;
  }

  // Check max_events_per_month limit from Package table
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { ministryAdminId: true, role: { select: { name: true } } } });
  const ministryAdminId = user?.role?.name === 'ministry_admin' ? userId : user?.ministryAdminId;
  if (ministryAdminId) {
    const limitCheck = await checkEventLimit(ministryAdminId);
    if (!limitCheck.allowed) {
      res.status(403).json({ success: false, message: limitCheck.message || 'Event limit reached for this month' });
      return;
    }
  }
  
  const parsed = eventSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const { churchId: targetChurchId, scopeType, churchIds: requestedChurchIds, ...eventData } = parsed.data;

  if (eventData.requiresTicket && !(await hasFeature(userId, 'event_ticketing'))) {
    res.status(403).json({ success: false, message: featureUnavailableMessage('event_ticketing') });
    return;
  }
  if (eventData.allowPublicTicketing) {
    if (!(await hasFeature(userId, 'event_public_links'))) {
      res.status(403).json({ success: false, message: featureUnavailableMessage('event_public_links') });
      return;
    }
    if (!(await hasFeature(userId, 'event_guest_booking'))) {
      res.status(403).json({ success: false, message: featureUnavailableMessage('event_guest_booking') });
      return;
    }
  }
  if (eventData.requiresTicket && !eventData.isFree && !(await hasFeature(userId, 'event_online_payments'))) {
    res.status(403).json({ success: false, message: featureUnavailableMessage('event_online_payments') });
    return;
  }

  const accessibleChurchIds = await getAccessibleChurchIds(
    req.user?.role ?? 'member',
    req.user?.churchId,
    req.user?.districts,
    req.user?.traditionalAuthorities,
    req.user?.regions,
    userId,
  );
  const resolvedScope = resolveRequestedEventChurchIds({
    scopeType,
    primaryChurchId: targetChurchId,
    requestedChurchIds,
    accessibleChurchIds,
  });
  if (resolvedScope.error || !resolvedScope.churchIds) {
    res.status(403).json({ success: false, message: resolvedScope.error || 'Invalid event church availability' });
    return;
  }
  const eventChurchIds = resolvedScope.churchIds;
  const primaryChurchId = eventChurchIds[0];

  // Check if event requires payment and if Kenya account has subaccount
  if (!eventData.isFree && eventData.requiresTicket) {
    const { getPaymentGateway } = await import('../utils/gatewayRouter');
    const gateway = await getPaymentGateway(userId);
    
    if (gateway === 'paystack') {
      const subaccountCount = await prisma.subaccount.count({
        where: { churchId: { in: eventChurchIds } }
      });
      
      if (subaccountCount !== eventChurchIds.length) {
        res.status(400).json({ 
          success: false, 
          message: 'To create paid ticket events, every selected church needs a Paystack subaccount first. Please go to Branches > Finance account management.' 
        });
        return;
      }
    }
  }

  const event = await prisma.event.create({
    data: {
      ...eventData,
      churchId: primaryChurchId,
      scopeType,
      date: new Date(eventData.date),
      endDate: new Date(eventData.endDate),
      ticketSalesCutoff: eventData.ticketSalesCutoff && eventData.ticketSalesCutoff !== '' 
        ? new Date(eventData.ticketSalesCutoff) 
        : null,
      createdById: req.user!.userId,
      linkedChurches: {
        create: eventChurchIds.map(churchId => ({ churchId })),
      },
    },
    include: {
      church: { select: { id: true, name: true } },
      linkedChurches: { select: { churchId: true, church: { select: { id: true, name: true } } } },
    },
  });

  res.status(201).json({ success: true, data: decorateEventAvailability(event) });

  // Fire-and-forget: worker resolves members and sends push off the request cycle
  const church = await prisma.church.findUnique({ where: { id: primaryChurchId }, select: { name: true } });
  queueChurchPush(
    primaryChurchId,
    `${church?.name || 'Your Church'} · New Event`,
    `${event.title} on ${new Date(event.date).toLocaleDateString()}`,
    { type: 'event_created', eventId: event.id, churchId: primaryChurchId }
  ).catch(err => console.error('[Event] Failed to queue push:', err));

  queueChurchMemberEmails({
    churchId: primaryChurchId,
    subject: `${church?.name || 'Your Church'} - New Event: ${event.title}`,
    buildHtml: member => eventCreatedTemplate({
      firstName: member.firstName,
      eventTitle: event.title,
      eventDate: new Date(event.date).toLocaleDateString(),
      eventEndDate: new Date(event.endDate).toLocaleDateString(),
      eventTime: event.time,
      eventLocation: event.location,
      description: event.description || undefined,
      churchName: church?.name || 'Your Church',
    }),
    emailType: 'notification',
  }).catch(err => console.error('[Event] Failed to queue member emails:', err));
}

export async function updateEvent(req: Request, res: Response): Promise<void> {
  const parsed = baseEventSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const eventId = String(req.params.id);
  const oldEvent = await prisma.event.findUnique({ where: { id: eventId } });
  if (!oldEvent) { res.status(404).json({ success: false, message: 'Event not found' }); return; }
  const { churchIds: requestedChurchIds, scopeType, churchId: targetChurchId, ...eventData } = parsed.data;
  const userId = req.user!.userId;
  const nextRequiresTicket = eventData.requiresTicket ?? oldEvent.requiresTicket;
  const nextIsFree = eventData.isFree ?? oldEvent.isFree;
  const nextAllowPublicTicketing = eventData.allowPublicTicketing ?? oldEvent.allowPublicTicketing;

  if (nextRequiresTicket && !(await hasFeature(userId, 'event_ticketing'))) {
    res.status(403).json({ success: false, message: featureUnavailableMessage('event_ticketing') });
    return;
  }
  if (nextAllowPublicTicketing) {
    if (!(await hasFeature(userId, 'event_public_links'))) {
      res.status(403).json({ success: false, message: featureUnavailableMessage('event_public_links') });
      return;
    }
    if (!(await hasFeature(userId, 'event_guest_booking'))) {
      res.status(403).json({ success: false, message: featureUnavailableMessage('event_guest_booking') });
      return;
    }
  }
  if (nextRequiresTicket && !nextIsFree && !(await hasFeature(userId, 'event_online_payments'))) {
    res.status(403).json({ success: false, message: featureUnavailableMessage('event_online_payments') });
    return;
  }

  const hasBodyKey = (key: string) => Object.prototype.hasOwnProperty.call(req.body, key);
  const shouldUpdateScope = hasBodyKey('scopeType') || hasBodyKey('churchId') || hasBodyKey('churchIds');
  let nextEventChurchIds: string[] | undefined;
  let nextPrimaryChurchId: string | undefined;

  if (shouldUpdateScope) {
    const accessibleChurchIds = await getAccessibleChurchIds(
      req.user?.role ?? 'member',
      req.user?.churchId,
      req.user?.districts,
      req.user?.traditionalAuthorities,
      req.user?.regions,
      req.user!.userId,
    );
    const resolvedScope = resolveRequestedEventChurchIds({
      scopeType: scopeType ?? oldEvent.scopeType,
      primaryChurchId: targetChurchId ?? oldEvent.churchId,
      requestedChurchIds,
      accessibleChurchIds,
    });
    if (resolvedScope.error || !resolvedScope.churchIds) {
      res.status(403).json({ success: false, message: resolvedScope.error || 'Invalid event church availability' });
      return;
    }
    nextEventChurchIds = resolvedScope.churchIds;
    nextPrimaryChurchId = nextEventChurchIds[0];
  }
  
  // Delete old image if exists and new imageUrl is different
  if (oldEvent.imageUrl && eventData.imageUrl !== undefined && eventData.imageUrl !== oldEvent.imageUrl) {
    const oldPath = path.join(process.cwd(), oldEvent.imageUrl);
    if (fs.existsSync(oldPath)) {
      fs.unlinkSync(oldPath);
    }
  }

  const event = await prisma.event.update({
    where: { id: eventId },
    data: {
      ...eventData,
      ...(nextPrimaryChurchId ? { churchId: nextPrimaryChurchId } : {}),
      ...(hasBodyKey('scopeType') ? { scopeType } : {}),
      date: eventData.date ? new Date(eventData.date) : undefined,
      endDate: eventData.endDate ? new Date(eventData.endDate) : undefined,
      ticketSalesCutoff: eventData.ticketSalesCutoff !== undefined
        ? (eventData.ticketSalesCutoff === '' ? null : new Date(eventData.ticketSalesCutoff))
        : undefined,
      totalTickets: eventData.totalTickets !== undefined
        ? (eventData.totalTickets === 0 ? null : eventData.totalTickets)
        : undefined,
      ticketPrice: eventData.ticketPrice !== undefined
        ? (eventData.ticketPrice === null ? null : eventData.ticketPrice)
        : undefined,
      ...(nextEventChurchIds ? {
        linkedChurches: {
          deleteMany: {},
          create: nextEventChurchIds.map(churchId => ({ churchId })),
        },
      } : {}),
    },
    include: {
      church: { select: { id: true, name: true } },
      linkedChurches: { select: { churchId: true, church: { select: { id: true, name: true } } } },
    },
  });
  res.json({ success: true, data: decorateEventAvailability(event) });
}

export async function deleteEvent(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const roleName = req.user?.role ?? 'member';
  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const event = await prisma.event.findUnique({
    where: { id: String(req.params.id) },
    include: { linkedChurches: { select: { churchId: true } } },
  });
  if (!event) {
    res.status(404).json({ success: false, message: 'Event not found' });
    return;
  }

  const churchIds = await getAccessibleChurchIds(
    roleName,
    req.user?.churchId,
    req.user?.districts,
    req.user?.traditionalAuthorities,
    req.user?.regions,
    userId,
  );
  const eventChurchIds = getEventChurchIds(event);
  if (!eventChurchIds.some(churchId => churchIds.includes(churchId))) {
    res.status(403).json({ success: false, message: 'Access denied' });
    return;
  }

  await prisma.event.update({
    where: { id: event.id },
    data: { status: 'cancelled' },
  });
  res.json({ success: true, message: 'Event cancelled' });
}

export async function bookTicket(req: Request, res: Response): Promise<void> {
  const parsed = bookTicketSchema.safeParse(req.body);
  if (!parsed.success) { 
    console.log('Validation error:', parsed.error.errors);
    res.status(400).json({ success: false, message: parsed.error.errors[0].message, errors: parsed.error.errors }); 
    return; 
  }

  const { eventId, memberId, paymentMethod, reference } = parsed.data;
  const userId = req.user!.userId;
  const roleName = req.user?.role ?? 'member';
  const churchId = req.user!.churchId;
  
  // If memberId not provided and user is a member, use their own ID
  const targetUserId = !memberId && roleName === 'member' ? userId : memberId;
  
  if (!targetUserId) {
    res.status(400).json({ success: false, message: 'memberId required' });
    return;
  }

  const event = await (prisma.event as any).findUnique({
    where: { id: eventId },
    include: { linkedChurches: { select: { churchId: true } } },
  });
  if (!event) { res.status(404).json({ success: false, message: 'Event not found' }); return; }
  if (!(await eventOwnerHasFeature(event.id, 'event_ticketing'))) {
    res.status(403).json({ success: false, message: featureUnavailableMessage('event_ticketing') });
    return;
  }
  if (!event.requiresTicket) { res.status(400).json({ success: false, message: 'Event does not require tickets' }); return; }
  if (event.status === 'completed' || event.status === 'cancelled') {
    res.status(400).json({ success: false, message: 'Cannot book tickets for completed or cancelled events' }); return;
  }
  if (event.ticketSalesCutoff && new Date(event.ticketSalesCutoff) < new Date()) {
    res.status(400).json({ success: false, message: 'Ticket sales have ended' }); return;
  }

  const existingTicket = await prisma.eventTicket.findFirst({
    where: {
      eventId,
      userId: targetUserId,
      status: { not: 'cancelled' },
    },
    select: { id: true, ticketNumber: true, eventId: true, userId: true, transactionId: true, status: true, createdAt: true, updatedAt: true },
  });

  if (existingTicket) {
    res.status(200).json({ success: true, data: existingTicket });
    return;
  }

  if (event.totalTickets && event.ticketsSold >= event.totalTickets) {
    res.status(400).json({ success: false, message: 'Event is sold out' }); return;
  }

  const targetMember = await prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true, churchId: true, status: true } });
  if (!targetMember || targetMember.status !== 'active') {
    res.status(404).json({ success: false, message: 'Member not found or inactive' });
    return;
  }
  const allowedChurchIds = event.linkedChurches?.length ? event.linkedChurches.map((link: any) => link.churchId) : [event.churchId];
  if (!targetMember.churchId || !allowedChurchIds.includes(targetMember.churchId)) {
    res.status(403).json({ success: false, message: 'This event is not available for this member church' });
    return;
  }

  let transactionId = null;
  if (!event.isFree && event.ticketPrice) {
    if (!(await eventOwnerHasFeature(event.id, 'event_online_payments'))) {
      res.status(403).json({ success: false, message: featureUnavailableMessage('event_online_payments') });
      return;
    }
    const transaction = await prisma.transaction.create({
      data: {
        amount: event.ticketPrice,
        currency: event.currency || 'MWK',
        status: 'completed',
        paymentMethod,
        reference,
        userId,
        churchId: targetMember.churchId,
        type: 'event_ticket',
      },
    });
    transactionId = transaction.id;
  }

  const ticket = await createEventTicketWithUniqueNumber(event, {
    churchId: targetMember.churchId,
    userId: targetUserId,
    transactionId,
    status: 'confirmed',
  });

  await prisma.event.update({
    where: { id: eventId },
    data: { ticketsSold: { increment: 1 } },
  });

  res.status(201).json({ success: true, data: ticket });
}

export async function getMyTickets(req: Request, res: Response): Promise<void> {
  const userId = req.user!.userId;
  const tickets = await prisma.eventTicket.findMany({
    where: { userId },
    select: {
      id: true,
      ticketNumber: true,
      status: true,
      createdAt: true,
      transactionId: true,
      eventId: true,
      event: {
        select: {
          title: true,
          date: true,
          time: true,
          location: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ success: true, data: tickets });
}

export async function getEventTickets(req: Request, res: Response): Promise<void> {
  const eventId = String(req.params.id);
  const churchId = typeof req.query.churchId === 'string' ? req.query.churchId : undefined;
  const type = typeof req.query.type === 'string' ? req.query.type : undefined;

  const where: any = { eventId };
  if (churchId && churchId !== 'all') {
    where.churchId = churchId;
  }
  if (type === 'guest') {
    where.isGuest = true;
  } else if (type === 'member') {
    where.isGuest = false;
  }

  const tickets = await prisma.eventTicket.findMany({
    where,
    select: {
      id: true,
      ticketNumber: true,
      status: true,
      attended: true,
      attendedAt: true,
      createdAt: true,
      isGuest: true,
      guestName: true,
      guestEmail: true,
      guestPhone: true,
      church: { select: { id: true, name: true } },
      user: { select: { id: true, firstName: true, lastName: true, email: true } },
      transaction: { select: { amount: true, baseAmount: true, currency: true, paymentMethod: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ success: true, data: tickets });
}

export async function markAttendance(req: Request, res: Response): Promise<void> {
  const ticketId = String(req.params.ticketId);
  const { attended } = req.body;

  if (typeof attended !== 'boolean') {
    res.status(400).json({ success: false, message: 'attended must be a boolean' });
    return;
  }

  const ticket = await prisma.eventTicket.update({
    where: { id: ticketId },
    data: {
      attended,
      attendedAt: attended ? new Date() : null,
    },
  });

  res.json({ success: true, data: ticket });
}

export async function cancelTicket(req: Request, res: Response): Promise<void> {
  const ticketId = String(req.params.ticketId);
  const userId = req.user?.userId;
  const roleName = req.user?.role ?? 'member';
  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const ticket = await prisma.eventTicket.findUnique({
    where: { id: ticketId },
    select: {
      id: true,
      eventId: true,
      ticketNumber: true,
      status: true,
      attended: true,
      event: {
        select: {
          id: true,
          churchId: true,
          linkedChurches: { select: { churchId: true } },
        },
      },
      attendanceParticipants: { select: { id: true }, take: 1 },
    },
  });

  if (!ticket) {
    res.status(404).json({ success: false, message: 'Ticket not found' });
    return;
  }

  const accessibleChurchIds = await getAccessibleChurchIds(
    roleName,
    req.user?.churchId,
    req.user?.districts,
    req.user?.traditionalAuthorities,
    req.user?.regions,
    userId,
  );
  const eventChurchIds = getEventChurchIds(ticket.event);
  if (!eventChurchIds.some(churchId => accessibleChurchIds.includes(churchId))) {
    res.status(403).json({ success: false, message: 'Access denied' });
    return;
  }

  if (ticket.status === 'cancelled') {
    res.json({ success: true, message: 'Ticket is already cancelled', data: ticket });
    return;
  }

  if (ticket.attended || ticket.status === 'used' || ticket.attendanceParticipants.length > 0) {
    res.status(400).json({
      success: false,
      message: 'This ticket has already been checked in. Remove the attendance record before cancelling it.',
    });
    return;
  }

  const [updatedTicket] = await prisma.$transaction([
    prisma.eventTicket.update({
      where: { id: ticketId },
      data: {
        status: 'cancelled',
        attended: false,
        attendedAt: null,
      },
      include: {
        church: { select: { id: true, name: true } },
        user: { select: { id: true, firstName: true, lastName: true, email: true } },
        transaction: { select: { amount: true, baseAmount: true, currency: true, paymentMethod: true } },
      },
    }),
    prisma.event.updateMany({
      where: { id: ticket.eventId, ticketsSold: { gt: 0 } },
      data: { ticketsSold: { decrement: 1 } },
    }),
  ]);

  res.json({ success: true, message: 'Ticket cancelled', data: updatedTicket });
}

export async function createManualTicket(req: Request, res: Response): Promise<void> {
  const eventId = String(req.params.id);
  const parsed = manualTicketSchema.safeParse({ ...req.body, eventId });
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const { attendeeType, memberId, churchId, guestName, guestEmail, guestPhone, paymentMethod, reference, amount, currency, transactionStatus, ticketStatus, notes, useExistingTransaction, existingTransactionId } = parsed.data;
  
  if (attendeeType === 'member' && !memberId) {
    res.status(400).json({ success: false, message: 'memberId is required for manual ticket creation' });
    return;
  }
  if (attendeeType === 'guest' && (!guestName || !guestEmail)) {
    res.status(400).json({ success: false, message: 'Guest name and email are required for manual guest tickets' });
    return;
  }

  const event = await (prisma.event as any).findUnique({
    where: { id: eventId },
    include: { linkedChurches: { select: { churchId: true } } },
  });
  if (!event) { res.status(404).json({ success: false, message: 'Event not found' }); return; }
  if (!(await eventOwnerHasFeature(event.id, 'event_ticketing'))) {
    res.status(403).json({ success: false, message: featureUnavailableMessage('event_ticketing') });
    return;
  }
  if (!event.requiresTicket) { res.status(400).json({ success: false, message: 'Event does not require tickets' }); return; }
  if (event.status === 'completed' || event.status === 'cancelled') {
    res.status(400).json({ success: false, message: 'Cannot book tickets for completed or cancelled events' }); return;
  }
  if (event.ticketSalesCutoff && new Date(event.ticketSalesCutoff) < new Date()) {
    res.status(400).json({ success: false, message: 'Ticket sales have ended' }); return;
  }
  if (event.totalTickets && event.ticketsSold >= event.totalTickets) {
    res.status(400).json({ success: false, message: 'Event is sold out' }); return;
  }

  const allowedChurchIds = event.linkedChurches?.length ? event.linkedChurches.map((link: any) => link.churchId) : [event.churchId];
  let resolvedChurchId: string | null = null;
  let member: Awaited<ReturnType<typeof prisma.user.findUnique>> & { role?: { name: string } | null } | null = null;

  if (attendeeType === 'member') {
    member = await prisma.user.findUnique({
      where: { id: memberId },
      include: { role: true }
    }) as any;
    if (!member) { res.status(404).json({ success: false, message: 'Member not found' }); return; }
    if (member.role?.name !== 'member') { res.status(400).json({ success: false, message: 'Selected user is not a member' }); return; }
    resolvedChurchId = (member as any).churchId;
    if (!resolvedChurchId || !allowedChurchIds.includes(resolvedChurchId)) {
      res.status(403).json({ success: false, message: 'This event is not available for this member church' });
      return;
    }
  } else {
    resolvedChurchId = churchId || (allowedChurchIds.length === 1 ? allowedChurchIds[0] : null);
    if (!resolvedChurchId) {
      res.status(400).json({ success: false, message: 'Church is required for guest tickets on multi-church events' });
      return;
    }
    if (!allowedChurchIds.includes(resolvedChurchId)) {
      res.status(403).json({ success: false, message: 'This event is not available for the selected church' });
      return;
    }
  }

  let transactionId = null;

  if (useExistingTransaction && existingTransactionId) {
    const existingTransaction = await prisma.transaction.findUnique({ where: { id: existingTransactionId } });
    if (!existingTransaction) { res.status(404).json({ success: false, message: 'Transaction not found' }); return; }
    transactionId = existingTransactionId;
  } else {
    const ticketAmount = amount !== undefined ? amount : (event.isFree ? 0 : event.ticketPrice || 0);
    const ticketCurrency = currency || event.currency || 'MWK';

    if (ticketAmount > 0) {
      if (!(await eventOwnerHasFeature(event.id, 'event_manual_payments'))) {
        res.status(403).json({ success: false, message: featureUnavailableMessage('event_manual_payments') });
        return;
      }
      const transaction = await prisma.transaction.create({
        data: {
          amount: ticketAmount,
          currency: ticketCurrency,
          status: transactionStatus || 'completed',
          paymentMethod,
          reference: reference || `MANUAL-${Date.now()}`,
          userId: attendeeType === 'member' ? memberId : null,
          churchId: resolvedChurchId,
          type: 'event_ticket',
          notes,
          isManual: true,
          isGuest: attendeeType === 'guest',
          guestName: attendeeType === 'guest' ? guestName : null,
          guestEmail: attendeeType === 'guest' ? guestEmail : null,
          guestPhone: attendeeType === 'guest' ? guestPhone || null : null,
        },
      });
      transactionId = transaction.id;
    }
  }

  const ticket = await createEventTicketWithUniqueNumber(event, {
      churchId: resolvedChurchId,
      userId: attendeeType === 'member' ? memberId : null,
      transactionId, 
      status: ticketStatus || 'confirmed',
      isManual: true,
      isGuest: attendeeType === 'guest',
      guestName: attendeeType === 'guest' ? guestName : null,
      guestEmail: attendeeType === 'guest' ? guestEmail : null,
      guestPhone: attendeeType === 'guest' ? guestPhone || null : null,
    }, { user: { select: { firstName: true, lastName: true, email: true } }, church: { select: { id: true, name: true } }, transaction: true });

  await prisma.event.update({
    where: { id: eventId },
    data: { ticketsSold: { increment: 1 } },
  });

  res.status(201).json({ success: true, data: ticket });
}

export async function getTicketTransaction(req: Request, res: Response): Promise<void> {
  const ticketId = String(req.params.ticketId);
  const userId = req.user!.userId;
  const roleName = req.user?.role ?? 'member';
  
  const whereClause = roleName === 'member' 
    ? { id: ticketId, userId } 
    : { id: ticketId };
  
  if (roleName === 'member') {
    const ticket = await prisma.eventTicket.findUnique({
      where: whereClause,
      select: {
        transaction: {
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
        },
      },
    });
    
    if (!ticket) { 
      res.status(404).json({ success: false, message: 'Forbidden' }); 
      return; 
    }
    
    res.json({ success: true, data: ticket.transaction });
  } else {
    const ticket = await prisma.eventTicket.findUnique({
      where: whereClause,
      select: {
        transaction: {
          select: {
            amount: true,
            currency: true,
            paymentMethod: true,
            status: true,
            reference: true,
            paidAt: true,
            channel: true,
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
        },
      },
    });
    
    if (!ticket) { 
      res.status(404).json({ success: false, message: 'Ticket not found' }); 
      return; 
    }
    
    res.json({ success: true, data: ticket.transaction });
  }
}

export async function getUnallocatedTransactions(req: Request, res: Response): Promise<void> {
  const eventId = String(req.params.id);
  
  const event = await (prisma.event as any).findUnique({
    where: { id: eventId },
    include: { linkedChurches: { select: { churchId: true } } },
  });
  if (!event) { res.status(404).json({ success: false, message: 'Event not found' }); return; }
  const eventChurchIds = event.linkedChurches?.length ? event.linkedChurches.map((link: any) => link.churchId) : [event.churchId];

  const allocatedTransactionIds = await prisma.eventTicket.findMany({
    where: { eventId, transactionId: { not: null } },
    select: { transactionId: true },
  });

  const transactions = await prisma.transaction.findMany({
    where: {
      type: 'event_ticket',
      churchId: { in: eventChurchIds },
      id: { notIn: allocatedTransactionIds.map(t => t.transactionId!).filter(Boolean) },
    },
    include: { user: { select: { firstName: true, lastName: true } } },
    orderBy: { createdAt: 'desc' },
  });

  res.json({ success: true, data: transactions });
}

export async function downloadTicket(req: Request, res: Response): Promise<void> {
  const ticketId = String(req.params.ticketId);
  const userId = req.user!.userId;
  const roleName = req.user?.role ?? 'member';

  const whereClause = roleName === 'member' ? { id: ticketId, userId } : { id: ticketId };

  const ticket = await prisma.eventTicket.findUnique({
    where: whereClause,
    include: {
      event: { include: { church: true } },
      church: { select: { id: true, name: true } },
      user: { select: { firstName: true, lastName: true } },
      transaction: { select: { amount: true, currency: true } },
    },
  });

  if (!ticket) {
    res.status(404).json({ success: false, message: 'Ticket not found' });
    return;
  }

  const attendeeName = ticket.isGuest
    ? (ticket.guestName || 'Guest')
    : `${ticket.user!.firstName} ${ticket.user!.lastName}`;

  const pdfBuffer = await generateTicketPDF({
    ticketNumber: ticket.ticketNumber,
    eventTitle: ticket.event.title,
    eventDate: new Date(ticket.event.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
    eventEndDate: new Date(ticket.event.endDate).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
    eventLocation: ticket.event.location,
    attendeeName,
    churchName: ticket.event.church.name,
    amount: ticket.transaction?.amount || 0,
    currency: ticket.transaction?.currency || ticket.event.currency || 'MWK',
  });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=ticket-${ticket.ticketNumber}.pdf`);
  res.send(pdfBuffer);
}
