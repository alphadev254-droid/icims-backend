import { Request, Response } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { getAccessibleChurchIds } from '../lib/churchScope';

const visitorSchema = z.object({
  name: z.string().min(1, 'Visitor name required'),
  phone: z.string().optional(),
  email: z.string().optional(),
  residentialArea: z.string().optional(),
  gender: z.string().optional(),
  ageBracket: z.string().optional(),
  howHeard: z.string().optional(),
  notes: z.string().optional(),
  isNewConvert: z.boolean().optional().default(false),
  invitedByUserId: z.string().optional(),
});

const schema = z.object({
  date: z.string().min(1, 'Date required'),
  totalAttendees: z.number().int().min(0),
  maleCount: z.number().int().min(0).default(0),
  femaleCount: z.number().int().min(0).default(0),
  children: z.number().int().min(0).default(0),
  youth: z.number().int().min(0).default(0),
  youngAdults: z.number().int().min(0).default(0),
  adults: z.number().int().min(0).default(0),
  seniors: z.number().int().min(0).default(0),
  newVisitors: z.number().int().min(0).default(0),
  serviceType: z.string().default('Sunday Service'),
  notes: z.string().optional(),
  eventId: z.string().optional(),
  churchId: z.string().optional(),
  visitors: z.array(visitorSchema).optional(),
});

const qrSettingsSchema = z.object({
  digitalCheckInEnabled: z.boolean().optional(),
  qrStatus: z.enum(['draft', 'active', 'closed']).optional(),
  qrActiveFrom: z.string().optional().nullable(),
  qrActiveUntil: z.string().optional().nullable(),
});

const startQrAttendanceSchema = z.object({
  churchId: z.string().optional(),
  date: z.string().min(1, 'Date required'),
  serviceType: z.string().default('Sunday Service'),
  eventId: z.string().optional(),
  notes: z.string().optional(),
  qrActiveFrom: z.string().optional().nullable(),
  qrActiveUntil: z.string().optional().nullable(),
});

const guestCheckInSchema = z.object({
  guestName: z.string().trim().min(1, 'Name is required'),
  guestEmail: z.string().trim().min(1, 'Email is required').email('Enter a valid email address'),
  guestPhone: z.string().trim().min(1, 'Phone is required'),
  guestGender: z.string().trim().min(1, 'Gender is required'),
  guestAgeBracket: z.string().trim().min(1, 'Age is required'),
  guestResidentialArea: z.string().optional(),
  guestHowHeard: z.string().optional(),
  guestNotes: z.string().optional(),
  guestFirstTime: z.boolean().optional(),
  invitedBy: z.string().optional(),
  invitedByUserId: z.string().optional(),
  isNewConvert: z.boolean().optional().default(false),
});

const manualMembersSchema = z.object({
  userIds: z.array(z.string().min(1)).min(1, 'Select at least one member'),
});

const ticketScanSchema = z.object({
  ticket: z.string().trim().min(1, 'Ticket number or QR value is required'),
});

const attendanceListSelect: any = {
  id: true,
  churchId: true,
  date: true,
  totalAttendees: true,
  maleCount: true,
  femaleCount: true,
  children: true,
  youth: true,
  youngAdults: true,
  adults: true,
  seniors: true,
  newVisitors: true,
  newConverts: true,
  serviceType: true,
  notes: true,
  eventId: true,
  createdAt: true,
  digitalCheckInEnabled: true,
  qrToken: true,
  qrStatus: true,
  qrActiveFrom: true,
  qrActiveUntil: true,
  qrRegeneratedAt: true,
  church: { select: { id: true, name: true, ministryAdminId: true } },
  _count: { select: { participants: true } },
};

function generateQrToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function getAge(dateOfBirth?: Date | string | null) {
  if (!dateOfBirth) return null;
  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const monthDelta = today.getMonth() - dob.getMonth();
  if (monthDelta < 0 || (monthDelta === 0 && today.getDate() < dob.getDate())) age -= 1;
  if (age < 0 || age > 130) return null;
  return age;
}

function ageBucketFromAge(age: number | null) {
  if (age === null) return null;
  if (age <= 12) return 'children';
  if (age <= 17) return 'youth';
  if (age <= 35) return 'youngAdults';
  if (age <= 59) return 'adults';
  return 'seniors';
}

function ageBucketForMember(member: { memberType?: string | null; dateOfBirth?: Date | string | null }) {
  const memberType = String(member.memberType || '').toLowerCase();
  const age = getAge(member.dateOfBirth);
  if (age === null) {
    if (memberType === 'child') return 'children';
    if (memberType === 'adult') return 'adults';
    return null;
  }
  if (memberType === 'adult' && age < 18) return 'adults';
  if (memberType === 'child' && age >= 18) return 'children';
  return ageBucketFromAge(age);
}

function ageBucketFromBracket(ageBracket?: string | null) {
  if (!ageBracket) return null;
  if (ageBracket === '0-12') return 'children';
  if (ageBracket === '13-17') return 'youth';
  if (ageBracket === '18-35') return 'youngAdults';
  if (ageBracket === '36-59') return 'adults';
  if (ageBracket === '60+') return 'seniors';
  const numericAge = Number.parseInt(ageBracket, 10);
  return Number.isFinite(numericAge) ? ageBucketFromAge(numericAge) : null;
}

function attendanceIncrementData(gender?: string | null, ageBucket?: string | null, isGuest = false) {
  const data: any = { totalAttendees: { increment: 1 } };
  const normalizedGender = String(gender || '').toLowerCase();
  if (normalizedGender === 'male') data.maleCount = { increment: 1 };
  if (normalizedGender === 'female') data.femaleCount = { increment: 1 };
  if (ageBucket && ['children', 'youth', 'youngAdults', 'adults', 'seniors'].includes(ageBucket)) {
    data[ageBucket] = { increment: 1 };
  }
  if (isGuest) data.newVisitors = { increment: 1 };
  return data;
}

const visitorParticipantMethods = ['visitor_detail', 'legacy_visitor'];

function visitorToParticipantData(visitor: z.infer<typeof visitorSchema>, attendanceId: string, method = 'visitor_detail') {
  return {
    attendanceId,
    guestName: visitor.name.trim(),
    guestEmail: visitor.email?.trim() || null,
    guestPhone: visitor.phone?.trim() || null,
    guestGender: visitor.gender?.trim() || null,
    guestAgeBracket: visitor.ageBracket?.trim() || null,
    guestResidentialArea: visitor.residentialArea?.trim() || null,
    guestHowHeard: visitor.howHeard?.trim() || null,
    guestNotes: visitor.notes?.trim() || null,
    invitedByUserId: visitor.invitedByUserId?.trim() || null,
    isNewConvert: visitor.isNewConvert ?? false,
    guestFirstTime: false,
    checkInMethod: method,
    status: 'present',
  };
}

function participantToVisitor(participant: any) {
  return {
    id: participant.id,
    attendanceId: participant.attendanceId,
    name: participant.guestName,
    phone: participant.guestPhone,
    email: participant.guestEmail,
    residentialArea: participant.guestResidentialArea,
    gender: participant.guestGender,
    ageBracket: participant.guestAgeBracket,
    howHeard: participant.guestHowHeard,
    notes: participant.guestNotes,
    invitedByUserId: participant.invitedByUserId,
    invitedByUser: participant.invitedByUser,
    isNewConvert: participant.isNewConvert,
    createdAt: participant.createdAt,
    attendance: participant.attendance,
  };
}

function mergeAttendanceIncrement(target: any, increment: any) {
  for (const [key, value] of Object.entries(increment)) {
    const amount = (value as any)?.increment ?? 0;
    if (!amount) continue;
    target[key] = { increment: (target[key]?.increment ?? 0) + amount };
  }
  return target;
}

