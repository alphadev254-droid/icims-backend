import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import axios from 'axios';
import { getPaymentGatewayByChurch, getCurrency, getGatewayCountry } from '../utils/gatewayRouter';
import { calculatePaymentFees } from '../utils/feeCalculations';
import { queueEmail } from '../lib/emailQueue';
import { ticketPurchaseTemplate } from '../lib/emailTemplates';
import { generateTicketPDF } from '../lib/ticketPDF';
import { hasFeature } from '../lib/packageChecker';

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY!;
const PAYSTACK_BASE_URL = process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co';
const BACKEND_URL = process.env.BACKEND_URL!;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:8080';

const guestTicketSchema = z.object({
  eventId: z.string().min(1, 'Event ID required'),
  churchId: z.string().optional(),
  guestName: z.string().min(1, 'Full name required'),
  guestEmail: z.string().email('Valid email required'),
  guestPhone: z.string().optional(),
  quantity: z.number().int().positive().default(1),
});

async function eventOwnerHasFeature(eventId: string, featureName: string): Promise<boolean> {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { church: { select: { ministryAdminId: true } } },
  });
  const ministryAdminId = event?.church?.ministryAdminId;
  return ministryAdminId ? hasFeature(ministryAdminId, featureName) : false;
}

function featureUnavailableMessage(featureName: string) {
  return `This event feature is not available in the current package. Please enable ${featureName.replace(/_/g, ' ')}.`;
}

function eventChurchIds(event: { churchId: string; linkedChurches?: Array<{ churchId: string }> }): string[] {
  const ids = event.linkedChurches?.map(link => link.churchId) ?? [];
  return [...new Set(ids.length > 0 ? ids : [event.churchId])];
}

function resolveTicketChurchId(event: { churchId: string; linkedChurches?: Array<{ churchId: string }> }, requestedChurchId?: string | null) {
  const ids = eventChurchIds(event);
  if (requestedChurchId) {
    return ids.includes(requestedChurchId)
      ? { churchId: requestedChurchId }
      : { error: 'This event is not available for the selected church' };
  }
  return { churchId: event.churchId };
}

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

async function createGuestTicketWithUniqueNumber(event: any, data: any) {
  const latestTicket = await prisma.eventTicket.findFirst({
    where: { eventId: event.id },
    orderBy: { createdAt: 'desc' },
    select: { ticketNumber: true },
  });
  const latestSequence = Number(latestTicket?.ticketNumber.match(/-(\d+)$/)?.[1] ?? 0);
  const countSequence = await prisma.eventTicket.count({ where: { eventId: event.id } });
  const nextSequence = Math.max(latestSequence, countSequence) + 1;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await prisma.eventTicket.create({
        data: {
          ...data,
          eventId: event.id,
          ticketNumber: buildTicketNumber(event, nextSequence + attempt),
        },
      });
    } catch (error) {
      if (!isUniqueTicketNumberError(error) || attempt === 4) throw error;
    }
  }

  throw new Error('Unable to generate a unique ticket number');
}

export async function getTransactionByReference(req: Request, res: Response): Promise<void> {
  const { reference } = req.params;

  const tx = await prisma.transaction.findFirst({
    where: { reference: String(reference) },
    select: {
      type: true,
      isGuest: true,
      guestName: true,
      guestEmail: true,
      baseAmount: true,
      currency: true,
      reference: true,
      eventId: true,
      status: true,
      paidAt: true,
      tickets: {
        select: { ticketNumber: true },
      },
    },
  });

  if (!tx) {
    res.status(404).json({ success: false, message: 'Transaction not found' });
    return;
  }

  // Fetch event title separately
  let eventTitle: string | null = null;
  if (tx.eventId) {
    const event = await prisma.event.findUnique({
      where: { id: tx.eventId },
      select: { title: true },
    });
    eventTitle = event?.title || null;
  }

  // Fetch campaign name for donation type
  let campaignName: string | null = null;
  if (tx.type === 'donation') {
    const donation = await prisma.donationTransaction.findFirst({
      where: { reference: String(reference) },
      select: { campaignId: true, guestName: true },
    });
    if (donation?.campaignId) {
      const campaign = await prisma.givingCampaign.findUnique({
        where: { id: donation.campaignId },
        select: { name: true },
      });
      campaignName = campaign?.name || null;
    }
  }

  res.json({
    success: true,
    data: {
      type: tx.type,
      isGuest: tx.isGuest,
      guestName: tx.guestName,
      guestEmail: tx.guestEmail,
      baseAmount: tx.baseAmount,
      currency: tx.currency,
      reference: tx.reference,
      status: tx.status,
      paidAt: tx.paidAt,
      eventTitle,
      campaignName,
      tickets: (tx.tickets ?? []).map((t: { ticketNumber: string }) => t.ticketNumber),
    },
  });
}

