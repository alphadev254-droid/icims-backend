import { Prisma } from '@prisma/client';
import prisma from './prisma';

const TICKET_NUMBER_RETRY_LIMIT = 5;

export function buildEventTicketNumber(event: { title: string; date: Date | string }, sequence: number): string {
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

export async function createEventTicketWithUniqueNumber(
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
  const nextSequence = Math.max(latestSequence, countSequence) + 1;

  for (let attempt = 0; attempt < TICKET_NUMBER_RETRY_LIMIT; attempt += 1) {
    try {
      return await prisma.eventTicket.create({
        data: {
          ...data,
          eventId: event.id,
          ticketNumber: buildEventTicketNumber(event, nextSequence + attempt),
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
