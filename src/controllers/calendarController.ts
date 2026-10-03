import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { getAccessibleChurchIds } from '../lib/churchScope';

type CalendarActivityType =
  | 'event'
  | 'attendance'
  | 'cell_meeting'
  | 'reminder'
  | 'giving_deadline'
  | 'pledge_due';

interface CalendarActivity {
  id: string;
  sourceId: string;
  type: CalendarActivityType;
  title: string;
  startsAt: Date;
  endsAt?: Date | null;
  churchId: string;
  churchName?: string | null;
  description?: string | null;
  status?: string | null;
  meta?: Record<string, unknown>;
}

const TYPE_PERMISSIONS: Record<CalendarActivityType, string> = {
  event: 'events:read',
  attendance: 'attendance:read',
  cell_meeting: 'cells:read',
  reminder: 'reminders:read',
  giving_deadline: 'campaigns:read',
  pledge_due: 'pledges:read',
};

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function endOfDay(date: Date) {
  const next = new Date(date);
  next.setHours(23, 59, 59, 999);
  return next;
}

function parseTypes(value: unknown): CalendarActivityType[] {
  if (typeof value !== 'string' || value.trim() === '') {
    return Object.keys(TYPE_PERMISSIONS) as CalendarActivityType[];
  }

  const validTypes = new Set(Object.keys(TYPE_PERMISSIONS));
  return value
    .split(',')
    .map(type => type.trim())
    .filter((type): type is CalendarActivityType => validTypes.has(type));
}

function canSeeType(req: Request, type: CalendarActivityType) {
  return req.user?.permissions?.includes(TYPE_PERMISSIONS[type]) ?? false;
}

async function resolveChurchIds(req: Request): Promise<string[]> {
  const roleName = req.user?.role ?? 'member';
  const userId = req.user?.userId;
  const scopedChurchIds = await getAccessibleChurchIds(
    roleName,
    req.user?.churchId,
    req.user?.districts,
    req.user?.traditionalAuthorities,
    req.user?.regions,
    userId,
  );

  const filterChurchId = typeof req.query.churchId === 'string' ? req.query.churchId : undefined;
  if (!filterChurchId || filterChurchId === 'all') return scopedChurchIds;
  return scopedChurchIds.includes(filterChurchId) ? [filterChurchId] : [];
}

