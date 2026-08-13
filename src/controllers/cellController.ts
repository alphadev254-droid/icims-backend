import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { getAccessibleChurchIds } from '../lib/churchScope';
import { queueEmail } from '../lib/emailQueue';
import { cellMemberAddedTemplate } from '../lib/cellEmailTemplates';

type CellChurchMemberSearchRow = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  memberType: string | null;
  loginEnabled: boolean;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const p = prisma as any;

async function getAccessibleCellIds(userId: string, roleName: string, churchId: string | null | undefined, req: Request): Promise<string[]> {
  const churchIds = await getAccessibleChurchIds(roleName, churchId, req.user?.districts, req.user?.traditionalAuthorities, req.user?.regions, userId);
  const cells = await p.cell.findMany({ where: { churchId: { in: churchIds } }, select: { id: true } });
  return cells.map((c: any) => c.id);
}

function percentage(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.round((numerator / denominator) * 100) : 0;
}

type CellAttendanceRateEntry = {
  meetingIds: Set<string>;
  presentKeys: Set<string>;
  totalRows: number;
};

type CellAttendanceRateInput = {
  presentCount: number;
  activeMemberCount: number;
  meetingCount: number;
};

type VisitorIdentityRow = {
  visitorPhone?: string | null;
  visitorEmail?: string | null;
  visitorName?: string | null;
};

type MemberIdentityRow = {
  phone?: string | null;
  email?: string | null;
};

type CellMemberAttendanceInput = {
  userId: string;
  name: string;
  joinedAt: Date;
};

type CellMeetingInput = {
  id: string;
  date: Date;
};

type CellAttendanceInput = {
  userId: string | null;
  meetingId: string;
  status: string;
  meeting?: { date: Date };
};

type CellMemberAttendanceSummary = {
  userId: string;
  name: string;
  expectedMeetings: number;
  attendedMeetings: number;
  missedMeetings: number;
  excusedMeetings: number;
  attendanceRate: number | null;
  lastAttendedAt: Date | null;
  byMeeting: Map<string, string>;
};

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function buildCellAttendanceRateMap(rows: Array<{ cellId: string | null; meetingId: string; userId: string | null; status: string }>) {
  const map = new Map<string, CellAttendanceRateEntry>();
  for (const row of rows) {
    if (!row.cellId || !row.userId) continue;
    if (!map.has(row.cellId)) {
      map.set(row.cellId, { meetingIds: new Set(), presentKeys: new Set(), totalRows: 0 });
    }
    const entry = map.get(row.cellId)!;
    entry.meetingIds.add(row.meetingId);
    entry.totalRows += 1;
    if (row.status === 'present') entry.presentKeys.add(`${row.meetingId}:${row.userId}`);
  }
  return map;
}

function calculateCellAttendanceRate({ presentCount, activeMemberCount, meetingCount }: CellAttendanceRateInput): number | null {
  if (activeMemberCount <= 0 || meetingCount <= 0) return null;
  return Math.min(100, percentage(presentCount, activeMemberCount * meetingCount));
}

function cellAttendanceRate(entry: CellAttendanceRateEntry | undefined, activeMemberCount: number, meetingCount: number): number | null {
  return calculateCellAttendanceRate({
    presentCount: entry?.presentKeys.size ?? 0,
    activeMemberCount,
    meetingCount,
  });
}

function summarizeCellMemberAttendance(
  members: CellMemberAttendanceInput[],
  meetings: CellMeetingInput[],
  attendanceRows: CellAttendanceInput[],
): Map<string, CellMemberAttendanceSummary> {
  const attendanceByUser = new Map<string, CellAttendanceInput[]>();
  for (const row of attendanceRows) {
    if (!row.userId) continue;
    if (!attendanceByUser.has(row.userId)) attendanceByUser.set(row.userId, []);
    attendanceByUser.get(row.userId)!.push(row);
  }

  const summaries = new Map<string, CellMemberAttendanceSummary>();
  for (const member of members) {
    const memberRows = attendanceByUser.get(member.userId) ?? [];
    const memberRowsByMeeting = new Map(memberRows.map(row => [row.meetingId, row]));
    const expectedFrom = startOfDay(member.joinedAt);
    const expectedMeetings = meetings.filter(meeting => meeting.date >= expectedFrom || memberRowsByMeeting.has(meeting.id));
    const expectedMeetingIds = new Set(expectedMeetings.map(meeting => meeting.id));
    const byMeeting = new Map<string, string>();
    const presentMeetingIds = new Set<string>();
    const excusedMeetingIds = new Set<string>();
    let lastAttendedAt: Date | null = null;

    for (const meeting of expectedMeetings) {
      byMeeting.set(meeting.id, 'absent');
    }

    for (const row of memberRows) {
      if (!expectedMeetingIds.has(row.meetingId)) continue;
      byMeeting.set(row.meetingId, row.status);
      if (row.status === 'present') {
        presentMeetingIds.add(row.meetingId);
        const meetingDate = row.meeting?.date ?? meetings.find(meeting => meeting.id === row.meetingId)?.date;
        if (meetingDate && (!lastAttendedAt || meetingDate > lastAttendedAt)) lastAttendedAt = meetingDate;
      } else if (row.status === 'excused') {
        excusedMeetingIds.add(row.meetingId);
      }
    }

    const expectedCount = expectedMeetings.length;
    const attendedMeetings = presentMeetingIds.size;
    const excusedMeetings = excusedMeetingIds.size;
    const missedMeetings = Math.max(0, expectedCount - attendedMeetings - excusedMeetings);

    summaries.set(member.userId, {
      userId: member.userId,
      name: member.name,
      expectedMeetings: expectedCount,
      attendedMeetings,
      missedMeetings,
      excusedMeetings,
      attendanceRate: expectedCount > 0 ? Math.round((attendedMeetings / expectedCount) * 100) : null,
      lastAttendedAt,
      byMeeting,
    });
  }

  return summaries;
}

function normalizePhone(value?: string | null): string | null {
  const digits = value?.replace(/\D/g, '') ?? '';
  if (!digits) return null;
  return digits.startsWith('265') && digits.length > 9 ? digits.slice(3) : digits;
}

function normalizeEmail(value?: string | null): string | null {
  const email = value?.trim().toLowerCase();
  return email || null;
}

function normalizeName(value?: string | null): string | null {
  const name = value?.trim().replace(/\s+/g, ' ').toLowerCase();
  return name || null;
}

function visitorIdentityKey(visitor: VisitorIdentityRow): string | null {
  const phone = normalizePhone(visitor.visitorPhone);
  if (phone) return `phone:${phone}`;
  const email = normalizeEmail(visitor.visitorEmail);
  if (email) return `email:${email}`;
  const name = normalizeName(visitor.visitorName);
  return name ? `name:${name}` : null;
}

function summarizeGuestConversion(visitors: VisitorIdentityRow[], members: MemberIdentityRow[]) {
  const memberPhones = new Set(members.map(m => normalizePhone(m.phone)).filter(Boolean) as string[]);
  const memberEmails = new Set(members.map(m => normalizeEmail(m.email)).filter(Boolean) as string[]);
  const visitorKeys = new Map<string, VisitorIdentityRow>();
  const convertedKeys = new Set<string>();

  for (const visitor of visitors) {
    const key = visitorIdentityKey(visitor);
    if (!key) continue;
    if (!visitorKeys.has(key)) visitorKeys.set(key, visitor);

    const phone = normalizePhone(visitor.visitorPhone);
    const email = normalizeEmail(visitor.visitorEmail);
    if ((phone && memberPhones.has(phone)) || (email && memberEmails.has(email))) {
      convertedKeys.add(key);
    }
  }

  return {
    convertedCount: convertedKeys.size,
    totalUniqueVisitors: visitorKeys.size,
    conversionRate: visitorKeys.size > 0 ? percentage(convertedKeys.size, visitorKeys.size) : 0,
  };
}

// ─── GET /api/cells ───────────────────────────────────────────────────────────