function extractQrToken(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const match = trimmed.match(/\/member-qr\/([^/?#]+)/i) || trimmed.match(/[?&]token=([^&#]+)/i);
  return decodeURIComponent(match?.[1] || trimmed);
}

function extractTicketNumber(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const patterns = [
    /\/ticket\/([^/?#]+)/i,
    /[?&]ticket=([^&#]+)/i,
    /[?&]ticketNumber=([^&#]+)/i,
    /^event-ticket:(.+)$/i,
  ];
  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match?.[1]) return decodeURIComponent(match[1]).trim();
  }
  return trimmed;
}

function parseRequiredDate(value: string, label: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return { ok: false as const, message: `Invalid ${label}` };
  }
  return { ok: true as const, date };
}

function validateOptionalDate(value: string | null | undefined, label: string) {
  if (!value) return { ok: true as const, date: null };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return { ok: false as const, message: `Invalid ${label}` };
  }
  return { ok: true as const, date };
}

function isQrOpen(attendance: any) {
  const now = new Date();
  if (!attendance.digitalCheckInEnabled || attendance.qrStatus !== 'active') return false;
  if (attendance.qrActiveFrom && new Date(attendance.qrActiveFrom) > now) return false;
  if (attendance.qrActiveUntil && new Date(attendance.qrActiveUntil) < now) return false;
  return true;
}

function eventChurchIds(event: any): string[] {
  const ids = new Set<string>();
  if (event?.churchId) ids.add(event.churchId);
  for (const link of event?.linkedChurches || []) {
    if (link.churchId) ids.add(link.churchId);
  }
  return Array.from(ids);
}

async function resolveAttendanceTargetChurch(
  eventId: string | undefined,
  requestedChurchId: string | undefined,
  accessibleChurchIds: string[],
) {
  if (!eventId) {
    if (!requestedChurchId) return { ok: false as const, status: 400, message: 'Church ID required' };
    if (!accessibleChurchIds.includes(requestedChurchId)) return { ok: false as const, status: 403, message: 'Access denied to this church' };
    return { ok: true as const, churchId: requestedChurchId, event: null };
  }

  const event = await (prisma.event as any).findUnique({
    where: { id: eventId },
    include: { linkedChurches: { select: { churchId: true } } },
  });
  if (!event) return { ok: false as const, status: 404, message: 'Event not found' };

  const allowedEventChurchIds = eventChurchIds(event);
  const canAccessEvent = allowedEventChurchIds.some(id => accessibleChurchIds.includes(id));
  if (!canAccessEvent) return { ok: false as const, status: 403, message: 'Access denied to this event' };

  return { ok: true as const, churchId: event.churchId, event };
}

async function canAccessAttendanceRecord(record: any, accessibleChurchIds: string[]) {
  if (accessibleChurchIds.includes(record.churchId)) return true;
  if (!record.eventId) return false;
  const event = await (prisma.event as any).findUnique({
    where: { id: record.eventId },
    include: { linkedChurches: { select: { churchId: true } } },
  });
  if (!event) return false;
  return eventChurchIds(event).some(id => accessibleChurchIds.includes(id));
}

async function attendanceAcceptsChurch(attendance: any, churchId?: string | null) {
  if (!churchId) return false;
  if (!attendance.eventId) return churchId === attendance.churchId;
  const event = await (prisma.event as any).findUnique({
    where: { id: attendance.eventId },
    include: { linkedChurches: { select: { churchId: true } } },
  });
  if (!event) return false;
  return eventChurchIds(event).includes(churchId);
}

async function getAttendanceLinkedChurchIds(attendance: any) {
  if (!attendance.eventId) return [attendance.churchId].filter(Boolean);
  const event = await (prisma.event as any).findUnique({
    where: { id: attendance.eventId },
    include: { linkedChurches: { select: { churchId: true } } },
  });
  return event ? eventChurchIds(event) : [attendance.churchId].filter(Boolean);
}

async function findLinkedMemberByContact(attendance: any, email?: string | null, phone?: string | null) {
  const linkedChurchIds = await getAttendanceLinkedChurchIds(attendance);
  if (!linkedChurchIds.length) return null;

  const normalizedEmail = normalizeContactValue(email);
  const phoneKeys = phoneLookupKeys(phone);
  const contactWhere = [
    ...(normalizedEmail ? [{ email: normalizedEmail }] : []),
    ...(phoneKeys.length ? [{ phone: { in: phoneKeys } }] : []),
  ];
  if (!contactWhere.length) return null;

  return prisma.user.findFirst({
    where: {
      churchId: { in: linkedChurchIds },
      status: 'active',
      loginEnabled: true,
      memberType: { not: 'child' },
      OR: contactWhere,
    },
    select: {
      id: true,
      churchId: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      memberType: true,
      gender: true,
      dateOfBirth: true,
      church: { select: { id: true, name: true } },
    },
  });
}

async function createMatchedMemberParticipant(tx: any, attendanceId: string, member: any, checkInMethod: string) {
  const created = await tx.attendanceParticipant.create({
    data: {
      attendanceId,
      sourceChurchId: member.churchId,
      userId: member.id,
      checkInMethod,
    },
    include: {
      user: {
        select: {
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          memberType: true,
          gender: true,
          dateOfBirth: true,
          church: { select: { id: true, name: true } },
        },
      },
      sourceChurch: { select: { id: true, name: true } },
    },
  });
  await tx.attendance.update({
    where: { id: attendanceId },
    data: attendanceIncrementData(member.gender, ageBucketForMember(member)),
  });
  return created;
}

async function assertAttendanceAccess(req: Request, attendanceId: string) {
  const record = await (prisma.attendance as any).findUnique({
    where: { id: attendanceId },
    include: { church: { select: { id: true, name: true, ministryAdminId: true } } },
  });
  if (!record) return { ok: false as const, status: 404, message: 'Record not found' };

  const accessibleChurchIds = await getAccessibleChurchIds(
    req.user?.role!,
    req.user?.churchId,
    req.user?.districts,
    req.user?.traditionalAuthorities,
    req.user?.regions,
    req.user?.userId
  );

  if (!(await canAccessAttendanceRecord(record, accessibleChurchIds))) {
    return { ok: false as const, status: 403, message: 'Access denied' };
  }

  return { ok: true as const, record };
}

function normalizeContactValue(value?: string | null) {
  return String(value || '').trim().toLowerCase();
}

function normalizePhoneValue(value?: string | null) {
  return String(value || '').replace(/\D/g, '');
}

function phoneLookupKeys(value?: string | null) {
  const raw = String(value || '').trim();
  const digits = normalizePhoneValue(value);
  const keys = new Set<string>();
  if (raw) keys.add(raw.toLowerCase());
  if (digits) keys.add(digits);

  if (digits.startsWith('265') && digits.length === 12) {
    const localNine = digits.slice(3);
    keys.add(localNine);
    keys.add(`0${localNine}`);
    keys.add(`265${localNine}`);
    keys.add(`+265${localNine}`);
  } else if (digits.startsWith('0') && digits.length === 10) {
    const localNine = digits.slice(1);
    keys.add(localNine);
    keys.add(`0${localNine}`);
    keys.add(`265${localNine}`);
    keys.add(`+265${localNine}`);
  } else if (digits.length === 9) {
    keys.add(digits);
    keys.add(`0${digits}`);
    keys.add(`265${digits}`);
    keys.add(`+265${digits}`);
  }

  return Array.from(keys).filter(Boolean);
}

async function enrichAttendanceRecordsWithParticipantCounts(records: any[]) {
  if (!records.length) return records;

  const attendanceIds = records.map(record => record.id).filter(Boolean);
  const recordById = new Map(records.map(record => [record.id, record]));
  const participantDelegate = (prisma as any).attendanceParticipant;
  const participants = await participantDelegate.findMany({
    where: { attendanceId: { in: attendanceIds } },
      select: {
        attendanceId: true,
        sourceChurchId: true,
        userId: true,
        guestEmail: true,
        guestPhone: true,
        guestFirstTime: true,
        user: { select: { churchId: true } },
    },
  });

  const guestEmails: string[] = Array.from(new Set(
    participants
      .filter((participant: any) => !participant.userId)
      .map((participant: any) => normalizeContactValue(participant.guestEmail))
      .filter((value: string): value is string => Boolean(value))
  ));
  const guestPhones: string[] = Array.from(new Set(
    participants
      .filter((participant: any) => !participant.userId)
      .flatMap((participant: any) => phoneLookupKeys(participant.guestPhone))
  ));

  const matchedMembers = (guestEmails.length || guestPhones.length)
    ? await prisma.user.findMany({
        where: {
          status: 'active',
          loginEnabled: true,
          memberType: { not: 'child' },
          OR: [
            ...(guestEmails.length ? [{ email: { in: guestEmails } }] : []),
            ...(guestPhones.length ? [{ phone: { in: guestPhones } }] : []),
          ],
        },
        select: {
          id: true,
          email: true,
          phone: true,
          ministryAdminId: true,
          church: { select: { id: true, ministryAdminId: true } },
        },
      })
    : [];

  const membersByEmail = new Map<string, any[]>();
  const membersByPhone = new Map<string, any[]>();
  for (const member of matchedMembers) {
    const email = normalizeContactValue(member.email);
    const phoneKeys = phoneLookupKeys(member.phone);
    if (email) membersByEmail.set(email, [...(membersByEmail.get(email) || []), member]);
    for (const phone of phoneKeys) {
      membersByPhone.set(phone, [...(membersByPhone.get(phone) || []), member]);
    }
  }

  const counts = new Map<string, { trueVisitors: number; ministryMemberGuests: number; checkedInParticipants: number; firstTimeVisitors: number }>();
  for (const id of attendanceIds) {
    counts.set(id, { trueVisitors: 0, ministryMemberGuests: 0, checkedInParticipants: 0, firstTimeVisitors: 0 });
  }

  for (const participant of participants) {
    const record = recordById.get(participant.attendanceId);
    const rowCounts = counts.get(participant.attendanceId);
    if (!record || !rowCounts) continue;
    rowCounts.checkedInParticipants += 1;

    if (participant.userId) {
      const sourceChurchId = participant.sourceChurchId || participant.user?.churchId;
      if (sourceChurchId && sourceChurchId !== record.churchId) {
        rowCounts.ministryMemberGuests += 1;
      }
      continue;
    }

    const ministryAdminId = record.church?.ministryAdminId || null;
    const emailMatches = membersByEmail.get(normalizeContactValue(participant.guestEmail)) || [];
    const phoneMatches = phoneLookupKeys(participant.guestPhone).flatMap(phone => membersByPhone.get(phone) || []);
    const matchedMinistryMember = [...emailMatches, ...phoneMatches].some(member => {
      const memberMinistryId = member.ministryAdminId || member.church?.ministryAdminId || null;
      return ministryAdminId && memberMinistryId === ministryAdminId;
    });

    if (matchedMinistryMember) rowCounts.ministryMemberGuests += 1;
    else {
      rowCounts.trueVisitors += 1;
      if (participant.guestFirstTime) rowCounts.firstTimeVisitors += 1;
    }
  }

  return records.map(record => ({
    ...record,
    checkedInParticipants: counts.get(record.id)?.checkedInParticipants ?? 0,
    trueVisitors: counts.get(record.id)?.trueVisitors ?? 0,
    ministryMemberGuests: counts.get(record.id)?.ministryMemberGuests ?? 0,
    firstTimeVisitors: counts.get(record.id)?.firstTimeVisitors ?? 0,
  }));
}

export async function getAttendance(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const churchId = req.user?.churchId;
  const roleName = req.user?.role ?? 'member';
  const { churchId: filterChurchId, serviceType, startDate, endDate } = req.query;
  
  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  // Use getAccessibleChurchIds for all roles
  const accessibleChurchIds = await getAccessibleChurchIds(
    roleName,
    churchId,
    req.user?.districts,
    req.user?.traditionalAuthorities,
    req.user?.regions,
    userId
  );

  if (accessibleChurchIds.length === 0) {
    res.json({ success: true, data: [] });
    return;
  }

  async function buildAttendanceScopeWhere(scopedChurchIds: string[]) {
    const accessibleEvents = await (prisma.event as any).findMany({
      where: {
        OR: [
          { churchId: { in: scopedChurchIds } },
          { linkedChurches: { some: { churchId: { in: scopedChurchIds } } } },
        ],
      },
      select: { id: true },
    });
    const eventIds = accessibleEvents.map((event: any) => event.id);
    return {
      OR: [
        { churchId: { in: scopedChurchIds }, eventId: null },
        ...(eventIds.length ? [{ eventId: { in: eventIds } }] : []),
      ],
    };
  }

  let scopedChurchIds = accessibleChurchIds;
  
  // Apply filters
  if (filterChurchId && typeof filterChurchId === 'string') {
    // Ensure the filtered church is in accessible churches
    if (accessibleChurchIds.includes(filterChurchId)) {
      scopedChurchIds = [filterChurchId];
    } else {
      // User doesn't have access to this church
      res.json({ success: true, data: [] });
      return;
    }
  }
  const whereClause: any = await buildAttendanceScopeWhere(scopedChurchIds);
  if (serviceType && typeof serviceType === 'string') {
    whereClause.serviceType = serviceType;
  }
  if (startDate && typeof startDate === 'string') {
    whereClause.date = { ...whereClause.date, gte: new Date(startDate) };
  }
  if (endDate && typeof endDate === 'string') {
    const endDateTime = new Date(endDate);
    endDateTime.setHours(23, 59, 59, 999); // Include the entire end date
    whereClause.date = { ...whereClause.date, lte: endDateTime };
  }

  const page  = Math.max(1, parseInt(req.query.page  as string) || 1);
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
  const skip  = (page - 1) * limit;
  const isExport = req.query.export === 'true';

  if (isExport) {
    // Export mode: respect limit+page params (capped at 5000 per batch), return pagination wrapper
    const exportLimit = Math.min(parseInt(req.query.limit as string) || 5000, 5000);
    const exportSkip = (page - 1) * exportLimit;
    const [records, total] = await Promise.all([
      prisma.attendance.findMany({
        where: whereClause,
        select: attendanceListSelect,
        orderBy: { date: 'desc' },
        skip: exportSkip,
        take: exportLimit,
      }),
      prisma.attendance.count({ where: whereClause }),
    ]);
    const enrichedRecords = await enrichAttendanceRecordsWithParticipantCounts(records);
    res.json({ success: true, data: enrichedRecords, pagination: { page, limit: exportLimit, total, totalPages: Math.ceil(total / exportLimit) } });
    return;
  }

  const [records, total] = await Promise.all([
    prisma.attendance.findMany({
      where: whereClause,
      select: attendanceListSelect,
      orderBy: { date: 'desc' },
      skip,
      take: limit,
    }),
    prisma.attendance.count({ where: whereClause }),
  ]);
  
  const enrichedRecords = await enrichAttendanceRecordsWithParticipantCounts(records);
  res.json({ success: true, data: enrichedRecords, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
}

export async function createAttendance(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const churchId = req.user?.churchId;
  const roleName = req.user?.role;
  
  // Check if user has attendance_tracking feature
  const { hasFeature } = await import('../lib/packageChecker');
  if (!(await hasFeature(userId!, 'attendance_tracking'))) {
    res.status(403).json({ success: false, message: 'Your package does not include Attendance Tracking. Please upgrade to access this feature.' });
    return;
  }
  
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const { churchId: requestedChurchId, eventId, visitors, ...data } = parsed.data;
  if (eventId && !(await hasFeature(userId!, 'event_attendance'))) {
    res.status(403).json({ success: false, message: 'Your package does not include Event Attendance. Please upgrade to access this feature.' });
    return;
  }

  // Verify user has access to this church
  const accessibleChurchIds = await getAccessibleChurchIds(
    roleName!,
    churchId,
    req.user?.districts,
    req.user?.traditionalAuthorities,
    req.user?.regions,
    userId
  );

  const target = await resolveAttendanceTargetChurch(eventId, requestedChurchId, accessibleChurchIds);
  if (!target.ok) {
    res.status(target.status).json({ success: false, message: target.message });
    return;
  }
  const targetChurchId = target.churchId;

  const parsedAttendanceDate = parseRequiredDate(data.date, 'attendance date');
  if (!parsedAttendanceDate.ok) {
    res.status(400).json({ success: false, message: parsedAttendanceDate.message });
    return;
  }
  const attendanceDate = parsedAttendanceDate.date;
  const dateOnly = new Date(attendanceDate.getFullYear(), attendanceDate.getMonth(), attendanceDate.getDate());

  // Auto-set newVisitors count from visitors array if provided
  const newVisitorsCount = visitors && visitors.length > 0 ? visitors.length : data.newVisitors;
  const newConvertsCount = visitors?.filter(v => v.isNewConvert).length ?? 0;

  // For event attendance, check if record exists for same event and date
  if (eventId) {
    const existing = await prisma.attendance.findFirst({
      where: { eventId },
    });

    if (existing) {
      const updated = await prisma.attendance.update({
        where: { id: existing.id },
        data: {
          totalAttendees: data.totalAttendees,
          maleCount: data.maleCount,
          femaleCount: data.femaleCount,
          children: data.children,
          youth: data.youth,
          youngAdults: data.youngAdults,
          adults: data.adults,
          seniors: data.seniors,
          newVisitors: newVisitorsCount,
          newConverts: newConvertsCount,
          serviceType: data.serviceType || existing.serviceType,
          notes: data.notes,
        },
      });
      if (visitors?.length) {
        await (prisma as any).attendanceParticipant.createMany({
          data: visitors.map(v => visitorToParticipantData(v, existing.id)),
        });
      }
      res.json({ success: true, data: updated, updated: true });
      return;
    }
  }

  // Create new record with visitors in a transaction
  const record = await prisma.$transaction(async (tx) => {
    const attendance = await tx.attendance.create({
      data: { ...data, newVisitors: newVisitorsCount, newConverts: newConvertsCount, churchId: targetChurchId, eventId, date: attendanceDate },
    });
    if (visitors?.length) {
      await (tx as any).attendanceParticipant.createMany({
        data: visitors.map(v => visitorToParticipantData(v, attendance.id)),
      });
    }
    return attendance;
  });

  res.status(201).json({ success: true, data: record });
}

export async function startQrAttendance(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const churchId = req.user?.churchId;
  const roleName = req.user?.role;

  const { hasFeature } = await import('../lib/packageChecker');
  if (!(await hasFeature(userId!, 'attendance_tracking'))) {
    res.status(403).json({ success: false, message: 'Your package does not include Attendance Tracking. Please upgrade to access this feature.' });
    return;
  }

  const parsed = startQrAttendanceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }
  if (parsed.data.eventId && !(await hasFeature(userId!, 'event_attendance'))) {
    res.status(403).json({ success: false, message: 'Your package does not include Event Attendance. Please upgrade to access this feature.' });
    return;
  }

  const accessibleChurchIds = await getAccessibleChurchIds(
    roleName!,
    churchId,
    req.user?.districts,
    req.user?.traditionalAuthorities,
    req.user?.regions,
    userId
  );

  const target = await resolveAttendanceTargetChurch(parsed.data.eventId, parsed.data.churchId, accessibleChurchIds);
  if (!target.ok) {
    res.status(target.status).json({ success: false, message: target.message });
    return;
  }
  const targetChurchId = target.churchId;

  const parsedAttendanceDate = parseRequiredDate(parsed.data.date, 'attendance date');
  if (!parsedAttendanceDate.ok) {
    res.status(400).json({ success: false, message: parsedAttendanceDate.message });
    return;
  }
  const attendanceDate = parsedAttendanceDate.date;
  const qrActiveFrom = validateOptionalDate(parsed.data.qrActiveFrom, 'QR active from');
  const qrActiveUntil = validateOptionalDate(parsed.data.qrActiveUntil, 'QR active until');
  if (!qrActiveFrom.ok) {
    res.status(400).json({ success: false, message: qrActiveFrom.message });
    return;
  }
  if (!qrActiveUntil.ok) {
    res.status(400).json({ success: false, message: qrActiveUntil.message });
    return;
  }
  const effectiveQrActiveFrom = qrActiveFrom.date || attendanceDate;
  if (qrActiveUntil.date && qrActiveUntil.date <= effectiveQrActiveFrom) {
    res.status(400).json({ success: false, message: 'QR active until must be after QR active from' });
    return;
  }
  const dateOnly = new Date(attendanceDate.getFullYear(), attendanceDate.getMonth(), attendanceDate.getDate());
  const existingWhere: any = parsed.data.eventId
    ? { eventId: parsed.data.eventId }
    : {
        churchId: targetChurchId,
        serviceType: parsed.data.serviceType,
        date: {
          gte: dateOnly,
          lt: new Date(dateOnly.getTime() + 24 * 60 * 60 * 1000),
        },
      };

  const existing = await (prisma.attendance as any).findFirst({ where: existingWhere });
  if (existing) {
    const updated = await (prisma.attendance as any).update({
      where: { id: existing.id },
      data: {
        digitalCheckInEnabled: true,
        qrStatus: 'active',
        qrToken: existing.qrToken || generateQrToken(),
        qrActiveFrom: qrActiveFrom.date || existing.qrActiveFrom || attendanceDate,
        qrActiveUntil: qrActiveUntil.date,
      },
      include: { church: { select: { id: true, name: true } }, _count: { select: { participants: true } } },
    });
    res.json({ success: true, data: updated, updated: true });
    return;
  }

  const record = await (prisma.attendance as any).create({
    data: {
      churchId: targetChurchId,
      eventId: parsed.data.eventId,
      date: attendanceDate,
      totalAttendees: 0,
      maleCount: 0,
      femaleCount: 0,
      children: 0,
      youth: 0,
      youngAdults: 0,
      adults: 0,
      seniors: 0,
      newVisitors: 0,
      serviceType: parsed.data.serviceType,
      notes: parsed.data.notes,
      digitalCheckInEnabled: true,
      qrStatus: 'active',
      qrToken: generateQrToken(),
      qrActiveFrom: effectiveQrActiveFrom,
      qrActiveUntil: qrActiveUntil.date,
    },
    include: { church: { select: { id: true, name: true } }, _count: { select: { participants: true } } },
  });

  res.status(201).json({ success: true, data: record });
}

export async function getAttendanceById(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id);
  const access = await assertAttendanceAccess(req, id);
  if (!access.ok) {
    res.status(access.status).json({ success: false, message: access.message });
    return;
  }

  const record = await (prisma.attendance as any).findUnique({
    where: { id },
    select: attendanceListSelect,
  });

  res.json({ success: true, data: record });
}

export async function updateAttendance(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const churchId = req.user?.churchId;
  const roleName = req.user?.role;
  const id = req.params.id as string;

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const { churchId: targetChurchId, eventId, visitors, ...data } = parsed.data;

  const record = await prisma.attendance.findUnique({
    where: { id },
    include: { church: true },
  });
  if (!record) {
    res.status(404).json({ success: false, message: 'Record not found' });
    return;
  }

  // Verify user has access
  const accessibleChurchIds = await getAccessibleChurchIds(
    roleName!,
    churchId,
    req.user?.districts,
    req.user?.traditionalAuthorities,
    req.user?.regions,
    userId
  );

  if (!accessibleChurchIds.includes(record.churchId)) {
    res.status(403).json({ success: false, message: 'Access denied' });
    return;
  }
  if (targetChurchId && !accessibleChurchIds.includes(targetChurchId)) {
    res.status(403).json({ success: false, message: 'Cannot move attendance to a church outside your scope' });
    return;
  }

  const blockingParticipantCount = await (prisma as any).attendanceParticipant.count({
    where: {
      attendanceId: id,
      checkInMethod: { notIn: visitorParticipantMethods },
    },
  });
  const summaryLocked = !!record.qrToken || record.digitalCheckInEnabled || blockingParticipantCount > 0;
  const parsedAttendanceDate = parseRequiredDate(data.date, 'attendance date');
  if (!parsedAttendanceDate.ok) {
    res.status(400).json({ success: false, message: parsedAttendanceDate.message });
    return;
  }

  if (summaryLocked) {
    const updated = await prisma.attendance.update({
      where: { id },
      data: {
        churchId: targetChurchId,
        date: parsedAttendanceDate.date,
        serviceType: data.serviceType,
        eventId,
      },
      select: attendanceListSelect,
    } as any);
    res.json({ success: true, data: updated });
    return;
  }

  const newVisitorsCount = visitors && visitors.length > 0 ? visitors.length : data.newVisitors;
  const newConvertsCount = visitors?.filter(v => v.isNewConvert).length ?? 0;

  const updated = await prisma.$transaction(async (tx) => {
    const attendance = await tx.attendance.update({
      where: { id },
      data: { ...data, newVisitors: newVisitorsCount, newConverts: newConvertsCount, date: parsedAttendanceDate.date, churchId: targetChurchId, eventId },
    });
    if (visitors !== undefined) {
      await (tx as any).attendanceParticipant.deleteMany({
        where: { attendanceId: id, checkInMethod: { in: visitorParticipantMethods } },
      });
      if (visitors.length > 0) {
        await (tx as any).attendanceParticipant.createMany({
          data: visitors.map(v => visitorToParticipantData(v, id)),
        });
      }
    }
    return attendance;
  });

  res.json({ success: true, data: updated });
}

export async function getAttendanceVisitors(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id);
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  const page  = Math.max(1, parseInt(req.query.page  as string) || 1);
  const skip  = (page - 1) * limit;

  const [visitors, total] = await Promise.all([
    (prisma as any).attendanceParticipant.findMany({
      where: { attendanceId: id, checkInMethod: { in: visitorParticipantMethods } },
      include: { invitedByUser: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } } },
      orderBy: { createdAt: 'asc' },
      skip,
      take: limit,
    }),
    (prisma as any).attendanceParticipant.count({ where: { attendanceId: id, checkInMethod: { in: visitorParticipantMethods } } }),
  ]);

  res.json({ success: true, data: visitors.map(participantToVisitor), total, hasMore: skip + visitors.length < total, page, limit });
}

export async function addAttendanceVisitor(req: Request, res: Response): Promise<void> {
  const attendanceId = String(req.params.id);
  const parsed = visitorSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }
  const participant = await (prisma as any).attendanceParticipant.create({
    data: visitorToParticipantData(parsed.data, attendanceId),
    include: { invitedByUser: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } } },
  });
  // Keep newVisitors count in sync
  await prisma.attendance.update({
    where: { id: attendanceId },
    data: {
      newVisitors: { increment: 1 },
      ...(parsed.data.isNewConvert ? { newConverts: { increment: 1 } } : {}),
    },
  });
  res.status(201).json({ success: true, data: participantToVisitor(participant) });
}

