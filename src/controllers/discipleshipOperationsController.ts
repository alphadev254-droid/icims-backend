import crypto from 'crypto';
import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { getAccessibleChurchIds } from '../lib/churchScope';
import { sendPushToUsers } from '../lib/fcm';

async function scope(req: Request) {
  const user = req.user!;
  return getAccessibleChurchIds(user.role, user.churchId, user.districts, user.traditionalAuthorities, user.regions, user.userId);
}

async function scopedJourney(req: Request, journeyId: string) {
  const churchIds = await scope(req);
  return prisma.discipleshipJourney.findFirst({ where: { id: journeyId, churchId: { in: churchIds } } });
}

const courseSchema = z.object({
  churchId: z.string().min(1), title: z.string().trim().min(1).max(180), description: z.string().trim().max(5000).optional(),
  status: z.enum(['draft', 'published']).default('draft'),
  materials: z.array(z.object({ title: z.string().trim().min(1).max(180), kind: z.enum(['text', 'document', 'audio', 'video', 'link']),
    url: z.string().url().optional(), content: z.string().max(50000).optional(), downloadable: z.boolean().default(false) })
    .refine(item => item.content || item.url, 'Material content or URL is required')).default([]),
});

export async function listCourses(req: Request, res: Response) {
  const churchIds = await scope(req);
  const items = await prisma.discipleshipCourse.findMany({ where: { churchId: { in: churchIds }, status: req.query.includeDrafts === 'true' ? undefined : 'published' },
    include: { materials: { orderBy: { position: 'asc' } }, classes: { orderBy: { startsAt: 'desc' }, include: { sessions: { orderBy: { startsAt: 'asc' } }, _count: { select: { enrollments: true } } } }, assessments: true },
    orderBy: { updatedAt: 'desc' } });
  res.json({ success: true, data: items });
}

export async function createCourse(req: Request, res: Response) {
  const parsed = courseSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || 'Invalid course' }); return; }
  const churchIds = await scope(req);
  if (!churchIds.includes(parsed.data.churchId)) { res.status(403).json({ success: false, message: 'Church is outside your access scope' }); return; }
  const church = await prisma.church.findUnique({ where: { id: parsed.data.churchId }, select: { ministryAdminId: true } });
  if (!church?.ministryAdminId) { res.status(404).json({ success: false, message: 'Church not found' }); return; }
  const item = await prisma.discipleshipCourse.create({ data: { ministryAdminId: church.ministryAdminId, churchId: parsed.data.churchId,
    title: parsed.data.title, description: parsed.data.description, status: parsed.data.status, createdById: req.user!.userId,
    materials: { create: parsed.data.materials.map((material, index) => ({ ...material, position: index + 1 })) } }, include: { materials: true } });
  res.status(201).json({ success: true, data: item });
}

const classSchema = z.object({ title: z.string().trim().min(1).max(180), facilitatorId: z.string().optional(), location: z.string().trim().max(240).optional(),
  startsAt: z.string().datetime(), endsAt: z.string().datetime().optional(), capacity: z.number().int().positive().optional(), reminderMinutes: z.number().int().min(0).max(10080).default(1440),
  sessions: z.array(z.object({ title: z.string().trim().min(1).max(180), startsAt: z.string().datetime(), endsAt: z.string().datetime().optional(), location: z.string().trim().max(240).optional() })).min(1),
});

export async function createClass(req: Request, res: Response) {
  const parsed = classSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || 'Invalid class schedule' }); return; }
  const churchIds = await scope(req);
  const course = await prisma.discipleshipCourse.findFirst({ where: { id: String(req.params.courseId), churchId: { in: churchIds } } });
  if (!course) { res.status(404).json({ success: false, message: 'Course not found' }); return; }
  if (parsed.data.endsAt && new Date(parsed.data.endsAt) <= new Date(parsed.data.startsAt)) { res.status(400).json({ success: false, message: 'Class end must be after its start' }); return; }
  const item = await prisma.discipleshipClass.create({ data: { courseId: course.id, churchId: course.churchId, title: parsed.data.title,
    facilitatorId: parsed.data.facilitatorId, location: parsed.data.location, startsAt: new Date(parsed.data.startsAt), endsAt: parsed.data.endsAt ? new Date(parsed.data.endsAt) : null,
    capacity: parsed.data.capacity, reminderMinutes: parsed.data.reminderMinutes, sessions: { create: parsed.data.sessions.map(session => ({ title: session.title,
      startsAt: new Date(session.startsAt), endsAt: session.endsAt ? new Date(session.endsAt) : null, location: session.location, checkInCode: crypto.randomBytes(4).toString('hex').toUpperCase() })) } },
    include: { sessions: { orderBy: { startsAt: 'asc' } } } });
  res.status(201).json({ success: true, data: item });
}