export async function getCells(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId!;
  const roleName = req.user?.role ?? 'member';
  const churchId = req.user?.churchId;

  // Members see only their own cells — typically few, no pagination needed
  if (roleName === 'member') {
    const memberships = await prisma.cellMember.findMany({
      where: { userId, status: { not: 'inactive' } },
      include: {
        cell: {
          include: {
            _count: { select: { members: { where: { status: { not: 'inactive' } } } } },
            members: { where: { isLeader: true, status: { not: 'inactive' } }, include: { user: { select: { firstName: true, lastName: true } } } },
          },
        },
      },
    });
    res.json({ success: true, data: memberships.map(m => ({ ...m.cell, isLeader: m.isLeader, isAssistant: m.isAssistant })) });
    return;
  }

  const {
    churchId: filterChurchId,
    cellId: filterCellId,
    search,
    status: statusFilter,
    startDate,
    endDate,
    page = '1',
    limit = '50',
  } = req.query as Record<string, string>;

  const isExport = req.query.export === 'true';
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = isExport
    ? Math.min(5000, Math.max(1, parseInt(limit) || 5000))
    : Math.min(200, Math.max(1, parseInt(limit)));
  const skip = (pageNum - 1) * limitNum;

  const churchIds = await getAccessibleChurchIds(roleName, churchId, req.user?.districts, req.user?.traditionalAuthorities, req.user?.regions, userId);
  if (filterChurchId && !churchIds.includes(filterChurchId)) {
    res.json({ success: true, data: [], pagination: { page: pageNum, limit: limitNum, total: 0, totalPages: 0 } });
    return;
  }
  const scopedChurchId = filterChurchId || undefined;

  // Optionally scope to a single cell within accessible scope
  const dateFilter: any = {};
  if (startDate) dateFilter.gte = new Date(startDate);
  if (endDate) { const e = new Date(endDate); e.setHours(23, 59, 59, 999); dateFilter.lte = e; }
  const hasDates = Object.keys(dateFilter).length > 0;

  const where: any = {
    churchId: scopedChurchId ?? { in: churchIds },
    ...(filterCellId && { id: filterCellId }),
    ...(statusFilter && { status: statusFilter }),
    ...(search && {
      OR: [
        { name: { contains: search } },
        { zone: { contains: search } },
      ],
    }),
  };

  // Round 1: count + page cells only
  const [total, cells] = await Promise.all([
    prisma.cell.count({ where }),
    prisma.cell.findMany({
      where,
      include: {
        _count: { select: { members: { where: { status: { not: 'inactive' } } }, meetings: true } },
        members: {
          where: { isLeader: true, status: { not: 'inactive' } },
          include: { user: { select: { id: true, firstName: true, lastName: true } } },
        },
        church: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limitNum,
    }),
  ]);

  const cellIds = cells.map(c => c.id);

  // Round 2: all enrichment in parallel, scoped to page cell IDs (and optional date range)
  const [lastMeetingsRaw, attendanceRowsScoped, visitorRowsPerCell, offeringStatsRaw] = await Promise.all([
    prisma.cellMeeting.groupBy({
      by: ['cellId'],
      where: { cellId: { in: cellIds }, ...(hasDates && { date: dateFilter }) },
      _max: { date: true },
      _count: { _all: true },
    }),
    prisma.cellAttendance.findMany({
      where: {
        cellId: { in: cellIds },
        isVisitor: false,
        userId: { not: null },
        ...(hasDates && { meeting: { date: dateFilter } }),
      },
      select: { cellId: true, meetingId: true, userId: true, status: true },
    }),
    prisma.cellAttendance.findMany({
      where: { cellId: { in: cellIds }, isVisitor: true },
      select: { cellId: true, visitorPhone: true, visitorEmail: true, visitorName: true },
    }),
    (prisma as any).donationTransaction.groupBy({
      by: ['cellId'],
      where: { cellId: { in: cellIds }, status: 'completed' },
      _sum: { amount: true },
    }),
  ]);

  // Round 3: active member identities for guest conversion matching
  const activeMembersPerCell = await prisma.cellMember.findMany({
    where: { cellId: { in: cellIds }, status: 'active' },
    select: { cellId: true, user: { select: { phone: true, email: true } } },
  });

  // Build lookup maps — O(n) in memory
  const lastMeetingMap = new Map(lastMeetingsRaw.map(m => [m.cellId, m._max?.date ?? null]));

  const attMap = buildCellAttendanceRateMap(attendanceRowsScoped as any);

  const cellVisitorRows = new Map<string, VisitorIdentityRow[]>();
  for (const v of visitorRowsPerCell) {
    if (!cellVisitorRows.has(v.cellId)) cellVisitorRows.set(v.cellId, []);
    cellVisitorRows.get(v.cellId)!.push(v);
  }
  const cellMemberRows = new Map<string, MemberIdentityRow[]>();
  for (const m of activeMembersPerCell) {
    if (!cellMemberRows.has(m.cellId)) cellMemberRows.set(m.cellId, []);
    cellMemberRows.get(m.cellId)!.push({ phone: m.user?.phone, email: m.user?.email });
  }

  const meetingCountMap = new Map(lastMeetingsRaw.map(m => [m.cellId, (m._count as any)?._all ?? 0]));
  const offeringMap = new Map((offeringStatsRaw as any[]).map((o: any) => [o.cellId, o._sum?.amount ?? 0]));

  const enriched = cells.map(c => ({
    ...c,
    lastMeetingDate: lastMeetingMap.get(c.id) ?? null,
    meetingsInPeriod: hasDates ? (meetingCountMap.get(c.id) ?? 0) : (c._count?.meetings ?? 0),
    totalVisitors: cellVisitorRows.get(c.id)?.length ?? 0,
    totalOffering: offeringMap.get(c.id) ?? 0,
    leaderName: (() => {
      const leaders = (c as any).members?.filter((m: any) => m.isLeader);
      return leaders?.map((m: any) => `${m.user?.firstName ?? ''} ${m.user?.lastName ?? ''}`.trim()).join(', ') || '';
    })(),
    attendanceRate: (() => {
      const a = attMap.get(c.id);
      const meetingCount = hasDates ? (meetingCountMap.get(c.id) ?? 0) : (c._count?.meetings ?? 0);
      return cellAttendanceRate(a, c._count?.members ?? 0, meetingCount);
    })(),
    conversionRate: (() => {
      const visitors = cellVisitorRows.get(c.id) ?? [];
      if (visitors.length === 0) return null;
      return summarizeGuestConversion(visitors, cellMemberRows.get(c.id) ?? []).conversionRate;
    })(),
  }));

  res.json({
    success: true,
    data: enriched,
    pagination: { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum) },
  });
}

// ─── GET /api/cells/:id ───────────────────────────────────────────────────────

export async function getCell(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId!;
  const roleName = req.user?.role ?? 'member';
  const cellId = String(req.params.id);

  const cell = await prisma.cell.findUnique({
    where: { id: cellId },
    include: {
      church: { select: { id: true, name: true } },
      // Only load leader + assistant for header display — full list via /members endpoint
      members: {
        select: {
          id: true, userId: true, isLeader: true, isAssistant: true, status: true, joinedAt: true, tags: true,
          user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, avatar: true, memberType: true, loginEnabled: true } },
        },
        where: { status: { not: 'inactive' }, OR: [{ isLeader: true }, { isAssistant: true }] },
        orderBy: [{ isLeader: 'desc' }, { isAssistant: 'desc' }],
      },
      _count: { select: { meetings: true, members: { where: { status: { not: 'inactive' } } } } },
    },
  });

  if (!cell) { res.status(404).json({ success: false, message: 'Cell not found' }); return; }

  // Members can only see cells they belong to — check via separate count (not loaded members)
  if (roleName === 'member') {
    const membership = await prisma.cellMember.findFirst({
      where: { cellId, userId, status: { not: 'inactive' } },
    });
    if (!membership) { res.status(403).json({ success: false, message: 'Access denied' }); return; }
  }

  res.json({ success: true, data: cell });
}

// ─── POST /api/cells ──────────────────────────────────────────────────────────

const createCellSchema = z.object({
  churchId: z.string().min(1),
  name: z.string().min(1, 'Cell name required'),
  zone: z.string().optional(),
  meetingDay: z.string().optional(),
  meetingTime: z.string().optional(),
});