export async function deleteAttendanceVisitor(req: Request, res: Response): Promise<void> {
  const attendanceId = String(req.params.id);
  const visitorId = String(req.params.visitorId);
  const visitor = await (prisma as any).attendanceParticipant.findFirst({
    where: { id: visitorId, attendanceId, checkInMethod: { in: visitorParticipantMethods } },
    select: { isNewConvert: true },
  });
  if (!visitor) {
    res.status(404).json({ success: false, message: 'Visitor not found' });
    return;
  }
  await (prisma as any).attendanceParticipant.delete({ where: { id: visitorId } });
  await prisma.attendance.update({
    where: { id: attendanceId },
    data: {
      newVisitors: { decrement: 1 },
      ...(visitor.isNewConvert ? { newConverts: { decrement: 1 } } : {}),
    },
  });
  res.json({ success: true });
}

export async function getAttendanceParticipants(req: Request, res: Response): Promise<void> {
  const attendanceId = String(req.params.id);
  const access = await assertAttendanceAccess(req, attendanceId);
  if (!access.ok) {
    res.status(access.status).json({ success: false, message: access.message });
    return;
  }

  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 1000);
  const skip = (page - 1) * limit;
  const participantType = String(req.query.participantType || 'all');
  const validParticipantTypes = new Set(['all', 'visitors', 'ministry_member_guests', 'new_converts']);
  if (!validParticipantTypes.has(participantType)) {
    res.status(400).json({ success: false, message: 'Invalid participant type filter' });
    return;
  }
  const participantWhere: any = {
    attendanceId,
    ...(participantType === 'new_converts' ? { isNewConvert: true } : {}),
  };

  const participantDelegate = (prisma as any).attendanceParticipant;
  const participants = await participantDelegate.findMany({
    where: participantWhere,
    include: {
      user: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          memberType: true,
          gender: true,
          dateOfBirth: true,
          church: { select: { id: true, name: true } },
        },
      },
      sourceChurch: { select: { id: true, name: true } },
      invitedByUser: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
      eventTicket: {
        select: {
          id: true,
          ticketNumber: true,
          status: true,
          attended: true,
          attendedAt: true,
          church: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { checkedInAt: 'desc' },
  });

  const attendanceMinistryId = access.record.church?.ministryAdminId;
  const guestEmails = participants
    .filter((participant: any) => !participant.userId)
    .map((participant: any) => normalizeContactValue(participant.guestEmail))
    .filter((value: string): value is string => Boolean(value));
  const guestPhones = participants
    .filter((participant: any) => !participant.userId)
    .flatMap((participant: any) => phoneLookupKeys(participant.guestPhone));

  let matchedMembers: any[] = [];
  if (attendanceMinistryId && (guestEmails.length > 0 || guestPhones.length > 0)) {
    matchedMembers = await prisma.user.findMany({
      where: {
        AND: [
          {
            OR: [
              { ministryAdminId: attendanceMinistryId },
              { church: { ministryAdminId: attendanceMinistryId } },
            ],
          },
          {
            OR: [
              ...(guestEmails.length ? [{ email: { in: Array.from(new Set<string>(guestEmails)) } }] : []),
              ...(guestPhones.length ? [{ phone: { in: Array.from(new Set<string>(guestPhones)) } }] : []),
            ],
          },
        ],
        status: 'active',
        loginEnabled: true,
        memberType: { not: 'child' },
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        memberType: true,
        church: { select: { id: true, name: true } },
      },
    });
  }

  const memberByEmail = new Map<string, any>();
  const memberByPhone = new Map<string, any>();
  for (const member of matchedMembers) {
    const email = normalizeContactValue(member.email);
    const phoneKeys = phoneLookupKeys(member.phone);
    if (email) memberByEmail.set(email, member);
    for (const phone of phoneKeys) {
      memberByPhone.set(phone, member);
    }
  }

  const enrichedParticipants = participants.map((participant: any) => {
    if (participant.userId) return participant;
    const matchedMember =
      memberByEmail.get(normalizeContactValue(participant.guestEmail)) ||
      phoneLookupKeys(participant.guestPhone).map(phone => memberByPhone.get(phone)).find(Boolean);
    if (!matchedMember) return participant;
    return {
      ...participant,
      ministryMember: {
        id: matchedMember.id,
        firstName: matchedMember.firstName,
        lastName: matchedMember.lastName,
        email: matchedMember.email,
        phone: matchedMember.phone,
        memberType: matchedMember.memberType,
        church: matchedMember.church,
      },
    };
  });
  const filteredParticipants = enrichedParticipants.filter((participant: any) => {
    if (participantType === 'visitors') return !participant.user && !participant.ministryMember;
    if (participantType === 'ministry_member_guests') {
      const userHomeChurchId = participant.user?.church?.id || '';
      return Boolean(
        participant.ministryMember ||
        (participant.user && userHomeChurchId && userHomeChurchId !== access.record.churchId)
      );
    }
    return true;
  });
  const total = filteredParticipants.length;
  const pagedParticipants = filteredParticipants.slice(skip, skip + limit);

  res.json({ success: true, data: pagedParticipants, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
}

export async function searchAttendanceMembers(req: Request, res: Response): Promise<void> {
  const attendanceId = String(req.params.id);
  const access = await assertAttendanceAccess(req, attendanceId);
  if (!access.ok) {
    res.status(access.status).json({ success: false, message: access.message });
    return;
  }

  const q = String(req.query.q || '').trim();
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 70, 1), 100);
  const skip = (page - 1) * limit;

  if (q.length < 3) {
    res.json({ success: true, data: [], pagination: { page, limit, total: 0, totalPages: 0 } });
    return;
  }

  const linkedChurchIds = await getAttendanceLinkedChurchIds(access.record);
  const terms = q.split(/\s+/).filter(Boolean);
  const where: any = {
    churchId: { in: linkedChurchIds },
    status: 'active',
    OR: [
      { firstName: { contains: q } },
      { lastName: { contains: q } },
      { email: { contains: q } },
      { phone: { contains: q } },
      ...(terms.length > 1
        ? [{
            AND: terms.map(term => ({
              OR: [
                { firstName: { contains: term } },
                { lastName: { contains: term } },
                { email: { contains: term } },
                { phone: { contains: term } },
              ],
            })),
          }]
        : []),
    ],
  };

  const [members, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        memberType: true,
        gender: true,
        dateOfBirth: true,
        church: { select: { id: true, name: true } },
      },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      skip,
      take: limit,
    }),
    prisma.user.count({ where }),
  ]);

  const participantDelegate = (prisma as any).attendanceParticipant;
  const existing = members.length
    ? await participantDelegate.findMany({
        where: { attendanceId, userId: { in: members.map(member => member.id) } },
        select: { userId: true },
      })
    : [];
  const checkedInIds = new Set(existing.map((participant: any) => participant.userId));

  res.json({
    success: true,
    data: members.map(member => ({ ...member, alreadyCheckedIn: checkedInIds.has(member.id) })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
}

export async function addManualAttendanceMembers(req: Request, res: Response): Promise<void> {
  const attendanceId = String(req.params.id);
  const parsed = manualMembersSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const access = await assertAttendanceAccess(req, attendanceId);
  if (!access.ok) {
    res.status(access.status).json({ success: false, message: access.message });
    return;
  }

  const userIds = Array.from(new Set(parsed.data.userIds));
  const linkedChurchIds = await getAttendanceLinkedChurchIds(access.record);
  const members = await prisma.user.findMany({
    where: { id: { in: userIds }, churchId: { in: linkedChurchIds }, status: 'active' },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      memberType: true,
      churchId: true,
      gender: true,
      dateOfBirth: true,
      church: { select: { id: true, name: true } },
    },
  });

  if (!members.length) {
    res.status(400).json({ success: false, message: 'No valid members found for this attendance' });
    return;
  }

  const participantDelegate = (prisma as any).attendanceParticipant;
  const existing = await participantDelegate.findMany({
    where: { attendanceId, userId: { in: members.map(member => member.id) } },
    select: { userId: true },
  });
  const existingIds = new Set(existing.map((participant: any) => participant.userId));
  const membersToAdd = members.filter(member => !existingIds.has(member.id));

  const created = await prisma.$transaction(async (tx) => {
    const rows = [];
    let incrementData: any = {};

    for (const member of membersToAdd) {
      rows.push(await (tx as any).attendanceParticipant.create({
        data: {
          attendanceId,
          sourceChurchId: member.churchId,
          userId: member.id,
          checkInMethod: 'manual_member',
        },
        include: { user: { select: { firstName: true, lastName: true, email: true, phone: true, memberType: true, gender: true, dateOfBirth: true } } },
      }));
      incrementData = mergeAttendanceIncrement(
        incrementData,
        attendanceIncrementData(member.gender, ageBucketForMember(member))
      );
    }

    if (rows.length) {
      await (tx.attendance as any).update({ where: { id: attendanceId }, data: incrementData });
    }

    return rows;
  });

  res.status(201).json({
    success: true,
    data: created,
    created: created.length,
    skipped: userIds.length - created.length,
  });
}

export async function addManualAttendanceVisitor(req: Request, res: Response): Promise<void> {
  const attendanceId = String(req.params.id);
  const parsed = guestCheckInSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const access = await assertAttendanceAccess(req, attendanceId);
  if (!access.ok) {
    res.status(access.status).json({ success: false, message: access.message });
    return;
  }

  const data = parsed.data;
  const participantDelegate = (prisma as any).attendanceParticipant;
  const duplicateWhere: any[] = [];
  if (data.guestPhone?.trim()) duplicateWhere.push({ guestPhone: data.guestPhone.trim() });
  if (data.guestEmail?.trim()) duplicateWhere.push({ guestEmail: data.guestEmail.trim() });
  const existing = duplicateWhere.length
    ? await participantDelegate.findFirst({ where: { attendanceId, OR: duplicateWhere } })
    : null;

  if (existing) {
    res.json({ success: true, data: existing, alreadyCheckedIn: true });
    return;
  }

  const matchedMember = await findLinkedMemberByContact(access.record, data.guestEmail, data.guestPhone);
  if (matchedMember) {
    const existingMember = await participantDelegate.findUnique({
      where: { attendanceId_userId: { attendanceId, userId: matchedMember.id } },
    });
    if (existingMember) {
      res.json({ success: true, data: existingMember, alreadyCheckedIn: true, matchedMember: true });
      return;
    }

    const participant = await prisma.$transaction((tx) =>
      createMatchedMemberParticipant(tx, attendanceId, matchedMember, 'manual_visitor_matched_member')
    );
    res.status(201).json({ success: true, data: participant, matchedMember: true });
    return;
  }

  const participant = await prisma.$transaction(async (tx) => {
    const created = await (tx as any).attendanceParticipant.create({
      data: {
        attendanceId,
        guestName: data.guestName.trim(),
        guestEmail: data.guestEmail?.trim() || null,
        guestPhone: data.guestPhone?.trim() || null,
        guestGender: data.guestGender?.trim() || null,
        guestAgeBracket: data.guestAgeBracket?.trim() || null,
        guestResidentialArea: data.guestResidentialArea?.trim() || null,
        guestHowHeard: data.guestHowHeard?.trim() || null,
        guestNotes: data.guestNotes?.trim() || null,
        guestFirstTime: data.guestFirstTime ?? false,
        invitedBy: data.invitedBy?.trim() || null,
        invitedByUserId: data.invitedByUserId?.trim() || null,
        isNewConvert: data.isNewConvert ?? false,
        checkInMethod: 'manual_visitor',
      },
    });
    await (tx.attendance as any).update({
      where: { id: attendanceId },
      data: {
        ...attendanceIncrementData(data.guestGender, ageBucketFromBracket(data.guestAgeBracket), true),
        ...(data.isNewConvert ? { newConverts: { increment: 1 } } : {}),
      },
    });
    return created;
  });

  res.status(201).json({ success: true, data: participant });
}

export async function updateAttendanceQrSettings(req: Request, res: Response): Promise<void> {
  const attendanceId = String(req.params.id);
  const parsed = qrSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const access = await assertAttendanceAccess(req, attendanceId);
  if (!access.ok) {
    res.status(access.status).json({ success: false, message: access.message });
    return;
  }

  const data: any = {};
  if (parsed.data.digitalCheckInEnabled !== undefined) data.digitalCheckInEnabled = parsed.data.digitalCheckInEnabled;
  if (parsed.data.qrStatus) data.qrStatus = parsed.data.qrStatus;
  const qrActiveFrom = validateOptionalDate(parsed.data.qrActiveFrom, 'QR active from');
  const qrActiveUntil = validateOptionalDate(parsed.data.qrActiveUntil, 'QR active until');
  if (!qrActiveFrom.ok) {
    res.status(400).json({ success: false, message: qrActiveFrom.message });
    return;
  }
  if (!qrActiveUntil.ok) {
    res.status(400).json({ success: false, message: qrActiveUntil.message });
    return;
  }
  const effectiveQrActiveFrom = parsed.data.qrActiveFrom !== undefined ? qrActiveFrom.date : access.record.qrActiveFrom;
  const effectiveQrActiveUntil = parsed.data.qrActiveUntil !== undefined ? qrActiveUntil.date : access.record.qrActiveUntil;
  if (effectiveQrActiveFrom && effectiveQrActiveUntil && effectiveQrActiveUntil <= effectiveQrActiveFrom) {
    res.status(400).json({ success: false, message: 'QR active until must be after QR active from' });
    return;
  }
  if (parsed.data.qrActiveFrom !== undefined) data.qrActiveFrom = qrActiveFrom.date;
  if (parsed.data.qrActiveUntil !== undefined) data.qrActiveUntil = qrActiveUntil.date;
  if (!access.record.qrToken) data.qrToken = generateQrToken();

  const updated = await (prisma.attendance as any).update({
    where: { id: attendanceId },
    data,
    include: { church: { select: { id: true, name: true } }, _count: { select: { participants: true } } },
  });

  res.json({ success: true, data: updated });
}

export async function activateAttendanceQr(req: Request, res: Response): Promise<void> {
  const attendanceId = String(req.params.id);
  const access = await assertAttendanceAccess(req, attendanceId);
  if (!access.ok) {
    res.status(access.status).json({ success: false, message: access.message });
    return;
  }

  const updated = await (prisma.attendance as any).update({
    where: { id: attendanceId },
    data: {
      digitalCheckInEnabled: true,
      qrStatus: 'active',
      qrToken: access.record.qrToken || generateQrToken(),
      qrActiveFrom: access.record.qrActiveFrom || new Date(),
    },
    include: { church: { select: { id: true, name: true } }, _count: { select: { participants: true } } },
  });

  res.json({ success: true, data: updated });
}

export async function closeAttendanceQr(req: Request, res: Response): Promise<void> {
  const attendanceId = String(req.params.id);
  const access = await assertAttendanceAccess(req, attendanceId);
  if (!access.ok) {
    res.status(access.status).json({ success: false, message: access.message });
    return;
  }

  const updated = await (prisma.attendance as any).update({
    where: { id: attendanceId },
    data: { qrStatus: 'closed', digitalCheckInEnabled: false },
    include: { church: { select: { id: true, name: true } }, _count: { select: { participants: true } } },
  });

  res.json({ success: true, data: updated });
}

export async function regenerateAttendanceQr(req: Request, res: Response): Promise<void> {
  const attendanceId = String(req.params.id);
  const access = await assertAttendanceAccess(req, attendanceId);
  if (!access.ok) {
    res.status(access.status).json({ success: false, message: access.message });
    return;
  }

  const updated = await (prisma.attendance as any).update({
    where: { id: attendanceId },
    data: { qrToken: generateQrToken(), qrRegeneratedAt: new Date() },
    include: { church: { select: { id: true, name: true } }, _count: { select: { participants: true } } },
  });

  res.json({ success: true, data: updated });
}

export async function getQrCheckInSession(req: Request, res: Response): Promise<void> {
  const token = String(req.params.token);
  const attendance = await (prisma.attendance as any).findUnique({
    where: { qrToken: token },
    include: {
      church: {
        select: {
          id: true,
          name: true,
          ministryAdmin: {
            select: {
              subdomain: true,
              churchProfile: { select: { logoUrl: true, primaryColor: true, tagline: true } },
            },
          },
        },
      },
      _count: { select: { participants: true } },
    },
  });

  if (!attendance) {
    res.status(404).json({ success: false, message: 'Check-in link not found' });
    return;
  }

  const event = attendance.eventId
    ? await prisma.event.findUnique({ where: { id: attendance.eventId }, select: { id: true, title: true, date: true, time: true, location: true } })
    : null;

  res.json({
    success: true,
    data: {
      id: attendance.id,
      date: attendance.date,
      serviceType: attendance.serviceType,
      church: attendance.church,
      event,
      qrStatus: attendance.qrStatus,
      qrActiveFrom: attendance.qrActiveFrom,
      qrActiveUntil: attendance.qrActiveUntil,
      isOpen: isQrOpen(attendance),
      participantCount: attendance._count?.participants ?? 0,
    },
  });
}

export async function checkInMemberByQr(req: Request, res: Response): Promise<void> {
  const token = String(req.params.token);
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ success: false, message: 'Sign in to check in as a member' });
    return;
  }

  const attendance = await (prisma.attendance as any).findUnique({ where: { qrToken: token } });
  if (!attendance) {
    res.status(404).json({ success: false, message: 'Check-in link not found' });
    return;
  }
  if (!isQrOpen(attendance)) {
    res.status(400).json({ success: false, message: 'This check-in QR code is not active' });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { churchId: true, firstName: true, lastName: true, email: true, phone: true, memberType: true, gender: true, dateOfBirth: true } });
  if (!user || !(await attendanceAcceptsChurch(attendance, user.churchId))) {
    res.status(403).json({ success: false, message: 'This check-in is only for members of churches linked to this attendance' });
    return;
  }

  const participantDelegate = (prisma as any).attendanceParticipant;
  const existing = await participantDelegate.findUnique({
    where: { attendanceId_userId: { attendanceId: attendance.id, userId } },
    include: { user: { select: { firstName: true, lastName: true, email: true, phone: true, memberType: true, gender: true, dateOfBirth: true } } },
  });
  if (existing) {
    res.json({ success: true, data: existing, alreadyCheckedIn: true });
    return;
  }

  const participant = await prisma.$transaction(async (tx) => {
    const created = await (tx as any).attendanceParticipant.create({
      data: {
        attendanceId: attendance.id,
        sourceChurchId: user.churchId,
        userId,
        checkInMethod: 'qr_member',
      },
      include: { user: { select: { firstName: true, lastName: true, email: true, phone: true, memberType: true, gender: true, dateOfBirth: true } } },
    });
    await (tx.attendance as any).update({
      where: { id: attendance.id },
      data: attendanceIncrementData(user.gender, ageBucketForMember(user)),
    });
    return created;
  });

  res.status(201).json({ success: true, data: participant });
}

