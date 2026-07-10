import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { getAccessibleChurchIds } from '../lib/churchScope';

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
  const scopedChurchId = filterChurchId && churchIds.includes(filterChurchId) ? filterChurchId : undefined;

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
  const [lastMeetingsRaw, attendanceStatsScoped, visitorPhonesPerCell, offeringStatsRaw] = await Promise.all([
    prisma.cellMeeting.groupBy({
      by: ['cellId'],
      where: { cellId: { in: cellIds }, ...(hasDates && { date: dateFilter }) },
      _max: { date: true },
      _count: { _all: true },
    }),
    prisma.cellAttendance.groupBy({
      by: ['cellId', 'status'],
      where: { cellId: { in: cellIds }, isVisitor: false },
      _count: { _all: true },
    }),
    prisma.cellAttendance.findMany({
      where: { cellId: { in: cellIds }, isVisitor: true, visitorPhone: { not: null } },
      select: { cellId: true, visitorPhone: true },
      distinct: ['cellId', 'visitorPhone'],
    }),
    (prisma as any).donationTransaction.groupBy({
      by: ['cellId'],
      where: { cellId: { in: cellIds }, status: 'completed' },
      _sum: { amount: true },
    }),
  ]);

  // Round 3: member phone match (needs visitor phones from round 2)
  const allVisitorPhones = [...new Set(visitorPhonesPerCell.map(v => v.visitorPhone!).filter(Boolean))];
  const matchedMembers = allVisitorPhones.length > 0
    ? await prisma.cellMember.findMany({
        where: { cellId: { in: cellIds }, status: 'active', user: { phone: { in: allVisitorPhones } } },
        select: { cellId: true, user: { select: { phone: true } } },
      })
    : [];

  // Build lookup maps — O(n) in memory
  const lastMeetingMap = new Map(lastMeetingsRaw.map(m => [m.cellId, m._max?.date ?? null]));

  const attMap = new Map<string, { present: number; total: number }>();
  for (const a of attendanceStatsScoped) {
    if (!attMap.has(a.cellId)) attMap.set(a.cellId, { present: 0, total: 0 });
    const entry = attMap.get(a.cellId)!;
    const cnt = (a._count as any)?._all ?? 0;
    entry.total += cnt;
    if (a.status === 'present') entry.present += cnt;
  }

  const cellVisitorPhones = new Map<string, Set<string>>();
  for (const v of visitorPhonesPerCell) {
    if (!cellVisitorPhones.has(v.cellId)) cellVisitorPhones.set(v.cellId, new Set());
    cellVisitorPhones.get(v.cellId)!.add(v.visitorPhone!);
  }
  const cellConvertedPhones = new Map<string, Set<string>>();
  for (const m of matchedMembers) {
    if (!m.user?.phone) continue;
    if (!cellConvertedPhones.has(m.cellId)) cellConvertedPhones.set(m.cellId, new Set());
    cellConvertedPhones.get(m.cellId)!.add(m.user.phone);
  }

  const meetingCountMap = new Map(lastMeetingsRaw.map(m => [m.cellId, (m._count as any)?._all ?? 0]));
  const offeringMap = new Map((offeringStatsRaw as any[]).map((o: any) => [o.cellId, o._sum?.amount ?? 0]));

  const enriched = cells.map(c => ({
    ...c,
    lastMeetingDate: lastMeetingMap.get(c.id) ?? null,
    meetingsInPeriod: hasDates ? (meetingCountMap.get(c.id) ?? 0) : (c._count?.meetings ?? 0),
    totalVisitors: cellVisitorPhones.get(c.id)?.size ?? 0,
    totalOffering: offeringMap.get(c.id) ?? 0,
    leaderName: (() => {
      const leaders = (c as any).members?.filter((m: any) => m.isLeader);
      return leaders?.map((m: any) => `${m.user?.firstName ?? ''} ${m.user?.lastName ?? ''}`.trim()).join(', ') || '';
    })(),
    attendanceRate: (() => {
      const a = attMap.get(c.id);
      return a && a.total > 0 ? Math.round((a.present / a.total) * 100) : null;
    })(),
    conversionRate: (() => {
      const visitors = cellVisitorPhones.get(c.id);
      const converted = cellConvertedPhones.get(c.id);
      if (!visitors || visitors.size === 0) return null;
      const count = converted ? [...converted].filter(p => visitors.has(p)).length : 0;
      return Math.round((count / visitors.size) * 100);
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

  const cell = await prisma.cell.findUnique({ where: { id: cellId } });
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
    include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
  });

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

  res.json({
    success: true,
    data: members,
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
    totalMeetings,
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
    prisma.cellMeeting.count({ where: { cellId } }),
    prisma.cellAttendance.count({ where: { cellId, isVisitor: true } }),
    prisma.cellMember.count({ where: { cellId, joinedAt: { gte: startOfMonth } } }),
    prisma.cellMember.count({ where: { cellId, status: 'inactive' } }), // leftAt filter applied after generate
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
        user: { select: { id: true, firstName: true, lastName: true, phone: true, dateOfBirth: true, memberType: true, loginEnabled: true } },
      },
    }),
  ]);

  const netGrowth = newThisMonth - leftThisMonth;

  // ── Attendance trend ──────────────────────────────────────────────────────
  const attendanceTrend = recentMeetings.map(m => ({
    date: m.date.toISOString().split('T')[0],
    topic: m.topic ?? '',
    present: m.attendance.filter(a => a.status === 'present').length,
    absent: m.attendance.filter(a => !a.isVisitor && a.status === 'absent').length,
    excused: m.attendance.filter(a => a.status === 'excused').length,
    visitors: m.attendance.filter(a => a.isVisitor).length,
  }));

  // ── Overall attendance rate + per-member stats (single pass) ─────────────
  const memberMap = new Map<string, { name: string; present: number; absent: number; excused: number; total: number; byMeeting: Map<string, string> }>();
  for (const a of allMemberAttendance) {
    if (!a.userId) continue;
    if (!memberMap.has(a.userId)) {
      memberMap.set(a.userId, {
        name: `${a.user?.firstName ?? ''} ${a.user?.lastName ?? ''}`.trim(),
        present: 0, absent: 0, excused: 0, total: 0,
        byMeeting: new Map(),
      });
    }
    const entry = memberMap.get(a.userId)!;
    entry.total++;
    entry.byMeeting.set(a.meetingId, a.status);
    if (a.status === 'present') entry.present++;
    else if (a.status === 'absent') entry.absent++;
    else if (a.status === 'excused') entry.excused++;
  }

  const totalPresent = Array.from(memberMap.values()).reduce((s, m) => s + m.present, 0);
  const totalRecords = Array.from(memberMap.values()).reduce((s, m) => s + m.total, 0);
  const attendanceRate = totalRecords > 0 ? Math.round((totalPresent / totalRecords) * 100) : 0;

  // ── Consecutive absences — no N+1, use byMeeting map ─────────────────────
  const last5Ids = last5Meetings.map(m => m.id);
  const consecutiveAbsences: { userId: string; name: string; phone: string | null; missedCount: number }[] = [];

  if (last5Ids.length >= 3) {
    for (const m of activeMembers) {
      const entry = memberMap.get(m.userId);
      let streak = 0;
      for (const mid of last5Ids) {
        const status = entry?.byMeeting.get(mid) ?? 'absent';
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
  const memberStats = Array.from(memberMap.values()).map(m => ({
    name: m.name, present: m.present, absent: m.absent, excused: m.excused, total: m.total,
    attendanceRate: m.total > 0 ? Math.round((m.present / m.total) * 100) : 0,
  }));

  const topAttendees = [...memberStats]
    .filter(m => m.total > 0)
    .sort((a, b) => b.present - a.present || b.attendanceRate - a.attendanceRate)
    .slice(0, 5);

  const mostAbsent = [...memberStats]
    .filter(m => m.total > 0)
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
  // A guest "converted" if their phone or email matches an active cell member's user record
  // Done at DB level: get all visitor phones/emails, then check against member users

  // Get distinct visitor phones and emails for this cell
  const [visitorPhones, visitorEmails] = await Promise.all([
    prisma.cellAttendance.findMany({
      where: { cellId, isVisitor: true, visitorPhone: { not: null } },
      select: { visitorPhone: true },
      distinct: ['visitorPhone'],
    }),
    prisma.cellAttendance.findMany({
      where: { cellId, isVisitor: true, visitorEmail: { not: null } } as any,
      select: { visitorEmail: true } as any,
      distinct: ['visitorEmail' as any],
    }).catch(() => []),
  ]);

  const phones = visitorPhones.map((v: any) => v.visitorPhone).filter(Boolean);
  const emails = (visitorEmails as any[]).map((v: any) => v.visitorEmail).filter(Boolean);

  // Count active members whose phone or email matches a past visitor
  const convertedCount = await prisma.cellMember.count({
    where: {
      cellId,
      status: 'active',
      user: {
        OR: [
          ...(phones.length > 0 ? [{ phone: { in: phones } }] : []),
          ...(emails.length > 0 ? [{ email: { in: emails } }] : []),
        ],
      },
    },
  });

  const totalUniqueVisitors = phones.length + emails.filter(e => !phones.includes(e)).length;
  const conversionRate = totalUniqueVisitors > 0
    ? Math.round((convertedCount / totalUniqueVisitors) * 100)
    : 0;
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
  const phoneKeys = new Set(byPhone.map((r: any) => r.visitorPhone));
  const emailKeys = new Set((byEmail as any[]).map((r: any) => r.visitorEmail));

  const repeatVisitorKeys = [
    ...byPhone.map((r: any) => ({ key: r.visitorPhone, field: 'visitorPhone', visits: r._count.id })),
    ...(byEmail as any[]).filter((r: any) => !phoneKeys.has(r.visitorPhone)).map((r: any) => ({ key: r.visitorEmail, field: 'visitorEmail', visits: r._count.id })),
    ...(byName as any[]).filter((r: any) => !phoneKeys.has(r.visitorPhone) && !emailKeys.has((r as any).visitorEmail)).map((r: any) => ({ key: r.visitorName, field: 'visitorName', visits: r._count.id })),
  ].sort((a, b) => b.visits - a.visits).slice(0, 10);

  // Fetch one representative record per group for display info — single bulk query instead of N+1
  const repeatVisitorSamples = await prisma.cellAttendance.findMany({
    where: {
      cellId,
      isVisitor: true,
      OR: repeatVisitorKeys.map(({ key, field }) => ({ [field]: key })),
    },
    select: { visitorName: true, visitorPhone: true },
    distinct: ['visitorPhone', 'visitorName'],
    take: 20,
  });

  // Build a lookup map: phone → record, name → record
  const sampleByPhone = new Map(repeatVisitorSamples.filter(s => s.visitorPhone).map(s => [s.visitorPhone!, s]));
  const sampleByName  = new Map(repeatVisitorSamples.filter(s => s.visitorName).map(s => [s.visitorName!, s]));

  const repeatVisitors = repeatVisitorKeys.map(({ key, field, visits }) => {
    const sample = field === 'visitorPhone'
      ? sampleByPhone.get(key)
      : sampleByName.get(key);
    return {
      name: sample?.visitorName ?? '',
      phone: sample?.visitorPhone ?? null,
      email: null as string | null,
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
      guestConversion: { convertedCount, totalUniqueVisitors, conversionRate },
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
    res.json({ success: true, data: { totalCells: 0, activeCells: 0, totalMembers: 0, totalMeetings: 0, totalVisitors: 0, attendanceRate: 0, recentMeetingsCount: 0, topByMembers: [], topByMeetings: [], topByGiving: [], topByAttendanceRate: [] } });
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
    attendanceByStatus,
    recentMeetingsCount,
    // Per-cell member counts
    memberCounts,
    // Per-cell meeting counts
    meetingCounts,
    // Per-cell attendance (for rate ranking)
    attendancePerCell,
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
    prisma.cellAttendance.groupBy({
      by: ['status'],
      where: { cellId: { in: cellIds }, isVisitor: false },
      _count: { id: true },
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
    prisma.cellAttendance.groupBy({
      by: ['cellId', 'status'],
      where: { cellId: { in: cellIds }, isVisitor: false },
      _count: { id: true },
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
  const presentTotal = attendanceByStatus.find(a => a.status === 'present')?._count.id ?? 0;
  const attTotal = attendanceByStatus.reduce((s, a) => s + a._count.id, 0);
  const attendanceRate = attTotal > 0 ? Math.round((presentTotal / attTotal) * 100) : 0;

  // ── Top by attendance rate (compute per-cell rate from grouped data) ──────
  const cellAttMap = new Map<string, { present: number; total: number }>();
  for (const a of attendancePerCell) {
    if (!a.cellId) continue;
    if (!cellAttMap.has(a.cellId)) cellAttMap.set(a.cellId, { present: 0, total: 0 });
    const entry = cellAttMap.get(a.cellId)!;
    entry.total += a._count.id;
    if (a.status === 'present') entry.present += a._count.id;
  }
  const topByAttendanceRate = Array.from(cellAttMap.entries())
    .map(([cellId, v]) => ({
      id: cellId,
      name: label(cellId),
      attendanceRate: v.total > 0 ? Math.round((v.present / v.total) * 100) : 0,
      present: v.present,
      total: v.total,
    }))
    .sort((a, b) => b.attendanceRate - a.attendanceRate)
    .slice(0, 5);

  // ── Cumulative conversion rate — two parallel DB queries ─────────────────
  const [uniqueVisitorPhones, convertedMembers] = await Promise.all([
    prisma.cellAttendance.findMany({
      where: { cellId: { in: cellIds }, isVisitor: true, visitorPhone: { not: null } },
      select: { visitorPhone: true },
      distinct: ['visitorPhone'],
    }),
    // Will filter after getting visitor phones
    Promise.resolve(null),
  ]);

  const visitorPhones = uniqueVisitorPhones.map((v: any) => v.visitorPhone).filter(Boolean);
  const convertedCount = visitorPhones.length > 0
    ? await prisma.cellMember.count({
        where: {
          cellId: { in: cellIds },
          status: 'active',
          user: { phone: { in: visitorPhones } },
        },
      })
    : 0;

  const cumulativeConversionRate = visitorPhones.length > 0
    ? Math.round((convertedCount / visitorPhones.length) * 100)
    : 0;

  res.json({
    success: true,
    data: {
      totalCells, activeCells, totalMembers, totalMeetings, totalVisitors, attendanceRate, recentMeetingsCount,
      cumulativeConversionRate,
      topByMembers: memberCounts.map(c => ({ id: c.cellId, name: label(c.cellId), count: c._count.id })),
      topByMeetings: meetingCounts.map(c => ({ id: c.cellId, name: label(c.cellId), count: c._count.id })),
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