export async function createCell(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId!;
  const roleName = req.user?.role!;
  const churchId = req.user?.churchId;

  const parsed = createCellSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const accessibleChurchIds = await getAccessibleChurchIds(roleName, churchId, req.user?.districts, req.user?.traditionalAuthorities, req.user?.regions, userId);
  if (!accessibleChurchIds.includes(parsed.data.churchId)) { res.status(403).json({ success: false, message: 'Access denied' }); return; }

  // Check cell_management feature and max_cells limit
  const { hasFeature, checkCellLimit } = await import('../lib/packageChecker');
  if (!(await hasFeature(userId, 'cell_management'))) {
    res.status(403).json({ success: false, message: 'Your package does not include Cell Management. Please upgrade.' });
    return;
  }
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { ministryAdminId: true, role: { select: { name: true } } } });
  const ministryAdminId = user?.role?.name === 'ministry_admin' ? userId : user?.ministryAdminId;
  if (ministryAdminId) {
    const limitCheck = await checkCellLimit(ministryAdminId);
    if (!limitCheck.allowed) {
      res.status(403).json({ success: false, message: limitCheck.message || 'Cell limit reached' });
      return;
    }
  }

  const cell = await prisma.cell.create({ data: parsed.data });
  res.status(201).json({ success: true, data: cell });
}

// ─── PUT /api/cells/:id ───────────────────────────────────────────────────────

export async function updateCell(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId!;
  const roleName = req.user?.role!;
  const churchId = req.user?.churchId;
  const cellId = String(req.params.id);

  const cell = await prisma.cell.findUnique({ where: { id: cellId } });
  if (!cell) { res.status(404).json({ success: false, message: 'Cell not found' }); return; }

  const accessibleChurchIds = await getAccessibleChurchIds(roleName, churchId, req.user?.districts, req.user?.traditionalAuthorities, req.user?.regions, userId);
  if (!accessibleChurchIds.includes(cell.churchId)) { res.status(403).json({ success: false, message: 'Access denied' }); return; }

  const schema = z.object({
    name: z.string().optional(),
    zone: z.string().optional(),
    meetingDay: z.string().optional(),
    meetingTime: z.string().optional(),
    status: z.enum(['active', 'inactive']).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const updated = await prisma.cell.update({ where: { id: cellId }, data: parsed.data });
  res.json({ success: true, data: updated });
}

// ─── DELETE /api/cells/:id ────────────────────────────────────────────────────

export async function deleteCell(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId!;
  const roleName = req.user?.role!;
  const churchId = req.user?.churchId;
  const cellId = String(req.params.id);

  const cell = await prisma.cell.findUnique({
    where: { id: cellId },
    include: { church: { select: { name: true } } },
  });
  if (!cell) { res.status(404).json({ success: false, message: 'Cell not found' }); return; }

  const accessibleChurchIds = await getAccessibleChurchIds(roleName, churchId, req.user?.districts, req.user?.traditionalAuthorities, req.user?.regions, userId);
  if (!accessibleChurchIds.includes(cell.churchId)) { res.status(403).json({ success: false, message: 'Access denied' }); return; }

  await prisma.cell.delete({ where: { id: cellId } });
  res.json({ success: true, message: 'Cell deleted' });
}

// ─── POST /api/cells/:id/members ─────────────────────────────────────────────

const addMemberSchema = z.object({
  userId: z.string().min(1),
  isLeader: z.boolean().optional().default(false),
  isAssistant: z.boolean().optional().default(false),
  status: z.enum(['active', 'inactive', 'new_convert']).optional().default('active'),
  tags: z.array(z.string()).optional(),
});

export async function addCellMember(req: Request, res: Response): Promise<void> {
  const cellId = String(req.params.id);
  const userId = req.user?.userId!;
  const roleName = req.user?.role!;
  const churchId = req.user?.churchId;

  const cell = await prisma.cell.findUnique({ where: { id: cellId } });
  if (!cell) { res.status(404).json({ success: false, message: 'Cell not found' }); return; }

  const accessibleChurchIds = await getAccessibleChurchIds(roleName, churchId, req.user?.districts, req.user?.traditionalAuthorities, req.user?.regions, userId);
  if (!accessibleChurchIds.includes(cell.churchId)) { res.status(403).json({ success: false, message: 'Access denied' }); return; }

  const parsed = addMemberSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  // Enforce one leader per cell
  if (parsed.data.isLeader) {
    const existingLeader = await prisma.cellMember.findFirst({ where: { cellId, isLeader: true } });
    if (existingLeader) { res.status(400).json({ success: false, message: 'Cell already has a leader. Remove the current leader first.' }); return; }
  }

  // Enforce one assistant per cell
  if (parsed.data.isAssistant) {
    const existingAssistant = await prisma.cellMember.findFirst({ where: { cellId, isAssistant: true } });
    if (existingAssistant) { res.status(400).json({ success: false, message: 'Cell already has an assistant leader. Remove the current assistant first.' }); return; }
  }

  const member = await prisma.cellMember.upsert({
    where: { cellId_userId: { cellId, userId: parsed.data.userId } },
    create: { cellId, ...parsed.data, tags: parsed.data.tags ? JSON.stringify(parsed.data.tags) : undefined },
    update: {
      // Reactivate if previously soft-deleted
      status: parsed.data.status ?? 'active',
      isLeader: parsed.data.isLeader ?? false,
      isAssistant: parsed.data.isAssistant ?? false,
      tags: parsed.data.tags ? JSON.stringify(parsed.data.tags) : undefined,
      leftAt: null,
      joinedAt: new Date(),
    },
    include: { user: { select: { id: true, firstName: true, lastName: true, email: true, loginEnabled: true } } },
  });

  const adminUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { firstName: true, lastName: true },
  });

  if (member.user?.email && member.user.loginEnabled !== false) {
    queueEmail(
      member.user.email,
      `Added to ${cell.name}`,
      cellMemberAddedTemplate({
        firstName: member.user.firstName,
        cellName: cell.name,
        churchName: (cell as any).church?.name || 'your church',
        addedBy: adminUser ? `${adminUser.firstName} ${adminUser.lastName}`.trim() : 'Your church administrator',
        isLeader: member.isLeader,
        isAssistant: member.isAssistant,
      }),
      'notification'
    ).catch(err => console.error('Failed to queue cell member assignment email:', err));
  }

  res.status(201).json({ success: true, data: member });
}

// ─── PUT /api/cells/:id/members/:memberId ─────────────────────────────────────