export async function checkInGuestByQr(req: Request, res: Response): Promise<void> {
  const token = String(req.params.token);
  const parsed = guestCheckInSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const attendance = await (prisma.attendance as any).findUnique({ where: { qrToken: token } });
  if (!attendance) {
    res.status(404).json({ success: false, message: 'Check-in link not found' });
    return;
  }
  if (!isQrOpen(attendance)) {
    res.status(400).json({ success: false, message: 'This check-in QR code is not active' });
    return;
  }

  const data = parsed.data;
  const participantDelegate = (prisma as any).attendanceParticipant;
  const duplicateWhere: any[] = [];
  if (data.guestPhone?.trim()) duplicateWhere.push({ guestPhone: data.guestPhone.trim() });
  if (data.guestEmail?.trim()) duplicateWhere.push({ guestEmail: data.guestEmail.trim() });
  const existing = duplicateWhere.length
    ? await participantDelegate.findFirst({ where: { attendanceId: attendance.id, OR: duplicateWhere } })
    : null;

  if (existing) {
    res.json({ success: true, data: existing, alreadyCheckedIn: true });
    return;
  }

  const matchedMember = await findLinkedMemberByContact(attendance, data.guestEmail, data.guestPhone);
  if (matchedMember) {
    const existingMember = await participantDelegate.findUnique({
      where: { attendanceId_userId: { attendanceId: attendance.id, userId: matchedMember.id } },
    });
    if (existingMember) {
      res.json({ success: true, data: existingMember, alreadyCheckedIn: true, matchedMember: true });
      return;
    }

    const participant = await prisma.$transaction((tx) =>
      createMatchedMemberParticipant(tx, attendance.id, matchedMember, 'qr_guest_matched_member')
    );
    res.status(201).json({ success: true, data: participant, matchedMember: true });
    return;
  }

  const participant = await prisma.$transaction(async (tx) => {
    const created = await (tx as any).attendanceParticipant.create({
      data: {
        attendanceId: attendance.id,
        guestName: data.guestName.trim(),
        guestEmail: data.guestEmail?.trim() || null,
        guestPhone: data.guestPhone?.trim() || null,
        guestGender: data.guestGender?.trim() || null,
        guestAgeBracket: data.guestAgeBracket?.trim() || null,
        guestResidentialArea: data.guestResidentialArea?.trim() || null,
        guestHowHeard: data.guestHowHeard?.trim() || null,
        guestNotes: data.guestNotes?.trim() || null,
        guestFirstTime: data.guestFirstTime ?? false,
        invitedBy: data.invitedBy?.trim() || null,
        invitedByUserId: data.invitedByUserId?.trim() || null,
        isNewConvert: data.isNewConvert ?? false,
        checkInMethod: 'qr_guest',
      },
    });
    await (tx.attendance as any).update({
      where: { id: attendance.id },
      data: {
        ...attendanceIncrementData(data.guestGender, ageBucketFromBracket(data.guestAgeBracket), true),
        ...(data.isNewConvert ? { newConverts: { increment: 1 } } : {}),
      },
    });
    return created;
  });

  res.status(201).json({ success: true, data: participant });
}

