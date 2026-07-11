import { Request, Response } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { getAccessibleChurchIds } from '../lib/churchScope';

// ─── Protected: Generate a new shared access link ──────────────────────────

export async function generateLink(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const churchId = req.user?.churchId;
  const roleName = req.user?.role ?? 'member';

  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const { churchId: targetChurchId, serviceType, validFrom, expiresAt, usageLimit, accessCode } = req.body;

  // Validate required fields
  if (!targetChurchId) {
    res.status(400).json({ success: false, message: 'churchId is required' });
    return;
  }
  if (!expiresAt) {
    res.status(400).json({ success: false, message: 'expiresAt is required' });
    return;
  }

  // Validate access code if provided
  if (accessCode !== undefined && accessCode !== null && accessCode !== '') {
    const codeStr = String(accessCode);
    if (!/^\d{4}$/.test(codeStr)) {
      res.status(400).json({ success: false, message: 'Access code must be exactly 4 digits' });
      return;
    }
  }

  const expiresDate = new Date(expiresAt);
  if (isNaN(expiresDate.getTime())) {
    res.status(400).json({ success: false, message: 'Invalid expiresAt date' });
    return;
  }

  const validFromDate = validFrom ? new Date(validFrom) : new Date();
  if (isNaN(validFromDate.getTime())) {
    res.status(400).json({ success: false, message: 'Invalid validFrom date' });
    return;
  }

  if (validFromDate >= expiresDate) {
    res.status(400).json({ success: false, message: 'validFrom must be before expiresAt' });
    return;
  }

  // Verify user has access to this church
  const accessibleChurchIds = await getAccessibleChurchIds(
    roleName,
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

  // Hash the access code if provided
  const hashedCode = (accessCode && String(accessCode).trim())
    ? await bcrypt.hash(String(accessCode), 10)
    : null;

  // Generate a unique token (24 hex chars from 12 random bytes)
  const token = crypto.randomBytes(12).toString('hex');

  const link = await prisma.sharedAccessLink.create({
    data: {
      token,
      type: 'attendance',
      churchId: targetChurchId,
      serviceType: serviceType || 'Sunday Service',
      validFrom: validFromDate,
      expiresAt: expiresDate,
      usageLimit: usageLimit ?? null,
      accessCode: hashedCode,
      createdBy: userId,
    },
  });

  // Derive the frontend URL from the request's origin or use a default
  const origin = req.get('origin') || req.get('host') || 'http://localhost:5173';
  const protocol = origin.includes('localhost') ? 'http' : 'https';
  const baseUrl = origin.includes('localhost') ? `${protocol}://${origin}` : `${protocol}://${origin}`;
  const url = `${baseUrl}/attendance/enter/${token}`;

  res.status(201).json({
    success: true,
    data: {
      id: link.id,
      token: link.token,
      url,
      accessCode: accessCode || null,
      hasAccessCode: !!hashedCode,
      validFrom: link.validFrom,
      expiresAt: link.expiresAt,
    },
  });
}



export async function generateAttendanceEntryLink(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const churchId = req.user?.churchId;
  const roleName = req.user?.role ?? 'member';
  const attendanceId = String(req.params.attendanceId);

  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const { validFrom, expiresAt, usageLimit, accessCode } = req.body;
  if (!expiresAt) {
    res.status(400).json({ success: false, message: 'expiresAt is required' });
    return;
  }
  if (accessCode !== undefined && accessCode !== null && accessCode !== '') {
    const codeStr = String(accessCode);
    if (!/^\d{4}$/.test(codeStr)) {
      res.status(400).json({ success: false, message: 'Access code must be exactly 4 digits' });
      return;
    }
  }

  const expiresDate = new Date(expiresAt);
  const validFromDate = validFrom ? new Date(validFrom) : new Date();
  if (isNaN(expiresDate.getTime()) || isNaN(validFromDate.getTime()) || validFromDate >= expiresDate) {
    res.status(400).json({ success: false, message: 'Invalid link dates' });
    return;
  }

  const attendance = await prisma.attendance.findUnique({
    where: { id: attendanceId },
    include: { sharedAccessLink: true, church: { select: { id: true, name: true } } },
  });
  if (!attendance) {
    res.status(404).json({ success: false, message: 'Attendance not found' });
    return;
  }

  const accessibleChurchIds = await getAccessibleChurchIds(
    roleName,
    churchId,
    req.user?.districts,
    req.user?.traditionalAuthorities,
    req.user?.regions,
    userId
  );
  if (!accessibleChurchIds.includes(attendance.churchId)) {
    res.status(403).json({ success: false, message: 'Access denied' });
    return;
  }

  const existing = attendance.sharedAccessLink?.type === 'attendance' ? attendance.sharedAccessLink : null;
  const hashedCode = (accessCode && String(accessCode).trim()) ? await bcrypt.hash(String(accessCode), 10) : null;
  const token = existing?.token || crypto.randomBytes(12).toString('hex');

  const link = await prisma.$transaction(async (tx) => {
    const saved = existing
      ? await tx.sharedAccessLink.update({
          where: { id: existing.id },
          data: {
            validFrom: validFromDate,
            expiresAt: expiresDate,
            usageLimit: usageLimit ?? null,
            ...(accessCode !== undefined ? { accessCode: hashedCode } : {}),
            isActive: true,
          },
        })
      : await tx.sharedAccessLink.create({
          data: {
            token,
            type: 'attendance',
            churchId: attendance.churchId,
            serviceType: attendance.serviceType,
            validFrom: validFromDate,
            expiresAt: expiresDate,
            usageLimit: usageLimit ?? null,
            accessCode: hashedCode,
            createdBy: userId,
          },
        });

    if (!existing) {
      await tx.attendance.update({ where: { id: attendanceId }, data: { sharedAccessLinkId: saved.id } });
    }
    return saved;
  });

  const origin = req.get('origin') || req.get('host') || 'http://localhost:5173';
  const protocol = origin.includes('localhost') || origin.includes('127.0.0.1') ? 'http' : 'https';
  const baseUrl = origin.startsWith('http') ? origin : `${protocol}://${origin}`;

  res.status(existing ? 200 : 201).json({
    success: true,
    data: {
      id: link.id,
      token: link.token,
      url: `${baseUrl}/attendance/enter/${link.token}`,
      accessCode: accessCode || null,
      hasAccessCode: !!link.accessCode,
      validFrom: link.validFrom,
      expiresAt: link.expiresAt,
      attendanceId,
    },
  });
}

export async function generateAttendanceScannerLink(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const churchId = req.user?.churchId;
  const roleName = req.user?.role ?? 'member';
  const attendanceId = String(req.params.attendanceId);

  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const { validFrom, expiresAt, usageLimit, accessCode } = req.body;
  if (!expiresAt) {
    res.status(400).json({ success: false, message: 'expiresAt is required' });
    return;
  }
  if (accessCode !== undefined && accessCode !== null && accessCode !== '') {
    const codeStr = String(accessCode);
    if (!/^\d{4}$/.test(codeStr)) {
      res.status(400).json({ success: false, message: 'Access code must be exactly 4 digits' });
      return;
    }
  }

  const expiresDate = new Date(expiresAt);
  const validFromDate = validFrom ? new Date(validFrom) : new Date();
  if (isNaN(expiresDate.getTime()) || isNaN(validFromDate.getTime()) || validFromDate >= expiresDate) {
    res.status(400).json({ success: false, message: 'Invalid link dates' });
    return;
  }

  const attendance = await prisma.attendance.findUnique({
    where: { id: attendanceId },
    include: { sharedAccessLink: true, church: { select: { id: true, name: true } } },
  });
  if (!attendance) {
    res.status(404).json({ success: false, message: 'Attendance not found' });
    return;
  }

  const accessibleChurchIds = await getAccessibleChurchIds(
    roleName,
    churchId,
    req.user?.districts,
    req.user?.traditionalAuthorities,
    req.user?.regions,
    userId
  );
  if (!accessibleChurchIds.includes(attendance.churchId)) {
    res.status(403).json({ success: false, message: 'Access denied' });
    return;
  }

  const existing = attendance.sharedAccessLink?.type === 'attendance_scanner' ? attendance.sharedAccessLink : null;
  const hashedCode = (accessCode && String(accessCode).trim()) ? await bcrypt.hash(String(accessCode), 10) : null;
  const token = existing?.token || crypto.randomBytes(12).toString('hex');

  const link = await prisma.$transaction(async (tx) => {
    const saved = existing
      ? await tx.sharedAccessLink.update({
          where: { id: existing.id },
          data: {
            validFrom: validFromDate,
            expiresAt: expiresDate,
            usageLimit: usageLimit ?? null,
            ...(accessCode !== undefined ? { accessCode: hashedCode } : {}),
            isActive: true,
          },
        })
      : await tx.sharedAccessLink.create({
          data: {
            token,
            type: 'attendance_scanner',
            churchId: attendance.churchId,
            serviceType: attendance.serviceType,
            validFrom: validFromDate,
            expiresAt: expiresDate,
            usageLimit: usageLimit ?? null,
            accessCode: hashedCode,
            createdBy: userId,
          },
        });

    if (!existing) {
      await tx.attendance.update({ where: { id: attendanceId }, data: { sharedAccessLinkId: saved.id } });
    }
    return saved;
  });

  const origin = req.get('origin') || req.get('host') || 'http://localhost:5173';
  const protocol = origin.includes('localhost') || origin.includes('127.0.0.1') ? 'http' : 'https';
  const baseUrl = origin.startsWith('http') ? origin : `${protocol}://${origin}`;

  res.status(existing ? 200 : 201).json({
    success: true,
    data: {
      id: link.id,
      token: link.token,
      url: `${baseUrl}/attendance/scan/${link.token}`,
      accessCode: accessCode || null,
      hasAccessCode: !!link.accessCode,
      validFrom: link.validFrom,
      expiresAt: link.expiresAt,
      attendanceId,
    },
  });
}

// ─── Protected: List links created by the current user ─────────────────────

export async function getMyLinks(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const links = await prisma.sharedAccessLink.findMany({
    where: { createdBy: userId },
    select: {
      id: true,
      token: true,
      type: true,
      serviceType: true,
      validFrom: true,
      expiresAt: true,
      isActive: true,
      useCount: true,
      usageLimit: true,
      lastUsedAt: true,
      createdAt: true,
      church: {
        select: {
          id: true,
          name: true,
          logoUrl: true,
          ministryAdmin: {
            select: {
              churchProfile: {
                select: {
                  logoUrl: true,
                  primaryColor: true,
                  tagline: true,
                },
              },
            },
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  const origin = req.get('origin');
  const host = req.get('host');
  let baseUrl: string;
  if (origin) {
    baseUrl = origin;
  } else if (host) {
    const protocol = host.includes('localhost') || host.includes('127.0.0.1') ? 'http' : 'https';
    baseUrl = `${protocol}://${host}`;
  } else {
    baseUrl = 'http://localhost:5173';
  }

  const data = links.map(l => ({
    ...l,
    url: `${baseUrl}/attendance/enter/${l.token}`,
  }));

  res.json({ success: true, data });
}

// ─── Protected: Revoke/deactivate a link ───────────────────────────────────

export async function revokeLink(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const id = String(req.params.id);

  const link = await prisma.sharedAccessLink.findUnique({ where: { id } });
  if (!link) {
    res.status(404).json({ success: false, message: 'Link not found' });
    return;
  }

  if (link.createdBy !== userId) {
    res.status(403).json({ success: false, message: 'You can only revoke your own links' });
    return;
  }

  await prisma.sharedAccessLink.update({
    where: { id },
    data: { isActive: false },
  });

  res.json({ success: true, message: 'Link revoked' });
}

// ─── Public: Validate a token and return scope info ────────────────────────

export async function validateLink(req: Request, res: Response): Promise<void> {
  const token = String(req.params.token);

  if (!token) {
    res.status(400).json({ success: false, message: 'Token is required' });
    return;
  }

  const link = await prisma.sharedAccessLink.findUnique({
    where: { token },
    select: {
      id: true,
      type: true,
      serviceType: true,
      validFrom: true,
      expiresAt: true,
      isActive: true,
      useCount: true,
      usageLimit: true,
      accessCode: true,
      church: { select: { id: true, name: true } },
    },
  });

  if (!link) {
    res.status(404).json({ success: false, message: 'Link not found', valid: false });
    return;
  }

  if (!link.isActive) {
    res.status(410).json({ success: false, message: 'Link has been revoked', valid: false });
    return;
  }

  const now = new Date();
  if (now < link.validFrom) {
    res.status(400).json({
      success: false,
      message: `Link is not yet active. It becomes valid at ${link.validFrom.toISOString()}`,
      valid: false,
    });
    return;
  }

  if (now > link.expiresAt) {
    res.status(410).json({ success: false, message: 'Link has expired', valid: false });
    return;
  }

  if (link.usageLimit !== null && link.useCount >= link.usageLimit) {
    res.status(410).json({ success: false, message: 'Link has reached its usage limit', valid: false });
    return;
  }

  const church = link.church as any;

  res.json({
    success: true,
    valid: true,
    data: {
      type: link.type,
      serviceType: link.serviceType,
      church: {
        id: church.id,
        name: church.name,
        logoUrl: church.logoUrl || church.ministryAdmin?.churchProfile?.logoUrl || null,
        primaryColor: church.ministryAdmin?.churchProfile?.primaryColor || '#d89b12',
        tagline: church.ministryAdmin?.churchProfile?.tagline || null,
      },
      hasAccessCode: !!link.accessCode,
    },
  });
}

// ─── Public: Submit attendance via a valid token ───────────────────────────

const attendanceSchema = z.object({
  date: z.string().min(1, 'Date required'),
  maleCount: z.number().int().min(0).default(0),
  femaleCount: z.number().int().min(0).default(0),
  children: z.number().int().min(0).default(0),
  youth: z.number().int().min(0).default(0),
  youngAdults: z.number().int().min(0).default(0),
  adults: z.number().int().min(0).default(0),
  seniors: z.number().int().min(0).default(0),
  newVisitors: z.number().int().min(0).default(0),
  notes: z.string().optional(),
  visitors: z.array(
    z.object({
      name: z.string().min(1, 'Visitor name required'),
      phone: z.string().optional(),
      email: z.string().optional(),
      residentialArea: z.string().optional(),
      gender: z.string().optional(),
      ageBracket: z.string().optional(),
      howHeard: z.string().optional(),
      notes: z.string().optional(),
    })
  ).optional(),
});

export async function submitAttendance(req: Request, res: Response): Promise<void> {
  const token = String(req.params.token);

  if (!token) {
    res.status(400).json({ success: false, message: 'Token is required' });
    return;
  }

  // Validate and increment the link atomically
  const link = await prisma.sharedAccessLink.findUnique({ where: { token } });

  if (!link) {
    res.status(404).json({ success: false, message: 'Link not found' });
    return;
  }

  if (!link.isActive) {
    res.status(410).json({ success: false, message: 'Link has been revoked' });
    return;
  }

  const now = new Date();
  if (now < link.validFrom) {
    res.status(400).json({ success: false, message: 'Link is not yet active' });
    return;
  }

  if (now > link.expiresAt) {
    res.status(410).json({ success: false, message: 'Link has expired' });
    return;
  }

  if (link.usageLimit !== null && link.useCount >= link.usageLimit) {
    res.status(410).json({ success: false, message: 'Link has reached its usage limit' });
    return;
  }

  // Validate request body
  const parsed = attendanceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const { visitors, ...data } = parsed.data;
  const newVisitorsCount = visitors && visitors.length > 0 ? visitors.length : (data.newVisitors || 0);
  const attendanceDate = new Date(data.date);

  // Use a transaction to create attendance + increment useCount
  const result = await prisma.$transaction(async (tx) => {
    // Increment use count
    await tx.sharedAccessLink.update({
      where: { id: link.id },
      data: {
        useCount: { increment: 1 },
        lastUsedAt: now,
      },
    });

    // Create attendance record linked to this shared access link
    const totalAttendees = (data.maleCount || 0) + (data.femaleCount || 0);
    const attendance = await tx.attendance.create({
      data: {
        churchId: link.churchId,
        date: attendanceDate,
        serviceType: link.serviceType || 'Sunday Service',
        totalAttendees,
        maleCount: data.maleCount || 0,
        femaleCount: data.femaleCount || 0,
        children: data.children || 0,
        youth: data.youth || 0,
        youngAdults: data.youngAdults || 0,
        adults: data.adults || 0,
        seniors: data.seniors || 0,
        newVisitors: newVisitorsCount,
        notes: data.notes || null,
        sharedAccessLinkId: link.id,
      },
    });

    // Create visitors if provided
    if (visitors?.length) {
      await tx.attendanceVisitor.createMany({
        data: visitors.map((v: any) => ({ ...v, attendanceId: attendance.id })),
      });
    }

    return attendance;
  });

  res.status(201).json({
    success: true,
    message: 'Attendance recorded successfully',
    data: result,
  });
}

// ─── Public: Get attendance records by link token ──────────────────────────

export async function getAttendanceByLink(req: Request, res: Response): Promise<void> {
  const token = String(req.params.token);

  if (!token) {
    res.status(400).json({ success: false, message: 'Token is required' });
    return;
  }

  const link = await prisma.sharedAccessLink.findUnique({ where: { token } });

  if (!link) {
    res.status(404).json({ success: false, message: 'Link not found' });
    return;
  }

  const records = await prisma.attendance.findMany({
    where: { sharedAccessLinkId: link.id },
    include: {
      _count: { select: { visitors: true } },
    },
    orderBy: { date: 'desc' },
  });

  res.json({ success: true, data: records });
}

// ─── Helper: verify link is active and valid ──────────────────────────────

async function verifyLink(token: string): Promise<{ link: any; error?: { status: number; message: string } }> {
  if (!token) return { link: null, error: { status: 400, message: 'Token is required' } };

  const link = await prisma.sharedAccessLink.findUnique({ where: { token } });
  if (!link) return { link: null, error: { status: 404, message: 'Link not found' } };
  if (!link.isActive) return { link: null, error: { status: 410, message: 'Link has been revoked' } };

  const now = new Date();
  if (now < link.validFrom) return { link: null, error: { status: 400, message: 'Link is not yet active' } };
  if (now > link.expiresAt) return { link: null, error: { status: 410, message: 'Link has expired' } };
  if (link.usageLimit !== null && link.useCount >= link.usageLimit) {
    return { link: null, error: { status: 410, message: 'Link has reached its usage limit' } };
  }

  return { link };
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

function attendanceIncrementData(gender?: string | null, ageBucket?: string | null) {
  const data: any = { totalAttendees: { increment: 1 } };
  const normalizedGender = String(gender || '').toLowerCase();
  if (normalizedGender === 'male') data.maleCount = { increment: 1 };
  if (normalizedGender === 'female') data.femaleCount = { increment: 1 };
  if (ageBucket && ['children', 'youth', 'youngAdults', 'adults', 'seniors'].includes(ageBucket)) data[ageBucket] = { increment: 1 };
  return data;
}

function extractQrToken(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const match = trimmed.match(/\/member-qr\/([^/?#]+)/i) || trimmed.match(/[?&]token=([^&#]+)/i);
  return decodeURIComponent(match?.[1] || trimmed);
}

async function verifyCodeIfNeeded(link: any, code?: string) {
  if (!link.accessCode) return true;
  if (!code) return false;
  return bcrypt.compare(String(code), link.accessCode);
}


const scannerMemberIdsSchema = z.object({
  userIds: z.array(z.string().min(1)).min(1, 'Select at least one member'),
  accessCode: z.string().optional(),
});

async function getScannerAttendanceContext(token: string, accessCode?: string) {
  const { link, error } = await verifyLink(token);
  if (error) return { error };
  if (link.type !== 'attendance_scanner') return { error: { status: 400, message: 'This is not a scanner link' } };
  const codeOk = await verifyCodeIfNeeded(link, accessCode);
  if (!codeOk) return { error: { status: 401, message: 'Access code is required' } };
  const attendance = await prisma.attendance.findFirst({ where: { sharedAccessLinkId: link.id } });
  if (!attendance) return { error: { status: 404, message: 'Attendance record not found' } };
  return { link, attendance };
}
export async function getScannerAttendanceByLink(req: Request, res: Response): Promise<void> {
  const token = String(req.params.token);
  const { link, error } = await verifyLink(token);
  if (error) { res.status(error.status).json({ success: false, message: error.message }); return; }
  if (link.type !== 'attendance_scanner') {
    res.status(400).json({ success: false, message: 'This is not a scanner link' });
    return;
  }
  const attendance = await prisma.attendance.findFirst({
    where: { sharedAccessLinkId: link.id },
    include: { church: { select: { id: true, name: true } }, _count: { select: { participants: true } } },
  });
  if (!attendance) {
    res.status(404).json({ success: false, message: 'Attendance record not found' });
    return;
  }
  res.json({ success: true, data: attendance });
}

export async function searchMembersByScannerLink(req: Request, res: Response): Promise<void> {
  const token = String(req.params.token);
  const q = String(req.query.q || '').trim();
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 50);
  const skip = (page - 1) * limit;
  const accessCode = typeof req.query.accessCode === 'string' ? req.query.accessCode : undefined;

  const context = await getScannerAttendanceContext(token, accessCode);
  if (context.error) { res.status(context.error.status).json({ success: false, message: context.error.message }); return; }
  const attendance = context.attendance;

  if (q.length < 3) {
    res.json({ success: true, data: [], pagination: { page, limit, total: 0, totalPages: 0 } });
    return;
  }

  const terms = q.split(/\s+/).filter(Boolean);
  const where: any = {
    churchId: attendance.churchId,
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
      select: { id: true, firstName: true, lastName: true, email: true, phone: true, memberType: true, gender: true, dateOfBirth: true },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      skip,
      take: limit,
    }),
    prisma.user.count({ where }),
  ]);

  const participantDelegate = (prisma as any).attendanceParticipant;
  const existing = members.length
    ? await participantDelegate.findMany({
        where: { attendanceId: attendance.id, userId: { in: members.map(member => member.id) } },
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

export async function addMembersByScannerLink(req: Request, res: Response): Promise<void> {
  const token = String(req.params.token);
  const parsed = scannerMemberIdsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const context = await getScannerAttendanceContext(token, parsed.data.accessCode);
  if (context.error) { res.status(context.error.status).json({ success: false, message: context.error.message }); return; }
  const { link, attendance } = context;

  const userIds = Array.from(new Set(parsed.data.userIds));
  const members = await prisma.user.findMany({
    where: { id: { in: userIds }, churchId: attendance.churchId, status: 'active' },
    select: { id: true, firstName: true, lastName: true, email: true, phone: true, memberType: true, gender: true, dateOfBirth: true },
  });

  if (!members.length) {
    res.status(400).json({ success: false, message: 'No valid members found for this church' });
    return;
  }

  const participantDelegate = (prisma as any).attendanceParticipant;
  const existing = await participantDelegate.findMany({
    where: { attendanceId: attendance.id, userId: { in: members.map(member => member.id) } },
    select: { userId: true },
  });
  const existingIds = new Set(existing.map((participant: any) => participant.userId));
  const membersToAdd = members.filter(member => !existingIds.has(member.id));

  const created = await prisma.$transaction(async (tx) => {
    const rows = [];
    let incrementData: any = {};

    for (const member of membersToAdd) {
      rows.push(await (tx as any).attendanceParticipant.create({
        data: { attendanceId: attendance.id, userId: member.id, checkInMethod: 'shared_scanner_search' },
        include: { user: { select: { firstName: true, lastName: true, email: true, phone: true, memberType: true, gender: true, dateOfBirth: true } } },
      }));
      const memberIncrement = attendanceIncrementData(member.gender, ageBucketFromAge(getAge(member.dateOfBirth)));
      for (const key of Object.keys(memberIncrement)) {
        incrementData[key] = { increment: (incrementData[key]?.increment || 0) + memberIncrement[key].increment };
      }
    }

    if (rows.length) {
      await (tx.attendance as any).update({ where: { id: attendance.id }, data: incrementData });
      await tx.sharedAccessLink.update({ where: { id: link.id }, data: { useCount: { increment: rows.length }, lastUsedAt: new Date() } });
    }

    return rows;
  });

  res.status(201).json({ success: true, data: created, created: created.length, skipped: userIds.length - created.length });
}
export async function scanMemberByScannerLink(req: Request, res: Response): Promise<void> {
  const token = String(req.params.token);
  const rawToken = typeof req.body?.memberQr === 'string' ? req.body.memberQr : '';
  const memberToken = extractQrToken(rawToken);
  if (!memberToken) {
    res.status(400).json({ success: false, message: 'Member QR token is required' });
    return;
  }

  const { link, error } = await verifyLink(token);
  if (error) { res.status(error.status).json({ success: false, message: error.message }); return; }
  if (link.type !== 'attendance_scanner') {
    res.status(400).json({ success: false, message: 'This is not a scanner link' });
    return;
  }
  const codeOk = await verifyCodeIfNeeded(link, req.body?.accessCode);
  if (!codeOk) {
    res.status(401).json({ success: false, message: 'Access code is required' });
    return;
  }

  const attendance = await prisma.attendance.findFirst({ where: { sharedAccessLinkId: link.id } });
  if (!attendance) {
    res.status(404).json({ success: false, message: 'Attendance record not found' });
    return;
  }

  const member = await prisma.user.findUnique({
    where: { attendanceQrToken: memberToken } as any,
    select: { id: true, churchId: true, firstName: true, lastName: true, email: true, phone: true, memberType: true, gender: true, dateOfBirth: true, status: true },
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
    where: { attendanceId_userId: { attendanceId: attendance.id, userId: member.id } },
    include: { user: { select: { firstName: true, lastName: true, email: true, phone: true, memberType: true, gender: true, dateOfBirth: true } } },
  });
  if (existing) {
    res.json({ success: true, data: existing, alreadyCheckedIn: true });
    return;
  }

  const participant = await prisma.$transaction(async (tx) => {
    const created = await (tx as any).attendanceParticipant.create({
      data: { attendanceId: attendance.id, userId: member.id, checkInMethod: 'shared_scanner' },
      include: { user: { select: { firstName: true, lastName: true, email: true, phone: true, memberType: true, gender: true, dateOfBirth: true } } },
    });
    await (tx.attendance as any).update({
      where: { id: attendance.id },
      data: attendanceIncrementData(member.gender, ageBucketFromAge(getAge(member.dateOfBirth))),
    });
    await tx.sharedAccessLink.update({ where: { id: link.id }, data: { useCount: { increment: 1 }, lastUsedAt: new Date() } });
    return created;
  });

  res.status(201).json({ success: true, data: participant });
}

// ─── Public: Update attendance record via a valid token ───────────────────

export async function updateAttendanceByLink(req: Request, res: Response): Promise<void> {
  const token = String(req.params.token);
  const id = String(req.params.id);

  const { link, error } = await verifyLink(token);
  if (error) { res.status(error.status).json({ success: false, message: error.message }); return; }

  // Ensure the attendance record belongs to this link
  const record = await prisma.attendance.findUnique({ where: { id } });
  if (!record || record.sharedAccessLinkId !== link.id) {
    res.status(404).json({ success: false, message: 'Attendance record not found for this link' });
    return;
  }

  const parsed = attendanceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const { visitors, ...data } = parsed.data;
  const newVisitorsCount = visitors && visitors.length > 0 ? visitors.length : (data.newVisitors || 0);

  const updated = await prisma.$transaction(async (tx) => {
    const attendance = await tx.attendance.update({
      where: { id },
      data: {
        date: new Date(data.date),
        maleCount: data.maleCount || 0,
        femaleCount: data.femaleCount || 0,
        children: data.children || 0,
        youth: data.youth || 0,
        youngAdults: data.youngAdults || 0,
        adults: data.adults || 0,
        seniors: data.seniors || 0,
        newVisitors: newVisitorsCount,
        notes: data.notes || null,
      },
    });
    if (visitors !== undefined) {
      await tx.attendanceVisitor.deleteMany({ where: { attendanceId: id } });
      if (visitors.length > 0) {
        await tx.attendanceVisitor.createMany({
          data: visitors.map((v: any) => ({ ...v, attendanceId: id })),
        });
      }
    }
    return attendance;
  });

  res.json({ success: true, data: updated });
}

// ─── Public: Get visitors for an attendance record via token ──────────────

export async function getVisitorsByLink(req: Request, res: Response): Promise<void> {
  const token = String(req.params.token);
  const id = String(req.params.id);

  const { link, error } = await verifyLink(token);
  if (error) { res.status(error.status).json({ success: false, message: error.message }); return; }

  const record = await prisma.attendance.findUnique({ where: { id } });
  if (!record || record.sharedAccessLinkId !== link.id) {
    res.status(404).json({ success: false, message: 'Attendance record not found for this link' });
    return;
  }

  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const skip = (page - 1) * limit;

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

// ─── Public: Add visitor to an attendance record via token ────────────────

export async function addVisitorByLink(req: Request, res: Response): Promise<void> {
  const token = String(req.params.token);
  const id = String(req.params.id);

  const { link, error } = await verifyLink(token);
  if (error) { res.status(error.status).json({ success: false, message: error.message }); return; }

  const record = await prisma.attendance.findUnique({ where: { id } });
  if (!record || record.sharedAccessLinkId !== link.id) {
    res.status(404).json({ success: false, message: 'Attendance record not found for this link' });
    return;
  }

  const visitorSchema = z.object({
    name: z.string().min(1, 'Name required'),
    phone: z.string().optional(),
    email: z.string().optional(),
    residentialArea: z.string().optional(),
    gender: z.string().optional(),
    ageBracket: z.string().optional(),
    howHeard: z.string().optional(),
    notes: z.string().optional(),
  });

  const parsed = visitorSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const visitor = await prisma.attendanceVisitor.create({
    data: { ...parsed.data, attendanceId: id },
  });

  await prisma.attendance.update({
    where: { id },
    data: { newVisitors: { increment: 1 } },
  });

  res.status(201).json({ success: true, data: visitor });
}

// ─── Public: Delete visitor from an attendance record via token ───────────

export async function deleteVisitorByLink(req: Request, res: Response): Promise<void> {
  const token = String(req.params.token);
  const id = String(req.params.id);
  const visitorId = String(req.params.visitorId);

  const { link, error } = await verifyLink(token);
  if (error) { res.status(error.status).json({ success: false, message: error.message }); return; }

  const record = await prisma.attendance.findUnique({ where: { id } });
  if (!record || record.sharedAccessLinkId !== link.id) {
    res.status(404).json({ success: false, message: 'Attendance record not found for this link' });
    return;
  }

  await prisma.attendanceVisitor.delete({ where: { id: visitorId } });
  await prisma.attendance.update({
    where: { id },
    data: { newVisitors: { decrement: 1 } },
  });

  res.json({ success: true, message: 'Visitor removed' });
}

// ─── Public: Verify a 4-digit access code for a token ────────────────────

export async function verifyLinkCode(req: Request, res: Response): Promise<void> {
  const token = String(req.params.token);
  const { code } = req.body;

  if (!token) {
    res.status(400).json({ success: false, message: 'Token is required' });
    return;
  }

  const link = await prisma.sharedAccessLink.findUnique({ where: { token } });
  if (!link) {
    res.status(404).json({ success: false, message: 'Link not found' });
    return;
  }

  if (!link.accessCode) {
    // No code set — automatically valid
    res.json({ success: true, valid: true });
    return;
  }

  if (!code) {
    res.status(400).json({ success: false, message: 'Access code is required' });
    return;
  }

  const valid = await bcrypt.compare(String(code), link.accessCode);
  if (!valid) {
    res.status(401).json({ success: false, valid: false, message: 'Invalid access code' });
    return;
  }

  res.json({ success: true, valid: true });
}

// ─── Protected: Permanently delete a link ────────────────────────────────

export async function deleteLink(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const id = String(req.params.id);

  const link = await prisma.sharedAccessLink.findUnique({ where: { id } });
  if (!link) {
    res.status(404).json({ success: false, message: 'Link not found' });
    return;
  }

  if (link.createdBy !== userId) {
    res.status(403).json({ success: false, message: 'You can only delete your own links' });
    return;
  }

  await prisma.sharedAccessLink.delete({ where: { id } });

  res.json({ success: true, message: 'Link permanently deleted' });
}

// ─── Protected: Activate a deactivated link ────────────────────────────────

export async function activateLink(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const id = String(req.params.id);

  const link = await prisma.sharedAccessLink.findUnique({ where: { id } });
  if (!link) {
    res.status(404).json({ success: false, message: 'Link not found' });
    return;
  }

  if (link.createdBy !== userId) {
    res.status(403).json({ success: false, message: 'You can only activate your own links' });
    return;
  }

  await prisma.sharedAccessLink.update({
    where: { id },
    data: { isActive: true },
  });

  res.json({ success: true, message: 'Link activated' });
}