export async function updateCellMember(req: Request, res: Response): Promise<void> {
  const cellId = String(req.params.id);
  const memberId = String(req.params.memberId);

  const schema = z.object({
    isLeader: z.boolean().optional(),
    isAssistant: z.boolean().optional(),
    status: z.enum(['active', 'inactive', 'new_convert']).optional(),
    tags: z.array(z.string()).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  // Enforce uniqueness
  if (parsed.data.isLeader) {
    const existingLeader = await prisma.cellMember.findFirst({ where: { cellId, isLeader: true, id: { not: memberId } } });
    if (existingLeader) { res.status(400).json({ success: false, message: 'Cell already has a leader.' }); return; }
  }
  if (parsed.data.isAssistant) {
    const existingAssistant = await prisma.cellMember.findFirst({ where: { cellId, isAssistant: true, id: { not: memberId } } });
    if (existingAssistant) { res.status(400).json({ success: false, message: 'Cell already has an assistant.' }); return; }
  }

  const updated = await prisma.cellMember.update({
    where: { id: memberId },
    data: { ...parsed.data, tags: parsed.data.tags ? JSON.stringify(parsed.data.tags) : undefined },
    include: { user: { select: { id: true, firstName: true, lastName: true } } },
  });
  res.json({ success: true, data: updated });
}

// ─── DELETE /api/cells/:id/members/:memberId ──────────────────────────────────

export async function removeCellMember(req: Request, res: Response): Promise<void> {
  const memberId = String(req.params.memberId);
  // Soft delete — set status inactive and record leftAt
  await prisma.cellMember.update({
    where: { id: memberId },
    data: { status: 'inactive', leftAt: new Date(), isLeader: false, isAssistant: false },
  });
  res.json({ success: true, message: 'Member removed from cell' });
}

// ─── GET /api/cells/:id/members (paginated + filtered) ───────────────────────

export async function getCellMembers(req: Request, res: Response): Promise<void> {
  const cellId = String(req.params.id);
  const {
    search, status, role: roleFilter,
    joinedFrom, joinedTo,
    page = '1', limit = '50',
  } = req.query as Record<string, string>;

  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(200, Math.max(1, parseInt(limit)));
  const skip = (pageNum - 1) * limitNum;

  const where: any = {
    cellId,
    status: status || { not: 'inactive' }, // default: exclude soft-deleted
  };
  if (joinedFrom || joinedTo) {
    where.joinedAt = {};
    if (joinedFrom) where.joinedAt.gte = new Date(joinedFrom);
    if (joinedTo) where.joinedAt.lte = new Date(joinedTo);
  }
  if (roleFilter === 'leader') where.isLeader = true;
  if (roleFilter === 'assistant') where.isAssistant = true;
  if (roleFilter === 'member') { where.isLeader = false; where.isAssistant = false; }

  // Search by user name/email — filter in DB via user relation
  const userWhere = search
    ? {
        OR: [
          { firstName: { contains: search } },
          { lastName: { contains: search } },
          { email: { contains: search } },
          { phone: { contains: search } },
        ],
      }
    : undefined;

  const [total, members] = await Promise.all([
    prisma.cellMember.count({
      where: {
        ...where,
        ...(userWhere ? { user: userWhere } : {}),
      },
    }),
    prisma.cellMember.findMany({
      where: {
        ...where,
        ...(userWhere ? { user: userWhere } : {}),
      },
      select: {
        id: true, cellId: true, userId: true,
        joinedAt: true, status: true, tags: true,
        isLeader: true, isAssistant: true,
        user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, avatar: true, memberType: true, loginEnabled: true } },
      },
      orderBy: [{ isLeader: 'desc' }, { isAssistant: 'desc' }, { joinedAt: 'asc' }],
      skip,
      take: limitNum,
    }),
  ]);

  const memberIds = members.map(member => member.userId).filter(Boolean);
  const earliestJoinedAt = members.reduce<Date | null>((earliest, member) => {
    const joinedAt = member.joinedAt;
    if (!earliest || joinedAt < earliest) return joinedAt;
    return earliest;
  }, null);

  const [eligibleMeetings, attendanceRows, givingRows] = memberIds.length > 0
    ? await Promise.all([
        prisma.cellMeeting.findMany({
          where: {
            cellId,
            ...(earliestJoinedAt ? { date: { gte: earliestJoinedAt } } : {}),
          },
          select: { id: true, date: true },
          orderBy: { date: 'asc' },
        }),
        prisma.cellAttendance.findMany({
          where: {
            cellId,
            userId: { in: memberIds },
            isVisitor: false,
          },
          select: { userId: true, meetingId: true, status: true, meeting: { select: { date: true } } },
        }),
        prisma.donationTransaction.groupBy({
          by: ['userId', 'currency'],
          where: {
            cellId,
            userId: { in: memberIds },
            status: 'completed',
            isGuest: false,
            isAnonymous: false,
          },
          _sum: { amount: true },
          _count: { id: true },
        }),
      ])
    : [[], [], []];

  const givingByUser = new Map<string, { total: number; count: number; totalsByCurrency: Array<{ currency: string; total: number; count: number }> }>();
  for (const row of givingRows as any[]) {
    const existing = givingByUser.get(row.userId) ?? { total: 0, count: 0, totalsByCurrency: [] };
    const total = row._sum?.amount ?? 0;
    const count = row._count?.id ?? 0;
    existing.total += total;
    existing.count += count;
    existing.totalsByCurrency.push({ currency: row.currency, total, count });
    givingByUser.set(row.userId, existing);
  }

  const attendanceSummaries = summarizeCellMemberAttendance(
    members.map(member => ({
      userId: member.userId,
      name: `${member.user?.firstName ?? ''} ${member.user?.lastName ?? ''}`.trim(),
      joinedAt: member.joinedAt,
    })),
    eligibleMeetings,
    attendanceRows,
  );

  const enrichedMembers = members.map(member => {
    const summary = attendanceSummaries.get(member.userId);
    const giving = givingByUser.get(member.userId) ?? { total: 0, count: 0, totalsByCurrency: [] };

    return {
      ...member,
      attendanceStats: {
        expectedMeetings: summary?.expectedMeetings ?? 0,
        attendedMeetings: summary?.attendedMeetings ?? 0,
        missedMeetings: summary?.missedMeetings ?? 0,
        excusedMeetings: summary?.excusedMeetings ?? 0,
        attendanceRate: summary?.attendanceRate ?? null,
        lastAttendedAt: summary?.lastAttendedAt ?? null,
      },
      givingStats: giving,
    };
  });

  res.json({
    success: true,
    data: enrichedMembers,
    pagination: { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum) },
  });
}

// ─── GET /api/cells/:id/meetings ─────────────────────────────────────────────

export async function getCellMeetings(req: Request, res: Response): Promise<void> {
  const cellId = String(req.params.id);
  const {
    dateFrom, dateTo,
    page = '1', limit = '50',
  } = req.query as Record<string, string>;

  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(200, Math.max(1, parseInt(limit)));
  const skip = (pageNum - 1) * limitNum;

  const where: any = { cellId };
  if (dateFrom) where.date = { ...where.date, gte: new Date(dateFrom) };
  if (dateTo) where.date = { ...where.date, lte: new Date(dateTo) };

  const [total, meetings] = await Promise.all([
    prisma.cellMeeting.count({ where }),
    prisma.cellMeeting.findMany({
      where,
      select: {
        id: true, cellId: true, date: true, topic: true, notes: true, createdAt: true, updatedAt: true,
        _count: { select: { attendance: true } },
        attendance: { select: { status: true, isVisitor: true } },
      },
      orderBy: { date: 'desc' },
      skip,
      take: limitNum,
    }),
  ]);

  const enriched = meetings.map(m => ({
    id: m.id, cellId: m.cellId, date: m.date, topic: m.topic, notes: m.notes,
    createdAt: m.createdAt, updatedAt: m.updatedAt,
    presentCount: m.attendance.filter(a => a.status === 'present').length,
    visitorCount: m.attendance.filter(a => a.isVisitor).length,
    totalAttendance: m._count.attendance,
  }));

  res.json({
    success: true,
    data: enriched,
    pagination: { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum) },
  });
}

// ─── POST /api/cells/:id/meetings ────────────────────────────────────────────

export async function createCellMeeting(req: Request, res: Response): Promise<void> {
  const cellId = String(req.params.id);
  const schema = z.object({
    date: z.string().min(1),
    topic: z.string().optional(),
    notes: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const meeting = await prisma.cellMeeting.create({
    data: { cellId, ...parsed.data, date: new Date(parsed.data.date) },
  });
  res.status(201).json({ success: true, data: meeting });
}

// ─── GET /api/cells/meetings/:meetingId/attendance ────────────────────────────

export async function getMeetingAttendance(req: Request, res: Response): Promise<void> {
  const meetingId = String(req.params.meetingId);
  const attendance = await prisma.cellAttendance.findMany({
    where: { meetingId },
    include: { user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, memberType: true, loginEnabled: true } } },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ success: true, data: attendance });
}

// ─── POST /api/cells/meetings/:meetingId/attendance ───────────────────────────

const attendanceSchema = z.object({
  records: z.array(z.object({
    userId: z.string().optional(),
    status: z.enum(['present', 'absent', 'excused']).default('present'),
    isVisitor: z.boolean().optional().default(false),
    visitorName: z.string().optional(),
    visitorPhone: z.string().optional(),
    visitorEmail: z.string().email().optional().or(z.literal('')),
    isFirstTime: z.boolean().optional().default(true),
    invitedByUserId: z.string().optional(),
    notes: z.string().optional(),
  }).superRefine((record, ctx) => {
    if (record.isVisitor && !record.visitorPhone?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['visitorPhone'],
        message: 'Guest phone is required',
      });
    }
  })),
});

export async function submitMeetingAttendance(req: Request, res: Response): Promise<void> {
  const meetingId = String(req.params.meetingId);

  const meeting = await prisma.cellMeeting.findUnique({ where: { id: meetingId } });
  if (!meeting) { res.status(404).json({ success: false, message: 'Meeting not found' }); return; }

  const parsed = attendanceSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  // Delete existing and re-insert (idempotent)
  await prisma.cellAttendance.deleteMany({ where: { meetingId } });

  const records = await prisma.cellAttendance.createMany({
    data: parsed.data.records.map(r => ({
      meetingId,
      cellId: meeting.cellId,
      ...r,
    })),
  });

  res.json({ success: true, data: { count: records.count } });
}

// ─── GET /api/cells/:id/stats ─────────────────────────────────────────────────

