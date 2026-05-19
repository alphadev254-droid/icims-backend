import { Request, Response } from 'express';
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
  totalAttendees: z.number().int().positive(),
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
    // Export mode: return all records (up to 10,000 safety cap), no pagination wrapper
    const records = await prisma.attendance.findMany({
      where: whereClause,
      select: {
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
        church: { select: { id: true, name: true } },
        _count: { select: { visitors: true } },
      },
      orderBy: { date: 'desc' },
      take: 10000,
    });
    res.json({ success: true, data: records });
    return;
  }

  const [records, total] = await Promise.all([
    prisma.attendance.findMany({
      where: whereClause,
      select: {
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
        church: { select: { id: true, name: true } },
        _count: { select: { visitors: true } },
      },
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

  const record = await prisma.attendance.findUnique({ where: { id }, include: { church: true } });
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