export async function scanMemberAttendanceQr(req: Request, res: Response): Promise<void> {
  const attendanceId = String(req.params.id);
  const rawToken = typeof req.body?.token === 'string' ? req.body.token : '';
  const token = extractQrToken(rawToken);
  if (!token) {
    res.status(400).json({ success: false, message: 'Member QR token is required' });
    return;
  }

  const access = await assertAttendanceAccess(req, attendanceId);
  if (!access.ok) {
    res.status(access.status).json({ success: false, message: access.message });
    return;
  }

  const attendance = access.record;
  if (!isQrOpen(attendance)) {
    res.status(400).json({ success: false, message: 'This attendance QR session is not active' });
    return;
  }

  const member = await prisma.user.findUnique({
    where: { attendanceQrToken: token } as any,
    select: {
      id: true,
      churchId: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      memberType: true,
      gender: true,
      dateOfBirth: true,
      status: true,
      loginEnabled: true,
    },
  });

  if (!member || member.status !== 'active' || member.loginEnabled === false) {
    res.status(404).json({ success: false, message: 'Member QR not found or inactive' });
    return;
  }
  if (!(await attendanceAcceptsChurch(attendance, member.churchId))) {
    res.status(403).json({ success: false, message: 'This member belongs to a church not linked to this attendance' });
    return;
  }

  const participantDelegate = (prisma as any).attendanceParticipant;
  const existing = await participantDelegate.findUnique({
    where: { attendanceId_userId: { attendanceId, userId: member.id } },
    include: { user: { select: { firstName: true, lastName: true, email: true, phone: true, memberType: true, gender: true, dateOfBirth: true } } },
  });

  if (existing) {
    res.json({ success: true, data: existing, alreadyCheckedIn: true });
    return;
  }

  const participant = await prisma.$transaction(async (tx) => {
    const created = await (tx as any).attendanceParticipant.create({
      data: {
        attendanceId,
        sourceChurchId: member.churchId,
        userId: member.id,
        checkInMethod: 'admin_scan',
      },
      include: { user: { select: { firstName: true, lastName: true, email: true, phone: true, memberType: true, gender: true, dateOfBirth: true } } },
    });
    await (tx.attendance as any).update({
      where: { id: attendanceId },
      data: attendanceIncrementData(member.gender, ageBucketForMember(member)),
    });
    return created;
  });

  res.status(201).json({ success: true, data: participant });
}

