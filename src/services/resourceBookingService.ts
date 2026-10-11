import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { zonedDateTimeToUtc } from '../lib/timezone';

export class BookingError extends Error {
  constructor(message: string, public statusCode = 400) { super(message); }
}

export async function resolveBookingMinistry(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { ministryAdminId: true, role: { select: { name: true } }, church: { select: { ministryAdminId: true } } },
  });
  const id = user?.role?.name === 'ministry_admin' ? userId : user?.ministryAdminId || user?.church?.ministryAdminId;
  if (!id) throw new BookingError('Ministry account could not be resolved', 403);
  return id;
}

export function blockedInterval(resource: { bufferBeforeMinutes: number; bufferAfterMinutes: number }, startsAt: Date, endsAt: Date) {
  return {
    blockedFrom: new Date(startsAt.getTime() - resource.bufferBeforeMinutes * 60000),
    blockedUntil: new Date(endsAt.getTime() + resource.bufferAfterMinutes * 60000),
  };
}

export async function resolveActivity(input: {
  ministryAdminId: string; churchId: string; activityType: 'manual' | 'service' | 'event'; activityId?: string | null;
  activityTitle?: string; startsAt?: string; endsAt?: string;
}) {
  const providedStart = input.startsAt ? new Date(input.startsAt) : undefined;
  const providedEnd = input.endsAt ? new Date(input.endsAt) : undefined;
  if (Boolean(input.startsAt) !== Boolean(input.endsAt) || (providedStart && (!Number.isFinite(providedStart.getTime()) || !Number.isFinite(providedEnd!.getTime()) || providedStart >= providedEnd!))) {
    throw new BookingError('Enter a valid booking start and end time');
  }
  if (input.activityType === 'manual') {
    const startsAt = providedStart || new Date('');
    const endsAt = providedEnd || new Date('');
    if (!input.activityTitle?.trim() || !Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime()) || startsAt >= endsAt) {
      throw new BookingError('Enter an activity title and a valid start and end time');
    }
    return { activityTitle: input.activityTitle.trim(), startsAt, endsAt, activityId: null };
  }
  if (!input.activityId) throw new BookingError('Select the service or event to book for');
  if (input.activityType === 'service') {
    const service = await prisma.service.findFirst({ where: { id: input.activityId, churchId: input.churchId, church: { ministryAdminId: input.ministryAdminId } } });
    if (!service || service.status === 'cancelled') throw new BookingError('Service is unavailable', 404);
    const startsAt = providedStart || service.startsAt;
    const endsAt = providedEnd || service.endsAt;
    if (!endsAt) throw new BookingError('Set a booking end time before requesting resources');
    return { activityTitle: service.title, startsAt, endsAt, activityId: service.id };
  }
  const event = await prisma.event.findFirst({ where: { id: input.activityId, churchId: input.churchId, church: { ministryAdminId: input.ministryAdminId } }, include: { church: { select: { timezone: true } } } });
  if (!event || event.status === 'cancelled' || event.recordType === 'scheduled_source') throw new BookingError('Choose an individual active event occurrence', 404);
  const timezone = event.church.timezone || 'UTC';
  const startsAt = providedStart || zonedDateTimeToUtc(event.date.toISOString().slice(0, 10), event.time, timezone);
  const endsAt = providedEnd || (event.endTime ? zonedDateTimeToUtc(event.endDate.toISOString().slice(0, 10), event.endTime, timezone) : null);
  if (!endsAt) throw new BookingError('Set a booking end time before requesting resources');
  if (startsAt >= endsAt) throw new BookingError('Event end time must be after its start time');
  return { activityTitle: event.title, startsAt, endsAt, activityId: event.id };
}

export async function lockResources(tx: Prisma.TransactionClient, ids: string[]) {
  for (const id of [...ids].sort()) {
    await tx.$queryRaw`SELECT id FROM bookable_resources WHERE id = ${id} FOR UPDATE`;
  }
}

export async function findConflict(tx: Prisma.TransactionClient, resourceId: string, blockedFrom: Date, blockedUntil: Date, excludedBookingId?: string) {
  return tx.resourceBooking.findFirst({
    where: {
      resourceId,
      status: { in: ['approved', 'blocked'] },
      blockedFrom: { lt: blockedUntil },
      blockedUntil: { gt: blockedFrom },
      ...(excludedBookingId ? { id: { not: excludedBookingId } } : {}),
    },
    select: { id: true, startsAt: true, endsAt: true, activityTitle: true },
    orderBy: { startsAt: 'asc' },
  });
}

export function assertNoLinkedBookingChange(activityType: 'service' | 'event', activityId: string, hasChanged: boolean) {
  if (!hasChanged) return Promise.resolve();
  return prisma.resourceBooking.count({ where: { activityType, activityId, status: { in: ['pending', 'approved'] } } }).then(count => {
    if (count) throw new BookingError('This activity has resource requests. Cancel those bookings before changing its time or branch.', 409);
  });
}

export async function cancelLinkedBookings(activityType: 'service' | 'event', activityId: string) {
  await prisma.resourceBooking.updateMany({
    where: { activityType, activityId, status: { in: ['pending', 'approved'] } },
    data: { status: 'cancelled' },
  });
}

export function newBookingGroupId() { return randomUUID(); }