export async function getGuestTicketFees(req: Request, res: Response): Promise<void> {
  const { eventId, churchId } = req.query as { eventId: string; churchId?: string };
  if (!eventId) {
    res.status(400).json({ success: false, message: 'eventId required' });
    return;
  }

  const event = await prisma.event.findUnique({
    where: { id: eventId },
    include: { linkedChurches: { select: { churchId: true } } },
  });
  if (!event) {
    res.status(404).json({ success: false, message: 'Event not found' });
    return;
  }
  if (!(await eventOwnerHasFeature(event.id, 'event_online_payments'))) {
    res.status(403).json({ success: false, message: featureUnavailableMessage('event_online_payments') });
    return;
  }
  if (!event.ticketPrice) {
    res.status(400).json({ success: false, message: 'Event has no ticket price' });
    return;
  }

  const resolved = resolveTicketChurchId(event, churchId);
  if (resolved.error || !resolved.churchId) {
    res.status(400).json({ success: false, message: resolved.error || 'Invalid event church' });
    return;
  }

  const gateway = await getPaymentGatewayByChurch(resolved.churchId);
  const currency = getCurrency(gateway);
  const gatewayCountry = getGatewayCountry(gateway);
  const fees = calculatePaymentFees(event.ticketPrice, gatewayCountry);

  res.json({
    success: true,
    data: {
      currency,
      baseAmount: fees.baseAmount,
      convenienceFee: fees.convenienceFee,
      systemFeeAmount: fees.systemFeeAmount,
      transactionCost: fees.totalAmount - fees.baseAmount,
      totalAmount: fees.totalAmount,
    },
  });
}