const enrollmentSchema = z.object({ journeyId: z.string().min(1), requirementId: z.string().optional() });
export async function enrollCandidate(req: Request, res: Response) {
  const parsed = enrollmentSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: 'Journey is required' }); return; }
  const journey = await scopedJourney(req, parsed.data.journeyId);
  const klass = journey ? await prisma.discipleshipClass.findFirst({ where: { id: String(req.params.classId), churchId: journey.churchId } }) : null;
  if (!journey || !klass) { res.status(404).json({ success: false, message: 'Journey or class not found' }); return; }
  if (klass.capacity) { const count = await prisma.discipleshipClassEnrollment.count({ where: { classId: klass.id, status: 'enrolled' } }); if (count >= klass.capacity) { res.status(409).json({ success: false, message: 'Class is full' }); return; } }
  const item = await prisma.discipleshipClassEnrollment.upsert({ where: { classId_journeyId: { classId: klass.id, journeyId: journey.id } },
    update: { status: 'enrolled', requirementId: parsed.data.requirementId }, create: { classId: klass.id, journeyId: journey.id, requirementId: parsed.data.requirementId } });
  res.status(201).json({ success: true, data: item });
}

const attendanceSchema = z.object({ enrollmentId: z.string().min(1), status: z.enum(['present', 'late', 'absent', 'excused']).default('present'), method: z.enum(['manual', 'qr', 'sms_code']).default('manual') });
export async function recordSessionAttendance(req: Request, res: Response) {
  const parsed = attendanceSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: 'Invalid attendance' }); return; }
  const churchIds = await scope(req);
  const session = await prisma.discipleshipClassSession.findFirst({ where: { id: String(req.params.sessionId), class: { churchId: { in: churchIds } } } });
  const enrollment = session ? await prisma.discipleshipClassEnrollment.findFirst({ where: { id: parsed.data.enrollmentId, classId: session.classId } }) : null;
  if (!session || !enrollment) { res.status(404).json({ success: false, message: 'Session or enrollment not found' }); return; }
  const item = await prisma.discipleshipSessionAttendance.upsert({ where: { sessionId_enrollmentId: { sessionId: session.id, enrollmentId: enrollment.id } },
    update: { status: parsed.data.status, method: parsed.data.method, checkedInAt: parsed.data.status === 'present' || parsed.data.status === 'late' ? new Date() : null, recordedById: req.user!.userId },
    create: { sessionId: session.id, enrollmentId: enrollment.id, status: parsed.data.status, method: parsed.data.method,
      checkedInAt: parsed.data.status === 'present' || parsed.data.status === 'late' ? new Date() : null, recordedById: req.user!.userId } });
  res.json({ success: true, data: item });
}

export async function checkInByCode(req: Request, res: Response) {
  const parsed = z.object({ code: z.string().trim().min(4), journeyId: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: 'Check-in code and journey are required' }); return; }
  const journey = await scopedJourney(req, parsed.data.journeyId);
  const session = journey ? await prisma.discipleshipClassSession.findFirst({ where: { checkInCode: parsed.data.code.toUpperCase(), status: 'open', class: { churchId: journey.churchId } } }) : null;
  const enrollment = session ? await prisma.discipleshipClassEnrollment.findUnique({ where: { classId_journeyId: { classId: session.classId, journeyId: parsed.data.journeyId } } }) : null;
  if (!session || !enrollment) { res.status(404).json({ success: false, message: 'No open session or enrollment matches this code' }); return; }
  const item = await prisma.discipleshipSessionAttendance.upsert({ where: { sessionId_enrollmentId: { sessionId: session.id, enrollmentId: enrollment.id } },
    update: { status: 'present', method: 'sms_code', checkedInAt: new Date() }, create: { sessionId: session.id, enrollmentId: enrollment.id, status: 'present', method: 'sms_code', checkedInAt: new Date() } });
  res.json({ success: true, data: item });
}

