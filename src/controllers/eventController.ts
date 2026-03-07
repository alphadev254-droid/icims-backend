import { Request, Response } from 'express';
import { z } from 'zod';
import path from 'path';
import fs from 'fs';
import prisma from '../lib/prisma';
import { getAccessibleChurchIds } from '../lib/churchScope';

const eventSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional().default(''),
  date: z.string(),
  time: z.string(),
  location: z.string().min(1),
  type: z.enum(['service', 'meeting', 'conference', 'outreach', 'fellowship']),
  status: z.enum(['upcoming', 'ongoing', 'completed', 'cancelled']).optional().default('upcoming'),
  attendeeCount: z.number().optional().default(0),
  churchId: z.string().min(1, 'Church ID required'),
  requiresTicket: z.boolean().optional().default(false),
  isFree: z.boolean().optional().default(true),
  ticketPrice: z.number().optional(),
  currency: z.enum(['MWK', 'KSH']).optional(),
  totalTickets: z.number().optional(),
  imageUrl: z.string().optional(),
});

const bookTicketSchema = z.object({
  eventId: z.string().min(1),
  memberId: z.string().min(1),
  paymentMethod: z.enum(['cash', 'mobile_money', 'card', 'bank_transfer']).optional().default('cash'),
  reference: z.string().optional(),
  amount: z.number().optional(),
  currency: z.enum(['MWK', 'KSH']).optional(),
  transactionStatus: z.enum(['pending', 'completed', 'failed']).optional().default('completed'),
  ticketStatus: z.enum(['confirmed', 'pending', 'cancelled', 'used']).optional().default('confirmed'),
  notes: z.string().optional(),
  useExistingTransaction: z.boolean().optional(),
  existingTransactionId: z.string().optional(),
});

export async function getEvents(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const churchId = req.user?.churchId;
  const roleName = req.user?.role ?? 'member';
  
  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  let churchIds: string[] = [];

  if (roleName === 'member') {
    // Members only see events from their own church
    if (!churchId) {
      res.status(400).json({ success: false, message: 'No church assigned' });
      return;
    }
    churchIds = [churchId];
  } else if (roleName === 'national_admin') {
    // National admin sees events from their churches
    const churches = await prisma.church.findMany({
      where: { nationalAdminId: userId },
      select: { id: true }
    });
    churchIds = churches.map(c => c.id);
  } else {
    // Other roles use existing scope logic
    if (!churchId) {
      res.status(400).json({ success: false, message: 'churchId required' });
      return;
    }
    churchIds = await getAccessibleChurchIds(roleName, churchId, req.user?.districts, req.user?.traditionalAuthorities, req.user?.regions, userId);
  }

  const events = await prisma.event.findMany({
    where: { churchId: { in: churchIds } },
    orderBy: { date: 'asc' },
  });

  // Fetch all user tickets in one query
  const eventIds = events.map(e => e.id);
  const userTickets = await prisma.eventTicket.findMany({
    where: { eventId: { in: eventIds }, userId },
    select: { eventId: true },
  });

  // Create a Set for O(1) lookup
  const ticketedEventIds = new Set(userTickets.map(t => t.eventId));

  // Map events with ticket status
  const eventsWithTicketStatus = events.map(event => ({
    ...event,
    userHasTicket: ticketedEventIds.has(event.id),
  }));

  res.json({ success: true, data: eventsWithTicketStatus });
}

export async function getEvent(req: Request, res: Response): Promise<void> {
  const event = await prisma.event.findUnique({ where: { id: String(req.params.id) } });
  if (!event) { res.status(404).json({ success: false, message: 'Event not found' }); return; }
  res.json({ success: true, data: event });
}

export async function createEvent(req: Request, res: Response): Promise<void> {
  const userId = req.user!.userId;
  
  // Check if user has events_management feature
  const { hasFeature } = await import('../lib/packageChecker');
  if (!(await hasFeature(userId, 'events_management'))) {
    res.status(403).json({ success: false, message: 'Your package does not include Events Management. Please upgrade to access this feature.' });
    return;
  }
  
  const parsed = eventSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const event = await prisma.event.create({
    data: {
      ...parsed.data,
      date: new Date(parsed.data.date),
      createdById: req.user!.userId,
    },
  });
  res.status(201).json({ success: true, data: event });
}

export async function updateEvent(req: Request, res: Response): Promise<void> {
  const parsed = eventSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const eventId = String(req.params.id);
  const oldEvent = await prisma.event.findUnique({ where: { id: eventId } });
  
  // Delete old image if exists and new imageUrl is different
  if (oldEvent?.imageUrl && parsed.data.imageUrl !== oldEvent.imageUrl) {
    const oldPath = path.join(process.cwd(), oldEvent.imageUrl);
    if (fs.existsSync(oldPath)) {
      fs.unlinkSync(oldPath);
    }
  }

  const event = await prisma.event.update({
    where: { id: eventId },
    data: {
      ...parsed.data,
      date: parsed.data.date ? new Date(parsed.data.date) : undefined,
    },
  });
  res.json({ success: true, data: event });
}

export async function deleteEvent(req: Request, res: Response): Promise<void> {
  await prisma.event.delete({ where: { id: String(req.params.id) } });
  res.json({ success: true, message: 'Event deleted' });
}