export async function initiateGuestTicketPurchase(req: Request, res: Response): Promise<void> {
  const traceId = `GUEST-TKT-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  console.log(`[${traceId}] ========== GUEST TICKET PURCHASE ==========`);

  const parsed = guestTicketSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const { eventId, churchId: requestedChurchId, guestName, guestEmail, guestPhone, quantity } = parsed.data;

  const event = await prisma.event.findUnique({
    where: { id: eventId },
    include: {
      church: true,
      linkedChurches: { select: { churchId: true, church: { select: { id: true, name: true } } } },
    },
  });

  if (!event) {
    res.status(404).json({ success: false, message: 'Event not found' });
    return;
  }
  if (!(await eventOwnerHasFeature(event.id, 'event_public_links'))) {
    res.status(403).json({ success: false, message: featureUnavailableMessage('event_public_links') });
    return;
  }
  if (!(await eventOwnerHasFeature(event.id, 'event_guest_booking'))) {
    res.status(403).json({ success: false, message: featureUnavailableMessage('event_guest_booking') });
    return;
  }
  if (!(await eventOwnerHasFeature(event.id, 'event_ticketing'))) {
    res.status(403).json({ success: false, message: featureUnavailableMessage('event_ticketing') });
    return;
  }
  if (!event.requiresTicket) {
    res.status(400).json({ success: false, message: 'Event does not require tickets' });
    return;
  }
  if (!event.allowPublicTicketing) {
    res.status(403).json({ success: false, message: 'Public ticket purchasing is not enabled for this event' });
    return;
  }
  if (event.status === 'completed' || event.status === 'cancelled') {
    res.status(400).json({ success: false, message: 'Event is no longer available' });
    return;
  }
  if (event.ticketSalesCutoff && new Date(event.ticketSalesCutoff) < new Date()) {
    res.status(400).json({ success: false, message: 'Ticket sales have ended' });
    return;
  }
  if (event.totalTickets && event.ticketsSold + quantity > event.totalTickets) {
    res.status(400).json({ success: false, message: 'Not enough tickets available' });
    return;
  }

  // ── Free event: create ticket directly, no payment gateway ──────────────────
  const resolved = resolveTicketChurchId(event, requestedChurchId);
  if (resolved.error || !resolved.churchId) {
    res.status(400).json({ success: false, message: resolved.error || 'Invalid event church' });
    return;
  }
  const selectedChurch = event.linkedChurches.find(link => link.churchId === resolved.churchId)?.church || event.church;

  if (event.isFree) {
    await handleFreeGuestTicket({ event, selectedChurch, guestName, guestEmail, guestPhone: guestPhone || null, quantity, traceId, res });
    return;
  }

  if (!(await eventOwnerHasFeature(event.id, 'event_online_payments'))) {
    res.status(403).json({ success: false, message: featureUnavailableMessage('event_online_payments') });
    return;
  }

  const gateway = await getPaymentGatewayByChurch(resolved.churchId);
  const currency = getCurrency(gateway);
  const gatewayCountry = getGatewayCountry(gateway);
  const baseAmount = event.ticketPrice! * quantity;
  const fees = calculatePaymentFees(baseAmount, gatewayCountry);

  console.log(`[${traceId}] Gateway: ${gateway}, Fees:`, fees);

  const expiresAt = new Date();
  expiresAt.setMinutes(expiresAt.getMinutes() + 30);

  const pendingTx = await prisma.pendingTransaction.create({
    data: {
      amount: fees.totalAmount,
      currency,
      userId: null,
      churchId: resolved.churchId,
      eventId,
      type: 'event_ticket',
      expiresAt,
      metadata: JSON.stringify({
        traceId,
        eventId,
        churchId: resolved.churchId,
        churchName: selectedChurch?.name,
        eventTitle: event.title,
        quantity,
        baseAmount: fees.baseAmount,
        convenienceFee: fees.convenienceFee,
        systemFeeAmount: fees.systemFeeAmount,
        ceilRoundingAmount: fees.ceilRoundingAmount,
        totalAmount: fees.totalAmount,
        gateway,
        gatewayCountry,
        isGuest: true,
        guestName,
        guestEmail,
        guestPhone: guestPhone || null,
      }),
    },
  });

  console.log(`[${traceId}] PendingTransaction created: ${pendingTx.id}`);

  if (gateway === 'paychangu') {
    await initiatePaychanguGuestPayment(pendingTx, event, fees, guestEmail, guestName, resolved.churchId, traceId, res);
  } else {
    await initiatePaystackGuestPayment(pendingTx, event, fees, guestEmail, resolved.churchId, traceId, res);
  }
}

async function handleFreeGuestTicket({
  event, selectedChurch, guestName, guestEmail, guestPhone, quantity, traceId, res,
}: {
  event: any;
  selectedChurch: { id?: string; name: string } | null;
  guestName: string;
  guestEmail: string;
  guestPhone: string | null;
  quantity: number;
  traceId: string;
  res: Response;
}): Promise<void> {
  const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:8080';
  const ticketNumbers: string[] = [];

  // One ticket per email per event
  const existing = await prisma.eventTicket.findFirst({
    where: { eventId: event.id, guestEmail, isGuest: true },
  });
  if (existing) {
    res.status(409).json({ success: false, message: 'A ticket for this email already exists for this event' });
    return;
  }
  for (let i = 0; i < quantity; i++) {
    const ticket = await createGuestTicketWithUniqueNumber(event, {
      churchId: selectedChurch?.id || event.churchId,
      userId: null,
      transactionId: null,
      status: 'confirmed',
      isGuest: true,
      guestName,
      guestEmail,
      guestPhone,
    });
    const ticketNumber = ticket.ticketNumber;

    ticketNumbers.push(ticketNumber);

    const eventDateStr = new Date(event.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const eventEndDateStr = new Date(event.endDate || event.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    const ticketPDF = await generateTicketPDF({
      ticketNumber,
      eventTitle: event.title,
      eventDate: eventDateStr,
      eventEndDate: eventEndDateStr,
      eventLocation: event.location,
      attendeeName: guestName,
      churchName: selectedChurch?.name || event.church.name,
      amount: 0,
      currency: 'FREE',
    });

    const viewUrl = `${FRONTEND_URL}/payment/callback?status=success&type=event_ticket&isGuest=true&isFree=true&reference=${ticketNumber}&guestEmail=${encodeURIComponent(guestEmail)}&guestName=${encodeURIComponent(guestName)}&eventId=${event.id}`;

    queueEmail(
      guestEmail,
      `Free Ticket - ${event.title}`,
      ticketPurchaseTemplate({
        firstName: guestName.split(' ')[0],
        eventTitle: event.title,
        ticketNumber,
        amount: 0,
        currency: 'FREE',
        eventDate: eventDateStr,
        eventEndDate: eventEndDateStr,
        eventLocation: event.location,
        churchName: selectedChurch?.name || event.church.name,
        viewUrl,
      }),
      [{ filename: `ticket-${ticketNumber}.pdf`, content: ticketPDF }]
    );
  }

  await prisma.event.update({
    where: { id: event.id },
    data: { ticketsSold: { increment: quantity } },
  });

  console.log(`[${traceId}] Free guest ticket(s) created: ${ticketNumbers.join(', ')}`);

  res.json({
    success: true,
    data: {
      isFree: true,
      ticketNumbers,
      eventTitle: event.title,
      guestEmail,
    },
  });
}

async function initiatePaystackGuestPayment(
  pendingTx: any,
  event: any,
  fees: any,
  guestEmail: string,
  churchId: string,
  traceId: string,
  res: Response
): Promise<void> {
  try {
    const metadata = JSON.parse(pendingTx.metadata);
    const amountInKobo = Math.round(fees.totalAmount * 100);

    const subaccount = await prisma.subaccount.findUnique({ where: { churchId } });

    const paystackPayload: any = {
      email: guestEmail,
      amount: amountInKobo,
      currency: 'KES',
      callback_url: `${BACKEND_URL}/api/payments/verify`,
      metadata: {
        ...metadata,
        type: 'event_ticket',
        pendingTxId: pendingTx.id,
        isGuest: true,
        subaccountCode: subaccount?.subaccountCode,
        subaccountName: subaccount?.businessName,
      },
      ...(subaccount && {
        subaccount: subaccount.subaccountCode,
        transaction_charge: Math.round((fees.totalAmount - fees.baseAmount) * 100),
        bearer: 'account',
      }),
    };

    const response = await axios.post(
      `${PAYSTACK_BASE_URL}/transaction/initialize`,
      paystackPayload,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' } }
    );

    await prisma.pendingTransaction.update({
      where: { id: pendingTx.id },
      data: { reference: response.data.data.reference },
    });

    console.log(`[${traceId}] Paystack guest payment initialized`);
    res.json({
      success: true,
      data: {
        authorization_url: response.data.data.authorization_url,
        reference: response.data.data.reference,
        baseAmount: fees.baseAmount,
        convenienceFee: fees.convenienceFee,
        systemFeeAmount: fees.systemFeeAmount,
        totalAmount: fees.totalAmount,
        currency: pendingTx.currency,
      },
    });
  } catch (error: any) {
    await prisma.pendingTransaction.delete({ where: { id: pendingTx.id } }).catch(() => {});
    console.error(`[${traceId}] Paystack error:`, error.message);
    res.status(500).json({ success: false, message: error.response?.data?.message || 'Failed to initialize payment' });
  }
}

async function initiatePaychanguGuestPayment(
  pendingTx: any,
  event: any,
  fees: any,
  guestEmail: string,
  guestName: string,
  churchId: string,
  traceId: string,
  res: Response
): Promise<void> {
  const PAYCHANGU_SECRET_KEY = process.env.PAYCHANGU_SECRET_KEY!;
  const tx_ref = `GUEST-TKT-${Date.now()}`;

  try {
    const paychanguPayload = {
      amount: fees.totalAmount,
      currency: 'MWK',
      email: guestEmail,
      first_name: guestName.split(' ')[0],
      last_name: guestName.split(' ').slice(1).join(' ') || guestName.split(' ')[0],
      tx_ref,
      callback_url: `${BACKEND_URL}/api/webhooks/paychangu/callback`,
      return_url: `${FRONTEND_URL}/events/${event.id}?churchId=${encodeURIComponent(churchId)}&status=cancelled`,
      customization: {
        title: `Ticket: ${event.title}`,
        description: 'Event ticket purchase',
      },
    };

    const response = await axios.post('https://api.paychangu.com/payment', paychanguPayload, {
      headers: { Authorization: `Bearer ${PAYCHANGU_SECRET_KEY}`, 'Content-Type': 'application/json' },
    });

    await prisma.pendingTransaction.update({
      where: { id: pendingTx.id },
      data: {
        reference: tx_ref,
        metadata: JSON.stringify({
          ...(pendingTx.metadata ? JSON.parse(pendingTx.metadata) : {}),
          gatewayPayload: paychanguPayload,
        }),
      },
    });

    console.log(`[${traceId}] Paychangu guest payment initialized`);
    res.json({
      success: true,
      data: {
        authorization_url: response.data.data?.checkout_url,
        reference: tx_ref,
        baseAmount: fees.baseAmount,
        convenienceFee: fees.convenienceFee,
        systemFeeAmount: fees.systemFeeAmount,
        totalAmount: fees.totalAmount,
        currency: pendingTx.currency,
      },
    });
  } catch (error: any) {
    await prisma.pendingTransaction.delete({ where: { id: pendingTx.id } }).catch(() => {});
    console.error(`[${traceId}] Paychangu error:`, error.message);
    res.status(500).json({ success: false, message: error.response?.data?.message || 'Failed to initialize payment' });
  }
}