export async function getCellStats(req: Request, res: Response): Promise<void> {
  const cellId = String(req.params.id);
  const now = new Date();
  const eightWeeksAgo = new Date(now); eightWeeksAgo.setDate(eightWeeksAgo.getDate() - 56);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

  // ── Parallel: basic counts + last 5 meeting IDs + member growth counts ───
  const [
    totalMembers,
    allMeetings,
    totalVisitors,
    newThisMonth,
    leftThisMonth,
    newLastMonth,
    last5Meetings,
    recentMeetings,
    // Single attendance fetch — used for rate, top attendees, most absent, consecutive absences
    allMemberAttendance,
    // Members with DOB + phone for age dist + consecutive absences
    activeMembers,
  ] = await Promise.all([
    prisma.cellMember.count({ where: { cellId, status: 'active' } }),
    prisma.cellMeeting.findMany({ where: { cellId }, select: { id: true, date: true } }),
    prisma.cellAttendance.count({ where: { cellId, isVisitor: true } }),
    prisma.cellMember.count({ where: { cellId, joinedAt: { gte: startOfMonth } } }),
    prisma.cellMember.count({ where: { cellId, status: 'inactive', leftAt: { gte: startOfMonth } } }),
    prisma.cellMember.count({ where: { cellId, joinedAt: { gte: startOfLastMonth, lte: endOfLastMonth } } }),
    prisma.cellMeeting.findMany({
      where: { cellId },
      orderBy: { date: 'desc' },
      take: 5,
      select: { id: true },
    }),
    prisma.cellMeeting.findMany({
      where: { cellId, date: { gte: eightWeeksAgo } },
      select: {
        id: true, date: true, topic: true,
        attendance: { select: { status: true, isVisitor: true } },
      },
      orderBy: { date: 'asc' },
    }),
    // One query for all member attendance — reused for rate, top, absent, consecutive
    prisma.cellAttendance.findMany({
      where: { cellId, isVisitor: false, userId: { not: null } },
      select: {
        userId: true,
        meetingId: true,
        status: true,
        user: { select: { firstName: true, lastName: true } },
      },
    }),
    prisma.cellMember.findMany({
      where: { cellId, status: 'active' },
      select: {
        userId: true,
        joinedAt: true,
        user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, dateOfBirth: true, memberType: true, loginEnabled: true } },
      },
    }),
  ]);

  const totalMeetings = allMeetings.length;
  const netGrowth = newThisMonth - leftThisMonth;

  // ── Attendance trend ──────────────────────────────────────────────────────
  const attendanceTrend = recentMeetings.map(m => ({
    date: m.date.toISOString().split('T')[0],
    topic: m.topic ?? '',
    present: m.attendance.filter(a => !a.isVisitor && a.status === 'present').length,
    absent: m.attendance.filter(a => !a.isVisitor && a.status === 'absent').length,
    excused: m.attendance.filter(a => !a.isVisitor && a.status === 'excused').length,
    visitors: m.attendance.filter(a => a.isVisitor).length,
  }));

  // ── Overall attendance rate + per-member stats (single pass) ─────────────
  const memberAttendanceSummaries = summarizeCellMemberAttendance(
    activeMembers.map(m => ({
      userId: m.userId,
      name: `${m.user?.firstName ?? ''} ${m.user?.lastName ?? ''}`.trim(),
      joinedAt: m.joinedAt,
    })),
    allMeetings,
    allMemberAttendance,
  );

  const totalPresent = Array.from(memberAttendanceSummaries.values()).reduce((s, m) => s + m.attendedMeetings, 0);
  const totalExpectedMeetings = Array.from(memberAttendanceSummaries.values()).reduce((s, m) => s + m.expectedMeetings, 0);
  const attendanceRate = percentage(totalPresent, totalExpectedMeetings);

  // ── Consecutive absences — no N+1, use byMeeting map ─────────────────────
  const last5Ids = last5Meetings.map(m => m.id);
  const consecutiveAbsences: { userId: string; name: string; phone: string | null; missedCount: number }[] = [];

  if (last5Ids.length >= 3) {
    for (const m of activeMembers) {
      const entry = memberAttendanceSummaries.get(m.userId);
      let streak = 0;
      for (const mid of last5Ids) {
        const status = entry?.byMeeting.get(mid);
        if (!status) continue;
        if (status === 'absent') streak++;
        else break;
      }
      if (streak >= 3) {
        consecutiveAbsences.push({
          userId: m.userId,
          name: `${m.user?.firstName} ${m.user?.lastName}`,
          phone: m.user?.phone ?? null,
          missedCount: streak,
        });
      }
    }
  }

  // ── Top attendees + most absent (from same memberMap) ────────────────────
  const memberStats = Array.from(memberAttendanceSummaries.values()).map(m => ({
    name: m.name,
    present: m.attendedMeetings,
    absent: m.missedMeetings,
    excused: m.excusedMeetings,
    total: m.expectedMeetings,
    attendanceRate: m.attendanceRate ?? 0,
  }));

  const topAttendees = [...memberStats]
    .filter(m => m.total > 0 && m.present > 0)
    .sort((a, b) => b.attendanceRate - a.attendanceRate || b.present - a.present)
    .slice(0, 5);

  const mostAbsent = [...memberStats]
    .filter(m => m.total > 0 && (m.absent + m.excused) > 0)
    .sort((a, b) => (b.absent + b.excused) - (a.absent + a.excused))
    .slice(0, 5);

  // ── Age distribution (from activeMembers already fetched) ─────────────────
  const ageBuckets: Record<string, number> = {
    'Under 18': 0, '18–25': 0, '26–35': 0, '36–45': 0, '46–60': 0, '60+': 0, 'Unknown': 0,
  };
  for (const m of activeMembers) {
    const dob = m.user?.dateOfBirth;
    if (!dob) { ageBuckets['Unknown']++; continue; }
    const age = Math.floor((now.getTime() - new Date(dob).getTime()) / (365.25 * 24 * 60 * 60 * 1000));
    if (age < 18) ageBuckets['Under 18']++;
    else if (age <= 25) ageBuckets['18–25']++;
    else if (age <= 35) ageBuckets['26–35']++;
    else if (age <= 45) ageBuckets['36–45']++;
    else if (age <= 60) ageBuckets['46–60']++;
    else ageBuckets['60+']++;
  }
  const ageDistribution = Object.entries(ageBuckets).map(([range, count]) => ({ range, count }));

  // ── Guest-to-member conversion tracking ──────────────────────────────────
  // A guest "converted" if their phone or email matches an active cell member's user record.

  const visitorIdentityRows = await prisma.cellAttendance.findMany({
    where: { cellId, isVisitor: true },
    select: { visitorPhone: true, visitorEmail: true, visitorName: true },
  });
  const guestConversion = summarizeGuestConversion(
    visitorIdentityRows,
    activeMembers.map(m => ({ phone: m.user?.phone, email: m.user?.email })),
  );
  // Three separate groupBy queries (phone, email, name) — DB does the counting
  const [byPhone, byEmail, byName] = await Promise.all([
    prisma.cellAttendance.groupBy({
      by: ['visitorPhone'],
      where: { cellId, isVisitor: true, visitorPhone: { not: null } },
      _count: { id: true },
      having: { id: { _count: { gte: 2 } } },
      orderBy: { _count: { id: 'desc' } },
      take: 10,
    }),
    prisma.cellAttendance.groupBy({
      by: ['visitorEmail' as any],
      where: { cellId, isVisitor: true, visitorPhone: null, visitorEmail: { not: null } } as any,
      _count: { id: true },
      having: { id: { _count: { gte: 2 } } },
      orderBy: { _count: { id: 'desc' } },
      take: 10,
    }).catch(() => []), // visitorEmail may not exist yet pre-migration
    prisma.cellAttendance.groupBy({
      by: ['visitorName'],
      where: { cellId, isVisitor: true, visitorPhone: null, visitorName: { not: null } },
      _count: { id: true },
      having: { id: { _count: { gte: 2 } } },
      orderBy: { _count: { id: 'desc' } },
      take: 10,
    }),
  ]);

  // Merge results — phone takes priority, then email, then name
  // Fetch one representative record per group to get name/email/phone for display
  const phoneKeys = new Set(byPhone.map((r: any) => r.visitorPhone).filter(Boolean));
  const emailKeys = new Set((byEmail as any[]).map((r: any) => r.visitorEmail).filter(Boolean));

  const repeatVisitorKeys = [
    ...byPhone.map((r: any) => ({ key: r.visitorPhone, field: 'visitorPhone', visits: r._count.id })),
    ...(byEmail as any[]).map((r: any) => ({ key: r.visitorEmail, field: 'visitorEmail', visits: r._count.id })),
    ...(byName as any[]).map((r: any) => ({ key: r.visitorName, field: 'visitorName', visits: r._count.id })),
  ].sort((a, b) => b.visits - a.visits).slice(0, 10);

  // Fetch one representative record per group for display info — single bulk query instead of N+1
  const repeatVisitorSamples = await prisma.cellAttendance.findMany({
    where: {
      cellId,
      isVisitor: true,
      OR: repeatVisitorKeys.map(({ key, field }) => ({ [field]: key })),
    },
    select: { visitorName: true, visitorPhone: true, visitorEmail: true },
    distinct: ['visitorPhone', 'visitorEmail', 'visitorName'],
    take: 20,
  });

  // Build a lookup map: phone → record, name → record
  const sampleByPhone = new Map(repeatVisitorSamples.filter(s => s.visitorPhone).map(s => [s.visitorPhone!, s]));
  const sampleByEmail = new Map(repeatVisitorSamples.filter((s: any) => s.visitorEmail).map((s: any) => [s.visitorEmail!, s]));
  const sampleByName  = new Map(repeatVisitorSamples.filter(s => s.visitorName).map(s => [s.visitorName!, s]));

  const repeatVisitors = repeatVisitorKeys.map(({ key, field, visits }) => {
    const sample = field === 'visitorPhone'
      ? sampleByPhone.get(key)
      : field === 'visitorEmail'
      ? sampleByEmail.get(key)
      : sampleByName.get(key);
    return {
      name: sample?.visitorName ?? '',
      phone: sample?.visitorPhone ?? null,
      email: (sample as any)?.visitorEmail ?? null,
      visits,
    };
  });

  res.json({
    success: true,
    data: {
      totalMembers, totalMeetings, attendanceRate, totalVisitors,
      attendanceTrend, consecutiveAbsences,
      memberGrowth: { newThisMonth, leftThisMonth, netGrowth, newLastMonth },
      ageDistribution, topAttendees, mostAbsent,
      repeatVisitors,
      guestConversion,
    },
  });
}