export async function assignMentor(req: Request, res: Response) {
  const parsed = z.object({ mentorUserId: z.string().min(1), nextFollowUpAt: z.string().datetime().optional() }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: 'Mentor is required' }); return; }
  const journey = await scopedJourney(req, String(req.params.id));
  const mentor = journey ? await prisma.user.findFirst({ where: { id: parsed.data.mentorUserId, churchId: journey.churchId, status: 'active' } }) : null;
  if (!journey || !mentor) { res.status(404).json({ success: false, message: 'Journey or mentor not found in this church' }); return; }
  const item = await prisma.$transaction(async tx => { await tx.discipleshipMentorAssignment.updateMany({ where: { journeyId: journey.id, status: 'active' }, data: { status: 'reassigned', endedAt: new Date() } });
    return tx.discipleshipMentorAssignment.create({ data: { journeyId: journey.id, mentorUserId: mentor.id, assignedById: req.user!.userId,
      nextFollowUpAt: parsed.data.nextFollowUpAt ? new Date(parsed.data.nextFollowUpAt) : null } }); });
  res.status(201).json({ success: true, data: item });
}

export async function addMentorFollowUp(req: Request, res: Response) {
  const parsed = z.object({ notes: z.string().trim().min(1).max(10000), occurredAt: z.string().datetime().optional(), concernFlag: z.boolean().default(false), nextFollowUpAt: z.string().datetime().optional() }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || 'Follow-up notes are required' }); return; }
  const journey = await scopedJourney(req, String(req.params.id));
  const assignment = journey ? await prisma.discipleshipMentorAssignment.findFirst({ where: { journeyId: journey.id, status: 'active' } }) : null;
  if (!assignment) { res.status(404).json({ success: false, message: 'No active mentor assignment' }); return; }
  const item = await prisma.$transaction(async tx => { const interaction = await tx.discipleshipMentorInteraction.create({ data: { assignmentId: assignment.id,
    notes: parsed.data.notes, occurredAt: parsed.data.occurredAt ? new Date(parsed.data.occurredAt) : new Date(), concernFlag: parsed.data.concernFlag, createdById: req.user!.userId } });
    if (parsed.data.nextFollowUpAt) await tx.discipleshipMentorAssignment.update({ where: { id: assignment.id }, data: { nextFollowUpAt: new Date(parsed.data.nextFollowUpAt) } }); return interaction; });
  res.status(201).json({ success: true, data: item });
}

export async function savePlacement(req: Request, res: Response) {
  const parsed = z.object({ teamId: z.string().optional(), cellId: z.string().optional() }).refine(value => value.teamId || value.cellId, 'Select a team or cell').safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || 'Placement is required' }); return; }
  const journey = await scopedJourney(req, String(req.params.id));
  if (!journey) { res.status(404).json({ success: false, message: 'Journey not found' }); return; }
  if (parsed.data.teamId && !(await prisma.team.findFirst({ where: { id: parsed.data.teamId, churchId: journey.churchId } }))) { res.status(422).json({ success: false, message: 'Team does not belong to this church' }); return; }
  if (parsed.data.cellId && !(await prisma.cell.findFirst({ where: { id: parsed.data.cellId, churchId: journey.churchId, status: 'active' } }))) { res.status(422).json({ success: false, message: 'Cell does not belong to this church' }); return; }
  const item = await prisma.discipleshipPlacement.upsert({ where: { journeyId: journey.id }, update: parsed.data, create: { journeyId: journey.id, ...parsed.data } });
  res.json({ success: true, data: item });
}