export async function bookTicket(req: Request, res: Response): Promise<void> {
  const parsed = bookTicketSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const { eventId, memberId, paymentMethod, reference } = parsed.data;
  const userId = req.user!.userId;
  const churchId = req.user!.churchId;

  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) { res.status(404).json({ success: false, message: 'Event not found' }); return; }
  if (!event.requiresTicket) { res.status(400).json({ success: false, message: 'Event does not require tickets' }); return; }
  if (event.totalTickets && event.ticketsSold >= event.totalTickets) {
    res.status(400).json({ success: false, message: 'Event is sold out' }); return;
  }

  const eventDate = new Date(event.date).toISOString().slice(0, 10).replace(/-/g, '');
  const ticketCount = await prisma.eventTicket.count({ where: { eventId } });
  const eventPrefix = event.title.replace(/\s+/g, '').substring(0, 6).toUpperCase();
  const ticketNumber = `${eventPrefix}-${eventDate}-${String(ticketCount + 1).padStart(4, '0')}`;

  let transactionId = null;
  if (!event.isFree && event.ticketPrice) {
    const transaction = await prisma.transaction.create({
      data: {
        amount: event.ticketPrice,
        currency: event.currency || 'MWK',
        status: 'completed',
        paymentMethod,
        reference,
        userId,
        churchId: churchId!,
        type: 'event_ticket',
      },
    });
    transactionId = transaction.id;
  }

  const ticket = await prisma.eventTicket.create({
    data: { ticketNumber, eventId, userId: memberId, transactionId, status: 'confirmed' },
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
  const tickets = await prisma.eventTicket.findMany({
    where: { eventId },
    select: {
      id: true,
      ticketNumber: true,
      status: true,
      attended: true,
      attendedAt: true,
      createdAt: true,
      user: { select: { id: true, firstName: true, lastName: true, email: true } },
      transaction: { select: { amount: true, currency: true, paymentMethod: true } },
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

export async function createManualTicket(req: Request, res: Response): Promise<void> {
  const eventId = String(req.params.id);
  const parsed = bookTicketSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const { memberId, paymentMethod, reference, amount, currency, transactionStatus, ticketStatus, notes, useExistingTransaction, existingTransactionId } = parsed.data;

  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) { res.status(404).json({ success: false, message: 'Event not found' }); return; }
  if (!event.requiresTicket) { res.status(400).json({ success: false, message: 'Event does not require tickets' }); return; }

  const member = await prisma.user.findUnique({ 
    where: { id: memberId },
    include: { role: true }
  });
  if (!member) { res.status(404).json({ success: false, message: 'Member not found' }); return; }
  if (member.role?.name !== 'member') { res.status(400).json({ success: false, message: 'Selected user is not a member' }); return; }

  const eventDate = new Date(event.date).toISOString().slice(0, 10).replace(/-/g, '');
  const ticketCount = await prisma.eventTicket.count({ where: { eventId } });
  const eventPrefix = event.title.replace(/\s+/g, '').substring(0, 6).toUpperCase();
  const ticketNumber = `${eventPrefix}-${eventDate}-${String(ticketCount + 1).padStart(4, '0')}`;

  let transactionId = null;

  if (useExistingTransaction && existingTransactionId) {
    const existingTransaction = await prisma.transaction.findUnique({ where: { id: existingTransactionId } });
    if (!existingTransaction) { res.status(404).json({ success: false, message: 'Transaction not found' }); return; }
    transactionId = existingTransactionId;
  } else {
    const ticketAmount = amount !== undefined ? amount : (event.isFree ? 0 : event.ticketPrice || 0);
    const ticketCurrency = currency || event.currency || 'MWK';

    if (ticketAmount > 0) {
      const transaction = await prisma.transaction.create({
        data: {
          amount: ticketAmount,
          currency: ticketCurrency,
          status: transactionStatus || 'completed',
          paymentMethod,
          reference: reference || `MANUAL-${Date.now()}`,
          userId: memberId,
          churchId: member.churchId!,
          type: 'event_ticket',
          notes,
          isManual: true,
        },
      });
      transactionId = transaction.id;
    }
  }

  const ticket = await prisma.eventTicket.create({
    data: { 
      ticketNumber, 
      eventId, 
      userId: memberId, 
      transactionId, 
      status: ticketStatus || 'confirmed',
      isManual: true,
    },
    include: { user: { select: { firstName: true, lastName: true, email: true } }, transaction: true },
  });

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
            convenienceFee: true,
            taxAmount: true,
            totalAmount: true,
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
            feeRate: true,
            baseAmount: true,
            convenienceFee: true,
            taxAmount: true,
            totalAmount: true,
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
  
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) { res.status(404).json({ success: false, message: 'Event not found' }); return; }

  const allocatedTransactionIds = await prisma.eventTicket.findMany({
    where: { eventId, transactionId: { not: null } },
    select: { transactionId: true },
  });

  const transactions = await prisma.transaction.findMany({
    where: {
      type: 'event_ticket',
      churchId: event.churchId,
      id: { notIn: allocatedTransactionIds.map(t => t.transactionId!).filter(Boolean) },
    },
    include: { user: { select: { firstName: true, lastName: true } } },
    orderBy: { createdAt: 'desc' },
  });

  res.json({ success: true, data: transactions });
}