export async function scanEventTicketAttendance(req: Request, res: Response): Promise<void> {
  const attendanceId = String(req.params.id);
  const parsed = ticketScanSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const access = await assertAttendanceAccess(req, attendanceId);
  if (!access.ok) {
    res.status(access.status).json({ success: false, message: access.message });
    return;
  }

  const attendance = access.record;
  if (!attendance.eventId) {
    res.status(400).json({ success: false, message: 'Ticket scanning is only available for event attendance' });
    return;
  }
  if (!isQrOpen(attendance)) {
    res.status(400).json({ success: false, message: 'This attendance QR session is not active' });
    return;
  }

  const ticketNumber = extractTicketNumber(parsed.data.ticket);
  const ticket = await (prisma.eventTicket as any).findUnique({
    where: { ticketNumber },
    include: {
      user: {
        select: {
          id: true,
          churchId: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          memberType: true,
          gender: true,
          dateOfBirth: true,
          status: true,
          church: { select: { id: true, name: true } },
        },
      },
      church: { select: { id: true, name: true } },
    },
  });

  if (!ticket) {
    res.status(404).json({ success: false, message: 'Ticket not found' });
    return;
  }
  if (ticket.eventId !== attendance.eventId) {
    res.status(400).json({ success: false, message: 'This ticket belongs to a different event' });
    return;
  }
  if (ticket.status === 'cancelled') {
    res.status(400).json({ success: false, message: 'This ticket has been cancelled' });
    return;
  }
  if (ticket.churchId && !(await attendanceAcceptsChurch(attendance, ticket.churchId))) {
    res.status(403).json({ success: false, message: 'This ticket belongs to a church not linked to this attendance' });
    return;
  }

  const participantDelegate = (prisma as any).attendanceParticipant;
  const existingByTicket = await participantDelegate.findUnique({
    where: { eventTicketId: ticket.id },
    include: {
      user: { select: { firstName: true, lastName: true, email: true, phone: true, memberType: true, gender: true, dateOfBirth: true } },
      sourceChurch: { select: { id: true, name: true } },
      eventTicket: { select: { id: true, ticketNumber: true, church: { select: { id: true, name: true } } } },
    },
  });
  if (existingByTicket) {
    if (existingByTicket.attendanceId !== attendanceId) {
      res.status(409).json({
        success: false,
        message: 'This ticket was already checked in on another attendance record',
      });
      return;
    }
    res.json({ success: true, data: existingByTicket, alreadyCheckedIn: true });
    return;
  }

  const matchedMember = ticket.userId
    ? ticket.user
    : await findLinkedMemberByContact(attendance, ticket.guestEmail, ticket.guestPhone);

  if (matchedMember?.id) {
    if (!(await attendanceAcceptsChurch(attendance, matchedMember.churchId))) {
      res.status(403).json({ success: false, message: 'Matched member belongs to a church not linked to this attendance' });
      return;
    }

    const existingMember = await participantDelegate.findUnique({
      where: { attendanceId_userId: { attendanceId, userId: matchedMember.id } },
      include: {
        user: { select: { firstName: true, lastName: true, email: true, phone: true, memberType: true, gender: true, dateOfBirth: true } },
        sourceChurch: { select: { id: true, name: true } },
        eventTicket: { select: { id: true, ticketNumber: true, church: { select: { id: true, name: true } } } },
      },
    });
    if (existingMember) {
      await (prisma.eventTicket as any).update({
        where: { id: ticket.id },
        data: { attended: true, attendedAt: ticket.attendedAt || new Date() },
      }).catch(() => {});
      res.json({ success: true, data: existingMember, alreadyCheckedIn: true });
      return;
    }

    const participant = await prisma.$transaction(async (tx) => {
      const created = await (tx as any).attendanceParticipant.create({
        data: {
          attendanceId,
          eventTicketId: ticket.id,
          sourceChurchId: matchedMember.churchId,
          userId: matchedMember.id,
          checkInMethod: ticket.userId ? 'ticket_scan' : 'ticket_scan_matched_member',
        },
        include: {
          user: { select: { firstName: true, lastName: true, email: true, phone: true, memberType: true, gender: true, dateOfBirth: true } },
          sourceChurch: { select: { id: true, name: true } },
          eventTicket: { select: { id: true, ticketNumber: true, church: { select: { id: true, name: true } } } },
        },
      });
      await (tx as any).eventTicket.update({
        where: { id: ticket.id },
        data: { attended: true, attendedAt: new Date() },
      });
      await (tx.attendance as any).update({
        where: { id: attendanceId },
        data: attendanceIncrementData(matchedMember.gender, ageBucketForMember(matchedMember)),
      });
      return created;
    });

    res.status(201).json({ success: true, data: participant });
    return;
  }

  const participant = await prisma.$transaction(async (tx) => {
    const created = await (tx as any).attendanceParticipant.create({
      data: {
        attendanceId,
        eventTicketId: ticket.id,
        sourceChurchId: ticket.churchId || attendance.churchId,
        guestName: ticket.guestName,
        guestEmail: ticket.guestEmail,
        guestPhone: ticket.guestPhone,
        checkInMethod: 'ticket_scan_guest',
      },
      include: {
        sourceChurch: { select: { id: true, name: true } },
        eventTicket: { select: { id: true, ticketNumber: true, church: { select: { id: true, name: true } } } },
      },
    });
    await (tx as any).eventTicket.update({
      where: { id: ticket.id },
      data: { attended: true, attendedAt: new Date() },
    });
    await (tx.attendance as any).update({
      where: { id: attendanceId },
      data: attendanceIncrementData(null, null, true),
    });
    return created;
  });

  res.status(201).json({ success: true, data: participant });
}