export async function getDiscipleshipReport(req: Request, res: Response) {
  const churchIds = await scope(req); const selected = typeof req.query.churchId === 'string' && churchIds.includes(req.query.churchId) ? [req.query.churchId] : churchIds;
  const from = typeof req.query.from === 'string' ? new Date(req.query.from) : new Date(Date.now() - 90 * 86400000); const to = typeof req.query.to === 'string' ? new Date(req.query.to) : new Date();
  if (Number.isNaN(from.valueOf()) || Number.isNaN(to.valueOf()) || from > to) { res.status(400).json({ success: false, message: 'Invalid report date range' }); return; }
  const journeys = await prisma.discipleshipJourney.findMany({ where: { churchId: { in: selected }, startedAt: { gte: from, lte: to } }, include: { church: { select: { id: true, name: true } }, stages: { orderBy: { position: 'asc' } } } });
  const completed = journeys.filter(item => item.status === 'completed'); const withdrawn = journeys.filter(item => item.status === 'withdrawn');
  const stageCounts = new Map<string, number>(); journeys.filter(item => item.status !== 'completed').forEach(item => { const stage = item.stages.find(value => value.id === item.currentStageId); if (stage) stageCounts.set(stage.name, (stageCounts.get(stage.name) || 0) + 1); });
  const trend = new Map<string, number>(); journeys.forEach(item => { const key = item.startedAt.toISOString().slice(0, 7); trend.set(key, (trend.get(key) || 0) + 1); });
  const averageCompletionDays = completed.length ? completed.reduce((sum, item) => sum + ((item.completedAt!.getTime() - item.startedAt.getTime()) / 86400000), 0) / completed.length : 0;
  const journeyIds = journeys.map(item => item.id); const now = new Date(); const inSevenDays = new Date(now.getTime() + 7 * 86400000);
  const [mentorAssignments, upcomingSessions, attendance, placements] = await Promise.all([
    prisma.discipleshipMentorAssignment.findMany({ where: { journeyId: { in: journeyIds }, status: 'active' }, select: { journeyId: true, nextFollowUpAt: true } }),
    prisma.discipleshipClassSession.count({ where: { class: { churchId: { in: selected } }, status: { in: ['scheduled', 'open'] }, startsAt: { gte: now, lte: inSevenDays } } }),
    prisma.discipleshipSessionAttendance.groupBy({ by: ['status'], where: { enrollment: { journeyId: { in: journeyIds } } }, _count: { _all: true } }),
    prisma.discipleshipPlacement.count({ where: { journeyId: { in: journeyIds }, status: 'planned' } }),
  ]);
  const attendanceTotal = attendance.reduce((sum, item) => sum + item._count._all, 0); const attended = attendance.filter(item => ['present', 'late'].includes(item.status)).reduce((sum, item) => sum + item._count._all, 0);
  const activeJourneys = journeys.filter(item => item.status === 'active'); const assignedJourneyIds = new Set(mentorAssignments.map(item => item.journeyId));
  const overdueFollowUps = mentorAssignments.filter(item => item.nextFollowUpAt && item.nextFollowUpAt < now).length;
  res.json({ success: true, data: { range: { from, to }, totals: { intake: journeys.length, active: journeys.filter(item => item.status === 'active').length,
    completed: completed.length, withdrawn: withdrawn.length, completionRate: journeys.length ? Math.round(completed.length / journeys.length * 1000) / 10 : 0,
    dropoutRate: journeys.length ? Math.round(withdrawn.length / journeys.length * 1000) / 10 : 0, averageCompletionDays: Math.round(averageCompletionDays * 10) / 10,
    attendanceRate: attendanceTotal ? Math.round(attended / attendanceTotal * 1000) / 10 : 0,
    unassignedMentors: activeJourneys.filter(item => !assignedJourneyIds.has(item.id)).length,
    overdueFollowUps, upcomingSessions, pendingPlacements: placements },
    intakeTrend: [...trend].map(([period, count]) => ({ period, count })).sort((a, b) => a.period.localeCompare(b.period)),
    candidatesByStage: [...stageCounts].map(([stage, count]) => ({ stage, count })).sort((a, b) => b.count - a.count) } });
}

