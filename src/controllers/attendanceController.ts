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
  churchId: z.string().min(1, 'Church ID required'),
  visitors: z.array(visitorSchema).optional(),
});

const qrSettingsSchema = z.object({
  digitalCheckInEnabled: z.boolean().optional(),
  qrStatus: z.enum(['draft', 'active', 'closed']).optional(),
  qrActiveFrom: z.string().optional().nullable(),
  qrActiveUntil: z.string().optional().nullable(),
});

const startQrAttendanceSchema = z.object({
  churchId: z.string().min(1, 'Church ID required'),
  date: z.string().min(1, 'Date required'),
  serviceType: z.string().default('Sunday Service'),
  eventId: z.string().optional(),
  notes: z.string().optional(),
  qrActiveFrom: z.string().optional().nullable(),
  qrActiveUntil: z.string().optional().nullable(),
});

const guestCheckInSchema = z.object({
  guestName: z.string().min(1, 'Name is required'),
  guestEmail: z.string().email().optional().or(z.literal('')),
  guestPhone: z.string().optional(),
  guestGender: z.string().optional(),
  guestAgeBracket: z.string().optional(),
  guestFirstTime: z.boolean().optional(),
  invitedBy: z.string().optional(),
});

const manualMembersSchema = z.object({
  userIds: z.array(z.string().min(1)).min(1, 'Select at least one member'),
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
  church: { select: { id: true, name: true } },
  _count: { select: { visitors: true, participants: true } },
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

function parseOptionalDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isQrOpen(attendance: any) {
  const now = new Date();
  if (!attendance.digitalCheckInEnabled || attendance.qrStatus !== 'active') return false;
  if (attendance.qrActiveFrom && new Date(attendance.qrActiveFrom) > now) return false;
  if (attendance.qrActiveUntil && new Date(attendance.qrActiveUntil) < now) return false;
  return true;
}

async function assertAttendanceAccess(req: Request, attendanceId: string) {
  const record = await (prisma.attendance as any).findUnique({
    where: { id: attendanceId },
    include: { church: { select: { id: true, name: true } } },
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

  if (!accessibleChurchIds.includes(record.churchId)) {
    return { ok: false as const, status: 403, message: 'Access denied' };
  }

  return { ok: true as const, record };
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

  const whereClause: any = { churchId: { in: accessibleChurchIds } };
  
  // Apply filters
  if (filterChurchId && typeof filterChurchId === 'string') {
    // Ensure the filtered church is in accessible churches
    if (accessibleChurchIds.includes(filterChurchId)) {
      whereClause.churchId = filterChurchId;
    } else {
      // User doesn't have access to this church
      res.json({ success: true, data: [] });
      return;
    }
  }
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
    res.json({ success: true, data: records, pagination: { page, limit: exportLimit, total, totalPages: Math.ceil(total / exportLimit) } });
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
  
  res.json({ success: true, data: records, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
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

  const { churchId: targetChurchId, eventId, visitors, ...data } = parsed.data;

  // Verify user has access to this church
  const accessibleChurchIds = await getAccessibleChurchIds(
    roleName!,
    churchId,
    req.user?.districts,
    req.user?.traditionalAuthorities,
    req.user?.regions,
    userId
  );

  if (!accessibleChurchIds.includes(targetChurchId)) {
    res.status(403).json({ success: false, message: 'Access denied to this church' });
    return;
  }

  const attendanceDate = new Date(data.date);
  const dateOnly = new Date(attendanceDate.getFullYear(), attendanceDate.getMonth(), attendanceDate.getDate());

  // Auto-set newVisitors count from visitors array if provided
  const newVisitorsCount = visitors && visitors.length > 0 ? visitors.length : data.newVisitors;

  // For event attendance, check if record exists for same event and date
  if (eventId) {
    const existing = await prisma.attendance.findFirst({
      where: {
        eventId,
        churchId: targetChurchId,
        date: {
          gte: dateOnly,
          lt: new Date(dateOnly.getTime() + 24 * 60 * 60 * 1000),
        },
      },
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
          notes: data.notes,
        },
      });
      if (visitors?.length) {
        await prisma.attendanceVisitor.createMany({
          data: visitors.map(v => ({ ...v, attendanceId: existing.id })),
        });
      }
      res.json({ success: true, data: updated, updated: true });
      return;
    }
  }

  // Create new record with visitors in a transaction
  const record = await prisma.$transaction(async (tx) => {
    const attendance = await tx.attendance.create({
      data: { ...data, newVisitors: newVisitorsCount, churchId: targetChurchId, eventId, date: attendanceDate },
    });
    if (visitors?.length) {
      await tx.attendanceVisitor.createMany({
        data: visitors.map(v => ({ ...v, attendanceId: attendance.id })),
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

  const accessibleChurchIds = await getAccessibleChurchIds(
    roleName!,
    churchId,
    req.user?.districts,
    req.user?.traditionalAuthorities,
    req.user?.regions,
    userId
  );

  if (!accessibleChurchIds.includes(parsed.data.churchId)) {
    res.status(403).json({ success: false, message: 'Access denied to this church' });
    return;
  }

  const attendanceDate = new Date(parsed.data.date);
  const dateOnly = new Date(attendanceDate.getFullYear(), attendanceDate.getMonth(), attendanceDate.getDate());
  const existingWhere: any = {
    churchId: parsed.data.churchId,
    serviceType: parsed.data.serviceType,
    date: {
      gte: dateOnly,
      lt: new Date(dateOnly.getTime() + 24 * 60 * 60 * 1000),
    },
  };
  if (parsed.data.eventId) existingWhere.eventId = parsed.data.eventId;

  const existing = await (prisma.attendance as any).findFirst({ where: existingWhere });
  if (existing) {
    const updated = await (prisma.attendance as any).update({
      where: { id: existing.id },
      data: {
        digitalCheckInEnabled: true,
        qrStatus: 'active',
        qrToken: existing.qrToken || generateQrToken(),
        qrActiveFrom: parseOptionalDate(parsed.data.qrActiveFrom) || existing.qrActiveFrom || new Date(),
        qrActiveUntil: parseOptionalDate(parsed.data.qrActiveUntil),
      },
      include: { church: { select: { id: true, name: true } }, _count: { select: { visitors: true, participants: true } } },
    });
    res.json({ success: true, data: updated, updated: true });
    return;
  }

  const record = await (prisma.attendance as any).create({
    data: {
      churchId: parsed.data.churchId,
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
      qrActiveFrom: parseOptionalDate(parsed.data.qrActiveFrom) || new Date(),
      qrActiveUntil: parseOptionalDate(parsed.data.qrActiveUntil),
    },
    include: { church: { select: { id: true, name: true } }, _count: { select: { visitors: true, participants: true } } },
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
    include: { church: true, _count: { select: { participants: true } } },
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
  if (!accessibleChurchIds.includes(targetChurchId)) {
    res.status(403).json({ success: false, message: 'Cannot move attendance to a church outside your scope' });
    return;
  }

  const summaryLocked = !!record.qrToken || record.digitalCheckInEnabled || (record as any)._count?.participants > 0;

  if (summaryLocked) {
    const updated = await prisma.attendance.update({
      where: { id },
      data: {
        churchId: targetChurchId,
        date: new Date(data.date),
        serviceType: data.serviceType,
        eventId,
      },
      select: attendanceListSelect,
    } as any);
    res.json({ success: true, data: updated });
    return;
  }

  const newVisitorsCount = visitors && visitors.length > 0 ? visitors.length : data.newVisitors;

  const updated = await prisma.$transaction(async (tx) => {
    const attendance = await tx.attendance.update({
      where: { id },
      data: { ...data, newVisitors: newVisitorsCount, date: new Date(data.date), churchId: targetChurchId, eventId },
    });
    if (visitors !== undefined) {
      await tx.attendanceVisitor.deleteMany({ where: { attendanceId: id } });
      if (visitors.length > 0) {
        await tx.attendanceVisitor.createMany({
          data: visitors.map(v => ({ ...v, attendanceId: id })),
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
    prisma.attendanceVisitor.findMany({
      where: { attendanceId: id },
      orderBy: { createdAt: 'asc' },
      skip,
      take: limit,
    }),
    prisma.attendanceVisitor.count({ where: { attendanceId: id } }),
  ]);

  res.json({ success: true, data: visitors, total, hasMore: skip + visitors.length < total, page, limit });
}

export async function addAttendanceVisitor(req: Request, res: Response): Promise<void> {
  const attendanceId = String(req.params.id);
  const parsed = visitorSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }
  const visitor = await prisma.attendanceVisitor.create({
    data: { ...parsed.data, attendanceId },
  });
  // Keep newVisitors count in sync
  await prisma.attendance.update({
    where: { id: attendanceId },
    data: { newVisitors: { increment: 1 } },
  });
  res.status(201).json({ success: true, data: visitor });
}

export async function deleteAttendanceVisitor(req: Request, res: Response): Promise<void> {
  const attendanceId = String(req.params.id);
  const visitorId = String(req.params.visitorId);
  await prisma.attendanceVisitor.delete({ where: { id: visitorId } });
  await prisma.attendance.update({
    where: { id: attendanceId },
    data: { newVisitors: { decrement: 1 } },
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
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const skip = (page - 1) * limit;

  const participantDelegate = (prisma as any).attendanceParticipant;
  const [participants, total] = await Promise.all([
    participantDelegate.findMany({
      where: { attendanceId },
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
          },
        },
      },
      orderBy: { checkedInAt: 'desc' },
      skip,
      take: limit,
    }),
    participantDelegate.count({ where: { attendanceId } }),
  ]);

  res.json({ success: true, data: participants, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
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

  const terms = q.split(/\s+/).filter(Boolean);
  const where: any = {
    churchId: access.record.churchId,
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
  const members = await prisma.user.findMany({
    where: { id: { in: userIds }, churchId: access.record.churchId, status: 'active' },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      memberType: true,
      gender: true,
      dateOfBirth: true,
    },
  });

  if (!members.length) {
    res.status(400).json({ success: false, message: 'No valid members found for this church' });
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
          userId: member.id,
          checkInMethod: 'manual_member',
        },
        include: { user: { select: { firstName: true, lastName: true, email: true, phone: true, memberType: true, gender: true, dateOfBirth: true } } },
      }));
      incrementData = mergeAttendanceIncrement(
        incrementData,
        attendanceIncrementData(member.gender, ageBucketFromAge(getAge(member.dateOfBirth)))
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

  const participant = await prisma.$transaction(async (tx) => {
    const created = await (tx as any).attendanceParticipant.create({
      data: {
        attendanceId,
        guestName: data.guestName.trim(),
        guestEmail: data.guestEmail?.trim() || null,
        guestPhone: data.guestPhone?.trim() || null,
        guestGender: data.guestGender?.trim() || null,
        guestAgeBracket: data.guestAgeBracket?.trim() || null,
        guestFirstTime: data.guestFirstTime ?? false,
        invitedBy: data.invitedBy?.trim() || null,
        checkInMethod: 'manual_visitor',
      },
    });
    await (tx.attendance as any).update({
      where: { id: attendanceId },
      data: attendanceIncrementData(data.guestGender, ageBucketFromBracket(data.guestAgeBracket), true),
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
  if (parsed.data.qrActiveFrom !== undefined) data.qrActiveFrom = parseOptionalDate(parsed.data.qrActiveFrom);
  if (parsed.data.qrActiveUntil !== undefined) data.qrActiveUntil = parseOptionalDate(parsed.data.qrActiveUntil);
  if (!access.record.qrToken) data.qrToken = generateQrToken();

  const updated = await (prisma.attendance as any).update({
    where: { id: attendanceId },
    data,
    include: { church: { select: { id: true, name: true } }, _count: { select: { visitors: true, participants: true } } },
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
    include: { church: { select: { id: true, name: true } }, _count: { select: { visitors: true, participants: true } } },
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
    include: { church: { select: { id: true, name: true } }, _count: { select: { visitors: true, participants: true } } },
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
    include: { church: { select: { id: true, name: true } }, _count: { select: { visitors: true, participants: true } } },
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
  if (!user || user.churchId !== attendance.churchId) {
    res.status(403).json({ success: false, message: 'This check-in is only for members of this church' });
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
        userId,
        checkInMethod: 'qr_member',
      },
      include: { user: { select: { firstName: true, lastName: true, email: true, phone: true, memberType: true, gender: true, dateOfBirth: true } } },
    });
    await (tx.attendance as any).update({
      where: { id: attendance.id },
      data: attendanceIncrementData(user.gender, ageBucketFromAge(getAge(user.dateOfBirth))),
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

  const participant = await prisma.$transaction(async (tx) => {
    const created = await (tx as any).attendanceParticipant.create({
      data: {
        attendanceId: attendance.id,
        guestName: data.guestName.trim(),
        guestEmail: data.guestEmail?.trim() || null,
        guestPhone: data.guestPhone?.trim() || null,
        guestGender: data.guestGender?.trim() || null,
        guestAgeBracket: data.guestAgeBracket?.trim() || null,
        guestFirstTime: data.guestFirstTime ?? false,
        invitedBy: data.invitedBy?.trim() || null,
        checkInMethod: 'qr_guest',
      },
    });
    await (tx.attendance as any).update({
      where: { id: attendance.id },
      data: attendanceIncrementData(data.guestGender, ageBucketFromBracket(data.guestAgeBracket), true),
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
    },
  });

  if (!member || member.status !== 'active') {
    res.status(404).json({ success: false, message: 'Member QR not found or inactive' });
    return;
  }
  if (member.churchId !== attendance.churchId) {
    res.status(403).json({ success: false, message: 'This member belongs to a different church' });
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
        userId: member.id,
        checkInMethod: 'admin_scan',
      },
      include: { user: { select: { firstName: true, lastName: true, email: true, phone: true, memberType: true, gender: true, dateOfBirth: true } } },
    });
    await (tx.attendance as any).update({
      where: { id: attendanceId },
      data: attendanceIncrementData(member.gender, ageBucketFromAge(getAge(member.dateOfBirth))),
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

  const participant = await prisma.$transaction(async (tx) => {
    const created = await (tx as any).attendanceParticipant.create({
      data: {
        attendanceId,
        guestName: data.guestName.trim(),
        guestEmail: data.guestEmail?.trim() || null,
        guestPhone: data.guestPhone?.trim() || null,
        guestGender: data.guestGender?.trim() || null,
        guestAgeBracket: data.guestAgeBracket?.trim() || null,
        guestFirstTime: data.guestFirstTime ?? false,
        invitedBy: data.invitedBy?.trim() || null,
        checkInMethod: 'admin_visitor',
      },
    });
    await (tx.attendance as any).update({
      where: { id: attendanceId },
      data: attendanceIncrementData(data.guestGender, ageBucketFromBracket(data.guestAgeBracket), true),
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
    prisma.attendanceVisitor.findMany({
      where: { attendance: attendanceWhere },
      include: {
        attendance: { select: { date: true, serviceType: true, church: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.attendanceVisitor.count({ where: { attendance: attendanceWhere } }),
  ]);

  res.json({ success: true, data: visitors, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
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