// ─── GET /api/cells/:id/donations ─────────────────────────────────────────────

export async function getCellDonations(req: Request, res: Response): Promise<void> {
  const cellId = String(req.params.id);
  const {
    search,
    status,
    paymentMethod,
    page = '1',
    limit = '100',
  } = req.query as Record<string, string>;

  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(200, Math.max(1, parseInt(limit)));
  const skip = (pageNum - 1) * limitNum;

  // Build search filter
  const searchFilter = search
    ? {
        OR: [
          { user: { firstName: { contains: search } } },
          { user: { lastName: { contains: search } } },
          { user: { email: { contains: search } } },
          { guestName: { contains: search } },
          { guestEmail: { contains: search } },
          { donorName: { contains: search } },
        ],
      }
    : {};

  const where: any = {
    cellId,
    ...(status && { status }),
    ...(paymentMethod && { paymentMethod }),
    ...searchFilter,
  };

  const [total, donations] = await Promise.all([
    prisma.donationTransaction.count({ where }),
    prisma.donationTransaction.findMany({
      where,
      select: {
        id: true,
        amount: true,
        currency: true,
        status: true,
        paymentMethod: true,
        isAnonymous: true,
        isGuest: true,
        guestName: true,
        guestEmail: true,
        donorName: true,
        donorEmail: true,
        notes: true,
        createdAt: true,
        campaign: { select: { name: true, category: true } },
        user: { select: { firstName: true, lastName: true, email: true, phone: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limitNum,
    }),
  ]);

  // Summary totals by currency (completed only)
  const summaryRaw = await prisma.donationTransaction.groupBy({
    by: ['currency'],
    where: { cellId, status: 'completed' },
    _sum: { amount: true },
    _count: { id: true },
  });
  const summary = summaryRaw.map(s => ({
    currency: s.currency,
    total: s._sum.amount ?? 0,
    count: s._count.id,
  }));

  res.json({
    success: true,
    data: donations,
    pagination: { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum) },
    summary,
  });
}

// ─── GET /api/cells/:id/finance-stats ─────────────────────────────────────────

export async function getCellFinanceStats(req: Request, res: Response): Promise<void> {
  const cellId = String(req.params.id);
  const now = new Date();

  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);

  const totalMembers = await prisma.cellMember.count({ where: { cellId, status: 'active' } });

  // This month vs last month
  const [thisMonthRaw, lastMonthRaw] = await Promise.all([
    prisma.donationTransaction.aggregate({
      where: { cellId, status: 'completed', createdAt: { gte: startOfMonth } },
      _sum: { amount: true }, _count: { id: true },
    }),
    prisma.donationTransaction.aggregate({
      where: { cellId, status: 'completed', createdAt: { gte: startOfLastMonth, lte: endOfLastMonth } },
      _sum: { amount: true }, _count: { id: true },
    }),
  ]);

  const thisMonthTotal = thisMonthRaw._sum.amount ?? 0;
  const lastMonthTotal = lastMonthRaw._sum.amount ?? 0;
  const monthChange = lastMonthTotal > 0
    ? Math.round(((thisMonthTotal - lastMonthTotal) / lastMonthTotal) * 100)
    : null;

  // Giving participation — unique member donors (not guests/anonymous)
  const uniqueDonorCount = await prisma.donationTransaction.findMany({
    where: { cellId, status: 'completed', userId: { not: null }, isGuest: false, isAnonymous: false },
    select: { userId: true },
    distinct: ['userId'],
  }).then(rows => rows.length);

  const givingParticipationRate = totalMembers > 0
    ? Math.round((uniqueDonorCount / totalMembers) * 100)
    : 0;

  // Average giving per contributing member
  const allCompleted = await prisma.donationTransaction.aggregate({
    where: { cellId, status: 'completed' },
    _sum: { amount: true },
  });
  const totalRaised = allCompleted._sum.amount ?? 0;
  const avgGivingPerContributor = uniqueDonorCount > 0
    ? Math.round(totalRaised / uniqueDonorCount)
    : 0;

  // Top contributors — one bulk user fetch instead of N+1
  const topContributorsRaw = await prisma.donationTransaction.groupBy({
    by: ['userId'],
    where: { cellId, status: 'completed', userId: { not: null }, isGuest: false, isAnonymous: false },
    _sum: { amount: true },
    orderBy: { _sum: { amount: 'desc' } },
    take: 5,
  });
  const contributorUserIds = topContributorsRaw.map(t => t.userId!).filter(Boolean);
  const contributorUsers = await prisma.user.findMany({
    where: { id: { in: contributorUserIds } },
    select: { id: true, firstName: true, lastName: true },
  });
  const userNameMap = new Map(contributorUsers.map(u => [u.id, `${u.firstName} ${u.lastName}`]));
  const topContributors = topContributorsRaw.map(t => ({
    name: userNameMap.get(t.userId!) ?? 'Unknown',
    total: t._sum.amount ?? 0,
  }));

  // Giving trend — last 6 months grouped by month
  const allDonations = await prisma.donationTransaction.findMany({
    where: { cellId, status: 'completed', createdAt: { gte: sixMonthsAgo } },
    select: { amount: true, currency: true, createdAt: true },
  });

  const monthMap: Record<string, number> = {};
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    monthMap[key] = 0;
  }
  for (const d of allDonations) {
    const key = `${d.createdAt.getFullYear()}-${String(d.createdAt.getMonth() + 1).padStart(2, '0')}`;
    if (key in monthMap) monthMap[key] += d.amount;
  }
  const givingTrend = Object.entries(monthMap).map(([month, total]) => ({ month, total }));

  // Currency for display (most common)
  const currencyRaw = await prisma.donationTransaction.groupBy({
    by: ['currency'],
    where: { cellId, status: 'completed' },
    _count: { id: true },
    orderBy: { _count: { id: 'desc' } },
    take: 1,
  });
  const currency = currencyRaw[0]?.currency ?? 'MWK';

  res.json({
    success: true,
    data: {
      currency,
      thisMonthTotal,
      lastMonthTotal,
      monthChange,
      totalRaised,
      uniqueDonorCount: uniqueDonorCount,
      givingParticipationRate,
      avgGivingPerContributor,
      topContributors,
      givingTrend,
    },
  });
}

// ─── GET /api/cells/overview-stats ────────────────────────────────────────────

