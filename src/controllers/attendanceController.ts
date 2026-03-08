import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { getAccessibleChurchIds } from '../lib/churchScope';

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
});

export async function getAttendance(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const roleName = req.user?.role ?? 'member';
  
  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  let accessibleChurchIds: string[] = [];

  if (roleName === 'member') {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { churchId: true } });
    if (user?.churchId) accessibleChurchIds = [user.churchId];
  } else if (roleName === 'local_admin') {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { traditionalAuthorities: true } });
    if (user?.traditionalAuthorities) {
      const tas = JSON.parse(user.traditionalAuthorities);
      const churches = await prisma.church.findMany({
        where: { traditionalAuthority: { in: tas } },
        select: { id: true },
      });
      accessibleChurchIds = churches.map(c => c.id);
    }
  } else if (roleName === 'district_overseer') {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { districts: true } });
    if (user?.districts) {
      const districts = JSON.parse(user.districts);
      const churches = await prisma.church.findMany({
        where: { district: { in: districts } },
        select: { id: true },
      });
      accessibleChurchIds = churches.map(c => c.id);
    }
  } else if (roleName === 'regional_leader') {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { regions: true } });
    if (user?.regions) {
      const regions = JSON.parse(user.regions);
      const churches = await prisma.church.findMany({
        where: { region: { in: regions } },
        select: { id: true },
      });
      accessibleChurchIds = churches.map(c => c.id);
    }
  }
  // national_admin sees all attendance (no filter)

  const records = await prisma.attendance.findMany({
    where: accessibleChurchIds.length > 0 ? { churchId: { in: accessibleChurchIds } } : {},
    include: { church: { select: { name: true } } },
    orderBy: { date: 'desc' },
    take: 100,
  });
  
  res.json({ success: true, data: records });
}

export async function createAttendance(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
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

  const { churchId, eventId, ...data } = parsed.data;

  // Verify user has access to this church
  let hasAccess = false;
  if (roleName === 'national_admin') {
    const church = await prisma.church.findUnique({ where: { id: churchId }, select: { nationalAdminId: true } });
    hasAccess = church?.nationalAdminId === userId;
  } else if (roleName === 'local_admin') {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { traditionalAuthorities: true } });
    const church = await prisma.church.findUnique({ where: { id: churchId }, select: { traditionalAuthority: true } });
    if (user?.traditionalAuthorities && church) {
      const tas = JSON.parse(user.traditionalAuthorities);
      hasAccess = tas.includes(church.traditionalAuthority);
    }
  } else if (roleName === 'district_overseer') {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { districts: true } });
    const church = await prisma.church.findUnique({ where: { id: churchId }, select: { district: true } });
    if (user?.districts && church) {
      const districts = JSON.parse(user.districts);
      hasAccess = districts.includes(church.district);
    }
  } else if (roleName === 'regional_leader') {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { regions: true } });
    const church = await prisma.church.findUnique({ where: { id: churchId }, select: { region: true } });
    if (user?.regions && church) {
      const regions = JSON.parse(user.regions);
      hasAccess = regions.includes(church.region);
    }
  }

  if (!hasAccess) {
    res.status(403).json({ success: false, message: 'Access denied to this church' });
    return;
  }

  const attendanceDate = new Date(data.date);
  const dateOnly = new Date(attendanceDate.getFullYear(), attendanceDate.getMonth(), attendanceDate.getDate());

  // For event attendance, check if record exists for same event and date
  if (eventId) {
    const existing = await prisma.attendance.findFirst({
      where: {
        eventId,
        churchId,
        date: {
          gte: dateOnly,
          lt: new Date(dateOnly.getTime() + 24 * 60 * 60 * 1000),
        },
      },
    });

    if (existing) {
      // Update existing record
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
          newVisitors: data.newVisitors,
          notes: data.notes,
        },
      });
      res.json({ success: true, data: updated, updated: true });
      return;
    }
  }

  // Create new record
  const record = await prisma.attendance.create({
    data: {
      ...data,
      churchId,
      eventId,
      date: attendanceDate,
    },
  });
  
  res.status(201).json({ success: true, data: record });
}

export async function updateAttendance(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const roleName = req.user?.role;
  const id = req.params.id as string;

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const { churchId, eventId, ...data } = parsed.data;

  const record = await prisma.attendance.findUnique({ where: { id }, include: { church: true } });
  if (!record) {
    res.status(404).json({ success: false, message: 'Record not found' });
    return;
  }

  // Verify user has access
  let hasAccess = false;
  if (roleName === 'national_admin') {
    hasAccess = record.church.nationalAdminId === userId;
  } else if (roleName === 'local_admin') {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { traditionalAuthorities: true } });
    if (user?.traditionalAuthorities) {
      const tas = JSON.parse(user.traditionalAuthorities);
      hasAccess = tas.includes(record.church.traditionalAuthority);
    }
  } else if (roleName === 'district_overseer') {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { districts: true } });
    if (user?.districts) {
      const districts = JSON.parse(user.districts);
      hasAccess = districts.includes(record.church.district);
    }
  } else if (roleName === 'regional_leader') {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { regions: true } });
    if (user?.regions) {
      const regions = JSON.parse(user.regions);
      hasAccess = regions.includes(record.church.region);
    }
  }

  if (!hasAccess) {
    res.status(403).json({ success: false, message: 'Access denied' });
    return;
  }

  const updated = await prisma.attendance.update({
    where: { id },
    data: {
      ...data,
      date: new Date(data.date),
      churchId,
      eventId,
    },
  });

  res.json({ success: true, data: updated });
}

export async function deleteAttendance(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const roleName = req.user?.role;
  const id = String(req.params.id);

  const record = await prisma.attendance.findUnique({ where: { id }, include: { church: true } });
  if (!record) {
    res.status(404).json({ success: false, message: 'Record not found' });
    return;
  }

  // Verify user has access to delete
  let hasAccess = false;
  if (roleName === 'national_admin') {
    hasAccess = record.church.nationalAdminId === userId;
  } else if (roleName === 'local_admin') {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { traditionalAuthorities: true } });
    if (user?.traditionalAuthorities) {
      const tas = JSON.parse(user.traditionalAuthorities);
      hasAccess = tas.includes(record.church.traditionalAuthority);
    }
  } else if (roleName === 'district_overseer') {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { districts: true } });
    if (user?.districts) {
      const districts = JSON.parse(user.districts);
      hasAccess = districts.includes(record.church.district);
    }
  } else if (roleName === 'regional_leader') {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { regions: true } });
    if (user?.regions) {
      const regions = JSON.parse(user.regions);
      hasAccess = regions.includes(record.church.region);
    }
  }

  if (!hasAccess) {
    res.status(403).json({ success: false, message: 'Access denied' });
    return;
  }

  await prisma.attendance.delete({ where: { id } });
  res.json({ success: true, message: 'Record deleted' });
}