export async function getCalendarActivities(req: Request, res: Response): Promise<void> {
  const startDate = parseDate(req.query.startDate);
  const endDateInput = parseDate(req.query.endDate);
  const endDate = endDateInput ? endOfDay(endDateInput) : null;

  if (!startDate || !endDate) {
    res.status(400).json({ success: false, message: 'startDate and endDate are required' });
    return;
  }

  const churchIds = await resolveChurchIds(req);
  if (churchIds.length === 0) {
    res.json({ success: true, data: [] });
    return;
  }

  const requestedTypes = parseTypes(req.query.types).filter(type => canSeeType(req, type));
  const activities: CalendarActivity[] = [];

  await Promise.all([
    requestedTypes.includes('event')
      ? prisma.event.findMany({
          where: {
            churchId: { in: churchIds },
            date: { gte: startDate, lte: endDate },
            publicationStatus: 'published',
            status: { not: 'cancelled' },
          },
          select: {
            id: true,
            title: true,
            description: true,
            date: true,
            endDate: true,
            time: true,
            endTime: true,
            location: true,
            status: true,
            churchId: true,
            church: { select: { name: true } },
          },
        }).then(events => {
          activities.push(...events.map(event => ({
            id: `event:${event.id}`,
            sourceId: event.id,
            type: 'event' as const,
            title: event.title,
            startsAt: event.date,
            endsAt: event.endDate,
            churchId: event.churchId,
            churchName: event.church.name,
            description: event.description,
            status: event.status,
            meta: { time: event.time, endTime: event.endTime, location: event.location },
          })));
        })
      : Promise.resolve(),

    requestedTypes.includes('attendance')
      ? prisma.attendance.findMany({
          where: { churchId: { in: churchIds }, date: { gte: startDate, lte: endDate } },
          select: {
            id: true,
            date: true,
            serviceType: true,
            totalAttendees: true,
            churchId: true,
            church: { select: { name: true } },
          },
        }).then(records => {
          activities.push(...records.map(record => ({
            id: `attendance:${record.id}`,
            sourceId: record.id,
            type: 'attendance' as const,
            title: record.serviceType || 'Service attendance',
            startsAt: record.date,
            churchId: record.churchId,
            churchName: record.church.name,
            meta: { totalAttendees: record.totalAttendees },
          })));
        })
      : Promise.resolve(),

    requestedTypes.includes('cell_meeting')
      ? prisma.cellMeeting.findMany({
          where: {
            date: { gte: startDate, lte: endDate },
            publicationStatus: 'published',
            cell: { churchId: { in: churchIds } },
          },
          select: {
            id: true,
            date: true,
            time: true,
            topic: true,
            notes: true,
            cell: { select: { id: true, name: true, churchId: true, church: { select: { name: true } } } },
          },
        }).then(meetings => {
          activities.push(...meetings.map(meeting => ({
            id: `cell_meeting:${meeting.id}`,
            sourceId: meeting.id,
            type: 'cell_meeting' as const,
            title: meeting.topic || `${meeting.cell.name} meeting`,
            startsAt: meeting.date,
            churchId: meeting.cell.churchId,
            churchName: meeting.cell.church.name,
            description: meeting.notes,
            meta: { time: meeting.time, cellId: meeting.cell.id, cellName: meeting.cell.name },
          })));
        })
      : Promise.resolve(),

    requestedTypes.includes('reminder')
      ? prisma.reminderCache.findMany({
          where: {
            churchId: { in: churchIds },
            upcomingDate: { gte: startDate, lte: endDate },
            type: { in: ['birthday', 'wedding', 'member_anniversary', 'church_founded'] },
          },
          select: {
            id: true,
            type: true,
            upcomingDate: true,
            churchId: true,
            age: true,
            years: true,
            user: { select: { firstName: true, lastName: true } },
            church: { select: { name: true } },
          },
          take: 500,
        }).then(reminders => {
          activities.push(...reminders.map(reminder => ({
            id: `reminder:${reminder.id}`,
            sourceId: reminder.id,
            type: 'reminder' as const,
            title: `${reminder.user.firstName} ${reminder.user.lastName} ${reminder.type.replace(/_/g, ' ')}`,
            startsAt: reminder.upcomingDate,
            churchId: reminder.churchId,
            churchName: reminder.church.name,
            meta: { reminderType: reminder.type, age: reminder.age, years: reminder.years },
          })));
        })
      : Promise.resolve(),

    requestedTypes.includes('giving_deadline')
      ? prisma.givingCampaign.findMany({
          where: {
            churchId: { in: churchIds },
            endDate: { gte: startDate, lte: endDate },
            status: 'active',
          },
          select: {
            id: true,
            name: true,
            category: true,
            targetAmount: true,
            currency: true,
            endDate: true,
            churchId: true,
            church: { select: { name: true } },
          },
        }).then(campaigns => {
          activities.push(...campaigns.flatMap(campaign => campaign.endDate ? [{
            id: `giving_deadline:${campaign.id}`,
            sourceId: campaign.id,
            type: 'giving_deadline' as const,
            title: `${campaign.name} deadline`,
            startsAt: campaign.endDate,
            churchId: campaign.churchId,
            churchName: campaign.church.name,
            meta: { category: campaign.category, targetAmount: campaign.targetAmount, currency: campaign.currency },
          }] : []));
        })
      : Promise.resolve(),

    requestedTypes.includes('pledge_due')
      ? prisma.pledge.findMany({
          where: {
            churchId: { in: churchIds },
            fulfillmentDeadline: { gte: startDate, lte: endDate },
            status: { in: ['pending', 'partial', 'overdue'] },
          },
          select: {
            id: true,
            pledgerName: true,
            pledgedAmount: true,
            amountPaid: true,
            currency: true,
            fulfillmentDeadline: true,
            status: true,
            churchId: true,
            church: { select: { name: true } },
            user: { select: { firstName: true, lastName: true } },
            campaign: { select: { name: true } },
          },
        }).then(pledges => {
          activities.push(...pledges.flatMap(pledge => pledge.fulfillmentDeadline ? [{
            id: `pledge_due:${pledge.id}`,
            sourceId: pledge.id,
            type: 'pledge_due' as const,
            title: `${pledge.pledgerName || `${pledge.user?.firstName ?? ''} ${pledge.user?.lastName ?? ''}`.trim() || 'Pledge'} due`,
            startsAt: pledge.fulfillmentDeadline,
            churchId: pledge.churchId,
            churchName: pledge.church.name,
            status: pledge.status,
            meta: {
              campaign: pledge.campaign.name,
              pledgedAmount: pledge.pledgedAmount,
              amountPaid: pledge.amountPaid,
              currency: pledge.currency,
            },
          }] : []));
        })
      : Promise.resolve(),
  ]);

  activities.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.title.localeCompare(b.title));
  res.json({ success: true, data: activities });
}