export async function dispatchDiscipleshipReminders(req: Request, res: Response) {
  const churchIds = await scope(req); const now = new Date(); const nextDay = new Date(now.getTime() + 25 * 3600000);
  const sessions = await prisma.discipleshipClassSession.findMany({ where: { class: { churchId: { in: churchIds }, status: { in: ['scheduled', 'active'] } }, status: { in: ['scheduled', 'open'] }, startsAt: { gte: now, lte: nextDay } },
    include: { class: { include: { enrollments: true } } } });
  let sent = 0;
  for (const session of sessions) for (const enrollment of session.class.enrollments.filter(item => item.status === 'enrolled')) {
    const journey = await prisma.discipleshipJourney.findUnique({ where: { id: enrollment.journeyId }, select: { candidateUserId: true, churchId: true } }); if (!journey) continue;
    const key = `class:${session.id}:${journey.candidateUserId}`; const exists = await prisma.discipleshipNotificationLog.findUnique({ where: { key } }); if (exists) continue;
    await sendPushToUsers([journey.candidateUserId], `Class reminder: ${session.title}`, `Your class starts ${session.startsAt.toLocaleString()}. Check the schedule for the location.`, { type: 'discipleship_class', sessionId: session.id });
    await prisma.discipleshipNotificationLog.create({ data: { key, churchId: journey.churchId, journeyId: enrollment.journeyId, sessionId: session.id, type: 'class_reminder', recipientId: journey.candidateUserId } }); sent++;
  }
  const missed = await prisma.discipleshipSessionAttendance.findMany({ where: { status: 'absent', session: { class: { churchId: { in: churchIds } }, endsAt: { lt: now } } }, include: { session: true, enrollment: true } });
  for (const record of missed) { const journey = await prisma.discipleshipJourney.findUnique({ where: { id: record.enrollment.journeyId }, select: { candidateUserId: true, churchId: true } }); if (!journey) continue;
    const key = `missed:${record.id}`; if (await prisma.discipleshipNotificationLog.findUnique({ where: { key } })) continue;
    await sendPushToUsers([journey.candidateUserId], 'We missed you', `You were marked absent for ${record.session.title}. Please contact your mentor to arrange the next step.`, { type: 'discipleship_missed_session' });
    await prisma.discipleshipNotificationLog.create({ data: { key, churchId: journey.churchId, journeyId: record.enrollment.journeyId, sessionId: record.sessionId, type: 'missed_session', recipientId: journey.candidateUserId } }); sent++;
  }
  res.json({ success: true, data: { sent } });
}

export async function syncAttendanceIntake(req: Request, res: Response) {
  const churchIds = await scope(req);
  const participants = await prisma.attendanceParticipant.findMany({ where: { attendance: { churchId: { in: churchIds } }, OR: [{ guestFirstTime: true }, { isNewConvert: true }], userId: null }, include: { attendance: { select: { churchId: true } } }, orderBy: { checkedInAt: 'desc' }, take: 500 });
  let created = 0;
  for (const person of participants) { const result = await prisma.discipleshipBelongingPrompt.upsert({ where: { churchId_sourceType_sourceRecordId: { churchId: person.attendance.churchId, sourceType: 'attendance', sourceRecordId: person.id } }, update: {},
    create: { churchId: person.attendance.churchId, sourceType: 'attendance', sourceRecordId: person.id, name: person.guestName || 'Attendance visitor', email: person.guestEmail, phone: person.guestPhone } }); if (result.createdAt.getTime() === result.updatedAt.getTime()) created++; }
  res.json({ success: true, data: { scanned: participants.length, created } });
}

export async function listBelongingPrompts(req: Request, res: Response) {
  const churchIds = await scope(req); const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const items = await prisma.discipleshipBelongingPrompt.findMany({ where: { churchId: { in: churchIds }, status }, orderBy: { promptedAt: 'desc' }, take: 250 });
  res.json({ success: true, data: items });
}

export async function updateBelongingPrompt(req: Request, res: Response) {
  const parsed = z.object({ status: z.enum(['pending', 'contacted', 'consented', 'declined', 'converted']), notes: z.string().trim().max(5000).optional(), assignedToId: z.string().optional() }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: 'Invalid prompt update' }); return; }
  const churchIds = await scope(req); const current = await prisma.discipleshipBelongingPrompt.findFirst({ where: { id: String(req.params.promptId), churchId: { in: churchIds } } });
  if (!current) { res.status(404).json({ success: false, message: 'Belonging prompt not found' }); return; }
  const item = await prisma.discipleshipBelongingPrompt.update({ where: { id: current.id }, data: { ...parsed.data, respondedAt: parsed.data.status === 'pending' ? null : new Date() } });
  res.json({ success: true, data: item });
}