export async function scanVisitorAttendance(req: Request, res: Response): Promise<void> {
  const attendanceId = String(req.params.id);
  const parsed = guestCheckInSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const access = await assertAttendanceAccess(req, attendanceId);
  if (!access.ok) {
    res.status(access.status).json({ success: false, message: access.message });
    return;
  }

  if (!isQrOpen(access.record)) {
    res.status(400).json({ success: false, message: 'This attendance session is not active' });
    return;
  }

  const data = parsed.data;
  const participantDelegate = (prisma as any).attendanceParticipant;
  const duplicateWhere: any[] = [];
  if (data.guestPhone?.trim()) duplicateWhere.push({ guestPhone: data.guestPhone.trim() });
  if (data.guestEmail?.trim()) duplicateWhere.push({ guestEmail: data.guestEmail.trim() });
  const existing = duplicateWhere.length
    ? await participantDelegate.findFirst({ where: { attendanceId, OR: duplicateWhere } })
    : null;

  if (existing) {
    res.json({ success: true, data: existing, alreadyCheckedIn: true });
    return;
  }

  const matchedMember = await findLinkedMemberByContact(access.record, data.guestEmail, data.guestPhone);
  if (matchedMember) {
    const existingMember = await participantDelegate.findUnique({
      where: { attendanceId_userId: { attendanceId, userId: matchedMember.id } },
    });
    if (existingMember) {
      res.json({ success: true, data: existingMember, alreadyCheckedIn: true, matchedMember: true });
      return;
    }

    const participant = await prisma.$transaction((tx) =>
      createMatchedMemberParticipant(tx, attendanceId, matchedMember, 'admin_visitor_matched_member')
    );
    res.status(201).json({ success: true, data: participant, matchedMember: true });
    return;
  }

  const participant = await prisma.$transaction(async (tx) => {
    const created = await (tx as any).attendanceParticipant.create({
      data: {
        attendanceId,
        guestName: data.guestName.trim(),
        guestEmail: data.guestEmail?.trim() || null,
        guestPhone: data.guestPhone?.trim() || null,
        guestGender: data.guestGender?.trim() || null,
        guestAgeBracket: data.guestAgeBracket?.trim() || null,
        guestResidentialArea: data.guestResidentialArea?.trim() || null,
        guestHowHeard: data.guestHowHeard?.trim() || null,
        guestNotes: data.guestNotes?.trim() || null,
        guestFirstTime: data.guestFirstTime ?? false,
        invitedBy: data.invitedBy?.trim() || null,
        invitedByUserId: data.invitedByUserId?.trim() || null,
        isNewConvert: data.isNewConvert ?? false,
        checkInMethod: 'admin_visitor',
      },
    });
    await (tx.attendance as any).update({
      where: { id: attendanceId },
      data: {
        ...attendanceIncrementData(data.guestGender, ageBucketFromBracket(data.guestAgeBracket), true),
        ...(data.isNewConvert ? { newConverts: { increment: 1 } } : {}),
      },
    });
    return created;
  });

  res.status(201).json({ success: true, data: participant });
}