export async function getCellsOverviewStats(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId!;
  const roleName = req.user?.role ?? 'member';
  const churchId = req.user?.churchId;

  // ── Resolve accessible cell IDs ───────────────────────────────────────────
  let cellIds: string[];
  if (roleName === 'member') {
    const memberships = await prisma.cellMember.findMany({
      where: { userId, status: { not: 'inactive' } },
      select: { cellId: true },
    });
    cellIds = memberships.map(m => m.cellId);
  } else {
    const churchIds = await getAccessibleChurchIds(roleName, churchId, req.user?.districts, req.user?.traditionalAuthorities, req.user?.regions, userId);
    const cells = await prisma.cell.findMany({ where: { churchId: { in: churchIds } }, select: { id: true, name: true } });
    cellIds = cells.map(c => c.id);
  }

  if (cellIds.length === 0) {
    res.json({ success: true, data: { totalCells: 0, activeCells: 0, totalMembers: 0, totalMeetings: 0, totalVisitors: 0, attendanceRate: 0, recentMeetingsCount: 0, topByMembers: [], topByMeetings: [], topByVisitors: [], topByGiving: [], topByAttendanceRate: [] } });
    return;
  }

  const now = new Date();
  const thirtyDaysAgo = new Date(now); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  // ── All parallel — no sequential queries ─────────────────────────────────
  const [
    totalCells,
    activeCells,
    totalMembers,
    totalMeetings,
    totalVisitors,
    attendanceRows,
    visitorIdentityRows,
    activeMemberIdentityRows,
    recentMeetingsCount,
    // Per-cell member counts
    memberCounts,
    // Per-cell meeting counts
    meetingCounts,
    allMeetingsForRate,
    // Per-cell visitor counts
    visitorCounts,
    // Per-cell giving totals
    givingPerCell,
    // Cell names for display
    cellNames,
  ] = await Promise.all([
    prisma.cell.count({ where: { id: { in: cellIds } } }),
    prisma.cell.count({ where: { id: { in: cellIds }, status: 'active' } }),
    prisma.cellMember.count({ where: { cellId: { in: cellIds }, status: 'active' } }),
    prisma.cellMeeting.count({ where: { cellId: { in: cellIds } } }),
    prisma.cellAttendance.count({ where: { cellId: { in: cellIds }, isVisitor: true } }),
    prisma.cellAttendance.findMany({
      where: { cellId: { in: cellIds }, isVisitor: false, userId: { not: null } },
      select: { cellId: true, meetingId: true, userId: true, status: true },
    }),
    prisma.cellAttendance.findMany({
      where: { cellId: { in: cellIds }, isVisitor: true },
      select: { visitorPhone: true, visitorEmail: true, visitorName: true },
    }),
    prisma.cellMember.findMany({
      where: { cellId: { in: cellIds }, status: 'active' },
      select: { cellId: true, userId: true, joinedAt: true, user: { select: { firstName: true, lastName: true, phone: true, email: true } } },
    }),
    prisma.cellMeeting.count({ where: { cellId: { in: cellIds }, date: { gte: thirtyDaysAgo } } }),
    prisma.cellMember.groupBy({
      by: ['cellId'],
      where: { cellId: { in: cellIds }, status: 'active' },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 5,
    }),
    prisma.cellMeeting.groupBy({
      by: ['cellId'],
      where: { cellId: { in: cellIds } },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 5,
    }),
    prisma.cellMeeting.findMany({
      where: { cellId: { in: cellIds } },
      select: { id: true, cellId: true, date: true },
    }),
    prisma.cellAttendance.groupBy({
      by: ['cellId'],
      where: { cellId: { in: cellIds }, isVisitor: true },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 5,
    }),
    prisma.donationTransaction.groupBy({
      by: ['cellId'],
      where: { cellId: { in: cellIds }, status: 'completed' },
      _sum: { amount: true },
      orderBy: { _sum: { amount: 'desc' } },
      take: 5,
    }),
    prisma.cell.findMany({
      where: { id: { in: cellIds } },
      select: { id: true, name: true, zone: true },
    }),
  ]);

  // ── Build name lookup ─────────────────────────────────────────────────────
  const nameMap = new Map(cellNames.map(c => [c.id, { name: c.name, zone: c.zone }]));
  const label = (cellId: string) => {
    const c = nameMap.get(cellId);
    return c ? (c.zone ? `${c.name} (${c.zone})` : c.name) : cellId;
  };

  // ── Overall attendance rate ───────────────────────────────────────────────
  const meetingsByCell = new Map<string, Array<{ id: string; date: Date }>>();
  for (const meeting of allMeetingsForRate) {
    if (!meetingsByCell.has(meeting.cellId)) meetingsByCell.set(meeting.cellId, []);
    meetingsByCell.get(meeting.cellId)!.push({ id: meeting.id, date: meeting.date });
  }
  const membersByCell = new Map<string, Array<{ userId: string; name: string; joinedAt: Date }>>();
  for (const member of activeMemberIdentityRows) {
    if (!membersByCell.has(member.cellId)) membersByCell.set(member.cellId, []);
    membersByCell.get(member.cellId)!.push({
      userId: member.userId,
      name: `${member.user?.firstName ?? ''} ${member.user?.lastName ?? ''}`.trim(),
      joinedAt: member.joinedAt,
    });
  }
  const attendanceRowsByCell = new Map<string, Array<{ userId: string | null; meetingId: string; status: string }>>();
  for (const row of attendanceRows) {
    if (!row.cellId) continue;
    if (!attendanceRowsByCell.has(row.cellId)) attendanceRowsByCell.set(row.cellId, []);
    attendanceRowsByCell.get(row.cellId)!.push(row);
  }
  const cellAttendanceSummaryMap = new Map<string, { present: number; total: number; rate: number }>();
  let presentTotal = 0;
  let attTotal = 0;
  for (const cellId of cellIds) {
    const summaries = summarizeCellMemberAttendance(
      membersByCell.get(cellId) ?? [],
      meetingsByCell.get(cellId) ?? [],
      attendanceRowsByCell.get(cellId) ?? [],
    );
    const present = Array.from(summaries.values()).reduce((sum, member) => sum + member.attendedMeetings, 0);
    const total = Array.from(summaries.values()).reduce((sum, member) => sum + member.expectedMeetings, 0);
    presentTotal += present;
    attTotal += total;
    cellAttendanceSummaryMap.set(cellId, { present, total, rate: percentage(present, total) });
  }
  const attendanceRate = percentage(presentTotal, attTotal);

  // ── Top by attendance rate (compute per-cell rate from grouped data) ──────
  const topByAttendanceRate = cellIds
    .map((cellId) => {
      const summary = cellAttendanceSummaryMap.get(cellId);
      return {
        id: cellId,
        name: label(cellId),
        attendanceRate: summary?.rate ?? 0,
        present: summary?.present ?? 0,
        total: summary?.total ?? 0,
      };
    })
    .sort((a, b) => b.attendanceRate - a.attendanceRate)
    .slice(0, 5);

  // ── Cumulative conversion rate ───────────────────────────────────────────
  const overviewGuestConversion = summarizeGuestConversion(
    visitorIdentityRows,
    activeMemberIdentityRows.map(m => ({ phone: m.user?.phone, email: m.user?.email })),
  );

  res.json({
    success: true,
    data: {
      totalCells, activeCells, totalMembers, totalMeetings, totalVisitors, attendanceRate, recentMeetingsCount,
      cumulativeConversionRate: overviewGuestConversion.conversionRate,
      topByMembers: memberCounts.map(c => ({ id: c.cellId, name: label(c.cellId), count: c._count.id })),
      topByMeetings: meetingCounts.map(c => ({ id: c.cellId, name: label(c.cellId), count: c._count.id })),
      topByVisitors: visitorCounts.map(c => ({ id: c.cellId, name: label(c.cellId), count: c._count.id })),
      topByGiving: givingPerCell.filter(c => c.cellId).map(c => ({ id: c.cellId!, name: label(c.cellId!), total: c._sum.amount ?? 0 })),
      topByAttendanceRate,
    },
  });
}

// ─── GET /api/cells/visitors — visitor report across all accessible cells ─────