export async function getServiceVisitorsReport(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const churchId = req.user?.churchId;
  const roleName = req.user?.role ?? 'member';
  const { churchId: filterChurchId, serviceType, startDate, endDate } = req.query;

  if (!userId) { res.status(401).json({ success: false, message: 'Not authenticated' }); return; }

  const accessibleChurchIds = await getAccessibleChurchIds(
    roleName, churchId, req.user?.districts, req.user?.traditionalAuthorities, req.user?.regions, userId,
  );

  if (accessibleChurchIds.length === 0) { res.json({ success: true, data: [] }); return; }

  let scopedChurchIds = accessibleChurchIds;
  if (filterChurchId && typeof filterChurchId === 'string') {
    if (!accessibleChurchIds.includes(filterChurchId)) { res.json({ success: true, data: [] }); return; }
    scopedChurchIds = [filterChurchId];
  }

  const attendanceWhere: any = { churchId: { in: scopedChurchIds } };
  if (serviceType && typeof serviceType === 'string') attendanceWhere.serviceType = serviceType;
  if (startDate || endDate) {
    attendanceWhere.date = {};
    if (startDate) attendanceWhere.date.gte = new Date(startDate as string);
    if (endDate) { const end = new Date(endDate as string); end.setHours(23, 59, 59, 999); attendanceWhere.date.lte = end; }
  }

  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(parseInt(req.query.limit as string) || 5000, 5000);
  const skip = (page - 1) * limit;

  const [visitors, total] = await Promise.all([
    (prisma as any).attendanceParticipant.findMany({
      where: {
        userId: null,
        attendance: attendanceWhere,
        OR: [
          { checkInMethod: { in: visitorParticipantMethods } },
          { checkInMethod: { contains: 'guest' } },
          { checkInMethod: { contains: 'visitor' } },
        ],
      },
      include: {
        attendance: { select: { date: true, serviceType: true, church: { select: { name: true } } } },
        invitedByUser: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    (prisma as any).attendanceParticipant.count({
      where: {
        userId: null,
        attendance: attendanceWhere,
        OR: [
          { checkInMethod: { in: visitorParticipantMethods } },
          { checkInMethod: { contains: 'guest' } },
          { checkInMethod: { contains: 'visitor' } },
        ],
      },
    }),
  ]);

  res.json({ success: true, data: visitors.map(participantToVisitor), pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
}

export async function deleteAttendance(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const churchId = req.user?.churchId;
  const roleName = req.user?.role;
  const id = String(req.params.id);

  const record = await prisma.attendance.findUnique({ where: { id }, include: { church: true } });
  if (!record) {
    res.status(404).json({ success: false, message: 'Record not found' });
    return;
  }

  // Verify user has access to delete
  const accessibleChurchIds = await getAccessibleChurchIds(
    roleName!,
    churchId,
    req.user?.districts,
    req.user?.traditionalAuthorities,
    req.user?.regions,
    userId
  );

  if (!accessibleChurchIds.includes(record.churchId)) {
    res.status(403).json({ success: false, message: 'Access denied' });
    return;
  }

  await prisma.attendance.delete({ where: { id } });
  res.json({ success: true, message: 'Record deleted' });
}