export async function getCellVisitors(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId!;
  const roleName = req.user?.role ?? 'member';
  const churchId = req.user?.churchId;

  const filterCellId = req.query.cellId as string | undefined;
  const filterChurchId = req.query.churchId as string | undefined;
  const startDate = req.query.startDate as string | undefined;
  const endDate = req.query.endDate as string | undefined;
  const isExport = req.query.export === 'true';
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = isExport
    ? Math.min(5000, Math.max(1, parseInt(req.query.limit as string) || 5000))
    : Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
  const skip = (page - 1) * limit;

  // Resolve accessible church IDs
  const accessibleChurchIds = await getAccessibleChurchIds(
    roleName, churchId, req.user?.districts, req.user?.traditionalAuthorities, req.user?.regions, userId,
  );

  if (accessibleChurchIds.length === 0) {
    res.json({ success: true, data: [], pagination: { page, limit, total: 0, totalPages: 0 } });
    return;
  }

  // Narrow by filterChurchId if provided and in scope
  if (filterChurchId && !accessibleChurchIds.includes(filterChurchId)) {
    res.json({ success: true, data: [], pagination: { page, limit, total: 0, totalPages: 0 } });
    return;
  }
  const scopedChurchIds = filterChurchId && accessibleChurchIds.includes(filterChurchId)
    ? [filterChurchId]
    : accessibleChurchIds;

  // Get accessible cell IDs within scoped churches
  const cellsInScope = await prisma.cell.findMany({
    where: {
      churchId: { in: scopedChurchIds },
      ...(filterCellId && { id: filterCellId }),
    },
    select: { id: true },
  });
  const cellIds = cellsInScope.map((c: any) => c.id);

  if (cellIds.length === 0) {
    res.json({ success: true, data: [], pagination: { page, limit, total: 0, totalPages: 0 } });
    return;
  }

  // Build date filter on meeting.date
  const dateFilter: any = {};
  if (startDate) dateFilter.gte = new Date(startDate);
  if (endDate) {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    dateFilter.lte = end;
  }

  const where: any = {
    cellId: { in: cellIds },
    isVisitor: true,
    ...(Object.keys(dateFilter).length > 0 && { meeting: { date: dateFilter } }),
  };

  const [total, visitors] = await Promise.all([
    prisma.cellAttendance.count({ where }),
    prisma.cellAttendance.findMany({
      where,
      select: {
        id: true,
        visitorName: true,
        visitorPhone: true,
        visitorEmail: true,
        isFirstTime: true,
        notes: true,
        createdAt: true,
        meeting: {
          select: {
            date: true,
            topic: true,
            cell: {
              select: {
                name: true,
                zone: true,
                church: { select: { name: true } },
              },
            },
          },
        },
      },
      orderBy: [{ meeting: { date: 'desc' } }],
      skip,
      take: limit,
    }),
  ]);

  res.json({
    success: true,
    data: visitors,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
}

// ─── GET /api/cells/simple — lightweight list for dropdowns ──────────────────

export async function getCellsSimple(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId!;
  const roleName = req.user?.role ?? 'member';
  const churchId = req.user?.churchId;

  let where: any;

  if (roleName === 'member') {
    // Member: only cells they belong to
    const memberships = await prisma.cellMember.findMany({
      where: { userId, status: { not: 'inactive' } },
      select: { cellId: true },
    });
    where = { id: { in: memberships.map(m => m.cellId) }, status: 'active' };
  } else {
    const churchIds = await getAccessibleChurchIds(roleName, churchId, req.user?.districts, req.user?.traditionalAuthorities, req.user?.regions, userId);
    where = { churchId: { in: churchIds }, status: 'active' };
  }

  const cells = await prisma.cell.findMany({
    where,
    select: { id: true, name: true, zone: true },
    orderBy: { name: 'asc' },
  });

  res.json({ success: true, data: cells });
}

// ─── GET /api/cells/:id/church-members ────────────────────────────────────────
// Returns members of the church that owns this cell — for the Add Member dialog

export async function getCellChurchMembers(req: Request, res: Response): Promise<void> {
  const cellId = String(req.params.id);
  const { search = '', page = '1', limit = '100' } = req.query as Record<string, string>;
  const searchTerm = search.trim();

  const cell = await prisma.cell.findUnique({ where: { id: cellId }, select: { churchId: true } });
  if (!cell) { res.status(404).json({ success: false, message: 'Cell not found' }); return; }

  const pageNum = Math.max(1, parseInt(page) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 100));
  const offset = (pageNum - 1) * limitNum;
  if (searchTerm.length > 0 && searchTerm.length < 3) {
    res.json({
      success: true,
      data: [],
      pagination: { total: 0, page: 1, limit: limitNum, pages: 0 },
      message: 'Type at least 3 characters to search members',
    });
    return;
  }

  const memberRole = await prisma.role.findUnique({ where: { name: 'member' }, select: { id: true } });

  if (searchTerm.length === 0) {
    const where: any = {
      churchId: cell.churchId,
      ...(memberRole && { roleId: memberRole.id }),
      status: 'active',
      cellMemberships: { none: { cellId, status: { not: 'inactive' } } },
    };
    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        select: { id: true, firstName: true, lastName: true, email: true, phone: true, memberType: true, loginEnabled: true },
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
        skip: offset,
        take: limitNum,
      }),
    ]);

    res.json({
      success: true,
      data: users,
      pagination: { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum) },
    });
    return;
  }

  const booleanSearch = searchTerm
    .split(/\s+/)
    .map(term => term.replace(/[+\-<>()~*"@]+/g, '').trim())
    .filter(term => term.length >= 3)
    .map(term => `${term}*`)
    .join(' ');

  if (!booleanSearch) {
    res.json({ success: true, data: [], pagination: { total: 0, page: 1, limit: limitNum, pages: 0 } });
    return;
  }

  let users: CellChurchMemberSearchRow[] = [];
  let total = 0;
  try {
    const countRows = await prisma.$queryRawUnsafe<Array<{ total: bigint | number }>>(
      `
        SELECT COUNT(*) AS total
        FROM users u
        WHERE u.churchId = ?
          AND u.status = 'active'
          AND (? IS NULL OR u.roleId = ?)
          AND MATCH(u.firstName, u.lastName, u.email, u.phone) AGAINST (? IN BOOLEAN MODE)
          AND NOT EXISTS (
            SELECT 1
            FROM cell_members cm
            WHERE cm.cellId = ?
              AND cm.userId = u.id
              AND cm.status <> 'inactive'
          )
      `,
      cell.churchId,
      memberRole?.id ?? null,
      memberRole?.id ?? null,
      booleanSearch,
      cellId,
    );
    total = Number(countRows[0]?.total ?? 0);

    users = await prisma.$queryRawUnsafe<CellChurchMemberSearchRow[]>(
      `
        SELECT
          u.id,
          u.firstName,
          u.lastName,
          u.email,
          u.phone,
          u.memberType,
          u.loginEnabled,
          MATCH(u.firstName, u.lastName, u.email, u.phone) AGAINST (? IN BOOLEAN MODE) AS relevance
        FROM users u
        WHERE u.churchId = ?
          AND u.status = 'active'
          AND (? IS NULL OR u.roleId = ?)
          AND MATCH(u.firstName, u.lastName, u.email, u.phone) AGAINST (? IN BOOLEAN MODE)
          AND NOT EXISTS (
            SELECT 1
            FROM cell_members cm
            WHERE cm.cellId = ?
              AND cm.userId = u.id
              AND cm.status <> 'inactive'
          )
        ORDER BY relevance DESC, u.firstName ASC, u.lastName ASC
        LIMIT ?
        OFFSET ?
      `,
      booleanSearch,
      cell.churchId,
      memberRole?.id ?? null,
      memberRole?.id ?? null,
      booleanSearch,
      cellId,
      limitNum,
      offset,
    );
  } catch (error) {
    console.warn('[Cells] Full-text member search failed, falling back to contains search:', error);
    const where: any = {
        churchId: cell.churchId,
        ...(memberRole && { roleId: memberRole.id }),
        status: 'active',
        cellMemberships: { none: { cellId, status: { not: 'inactive' } } },
        OR: [
          { firstName: { contains: searchTerm } },
          { lastName: { contains: searchTerm } },
          { email: { contains: searchTerm } },
          { phone: { contains: searchTerm } },
        ],
    };
    const [fallbackTotal, fallbackUsers] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        select: { id: true, firstName: true, lastName: true, email: true, phone: true, memberType: true, loginEnabled: true },
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
        skip: offset,
        take: limitNum,
      }),
    ]);
    total = fallbackTotal;
    users = fallbackUsers;
  }

  res.json({
    success: true,
    data: users,
    pagination: { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum) },
  });
}
