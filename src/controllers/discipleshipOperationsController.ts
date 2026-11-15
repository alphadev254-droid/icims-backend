import crypto from 'crypto';
import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { getAccessibleChurchIds } from '../lib/churchScope';
import { syncFirstTimerAttendanceCandidates } from '../services/discipleshipIntakeService';
import { dispatchDiscipleshipNotifications } from '../services/discipleshipNotificationService';

async function scope(req: Request) {
  const user = req.user!;
  return getAccessibleChurchIds(user.role, user.churchId, user.districts, user.traditionalAuthorities, user.regions, user.userId);
}

async function scopedJourney(req: Request, journeyId: string) {
  const churchIds = await scope(req);
  return prisma.discipleshipJourney.findFirst({ where: {
    id: journeyId,
    churchId: { in: churchIds },
    ...(req.user!.role === 'discipleship_candidate' ? { candidateUserId: req.user!.userId } : {}),
  } });
}

const personInChargeSchema = z.array(z.object({ churchId: z.string().min(1), userId: z.string().min(1) })).min(1).max(100);

const courseSchema = z.object({
  churchId: z.string().min(1).optional(), churchIds: z.array(z.string().min(1)).min(1).max(100).optional(), title: z.string().trim().min(1).max(180), description: z.string().trim().max(5000).optional(),
  status: z.enum(['draft', 'published']).default('draft'),
  personsInCharge: personInChargeSchema,
  materials: z.array(z.object({ title: z.string().trim().min(1).max(180), kind: z.enum(['text', 'document', 'audio', 'video', 'link']),
    url: z.string().url().optional(), content: z.string().max(50000).optional(), downloadable: z.boolean().default(false) })
    .refine(item => item.content || item.url, 'Material content or URL is required')).default([]),
}).refine(value => value.churchId || value.churchIds?.length, { message: 'Select at least one church', path: ['churchIds'] });

const requirementDefinitionSchema = z.object({
  churchIds: z.array(z.string().min(1)).min(1).max(100),
  type: z.enum(['checklist', 'approval', 'milestone', 'assessment']),
  title: z.string().trim().min(1).max(180),
  description: z.string().trim().max(5000).optional(),
  status: z.enum(['draft', 'published']).default('published'),
  passScore: z.number().min(0).optional(),
  maxScore: z.number().positive().optional(),
  personsInCharge: personInChargeSchema,
}).superRefine((value, ctx) => {
  if (value.type === 'assessment' && value.passScore !== undefined && value.maxScore !== undefined && value.passScore > value.maxScore) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Pass score cannot exceed the maximum score', path: ['passScore'] });
  }
});

function jsonChurchIds(value: unknown, fallback?: string): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : fallback ? [fallback] : [];
}

async function validatePersonsInCharge(churchIds: string[], assignments: Array<{ churchId: string; userId: string }>) {
  const uniqueChurches = new Set(assignments.map(item => item.churchId));
  if (assignments.length !== churchIds.length || uniqueChurches.size !== churchIds.length || churchIds.some(id => !uniqueChurches.has(id))) return 'Select one person in charge for every selected church';
  const users = await prisma.user.findMany({ where: { OR: assignments.map(item => ({ id: item.userId, churchId: item.churchId })), status: 'active' }, select: { id: true, churchId: true } });
  const valid = new Set(users.map(user => `${user.churchId}:${user.id}`));
  return assignments.some(item => !valid.has(`${item.churchId}:${item.userId}`)) ? 'A person in charge must be an active user of the selected church' : null;
}

async function attachAssignments<T extends { id: string }>(items: T[], itemType: 'course' | 'requirement') {
  const assignments = items.length ? await prisma.discipleshipCatalogAssignment.findMany({ where: { itemType, itemId: { in: items.map(item => item.id) } } }) : [];
  return items.map(item => ({ ...item, personsInCharge: assignments.filter(assignment => assignment.itemId === item.id) }));
}

async function completeCourseEnrollmentIfSatisfied(enrollmentId: string, actorUserId: string) {
  const enrollment = await prisma.discipleshipClassEnrollment.findUnique({
    where: { id: enrollmentId },
    include: {
      class: { include: { sessions: { where: { status: { not: 'cancelled' } }, include: { attendance: { where: { enrollmentId } } } } } },
    },
  });
  if (!enrollment || enrollment.status === 'completed' || !enrollment.class.sessions.length) return false;
  const completedStatuses = new Set(['present', 'late', 'excused']);
  const allSessionsCompleted = enrollment.class.sessions.every(session => session.attendance.some(record => completedStatuses.has(record.status)));
  if (!allSessionsCompleted) return false;

  const journey = await prisma.discipleshipJourney.findUnique({ where: { id: enrollment.journeyId }, select: { ministryAdminId: true, churchId: true } });
  if (!journey) return false;
  await prisma.$transaction(async tx => {
    await tx.discipleshipClassEnrollment.update({ where: { id: enrollment.id }, data: { status: 'completed', completedAt: new Date() } });
    if (enrollment.requirementId) {
      await tx.discipleshipJourneyRequirement.updateMany({ where: { id: enrollment.requirementId, status: 'pending' }, data: {
        status: 'completed', completedById: actorUserId, completedAt: new Date(), completionNote: 'Completed automatically from class attendance.',
      } });
    }
    const stages = await tx.discipleshipJourneyStage.findMany({ where: { journeyId: enrollment.journeyId }, include: { requirements: true } });
    const required = stages.flatMap(stage => stage.requirements).filter(requirement => requirement.isRequired);
    const completed = required.filter(requirement => requirement.status !== 'pending').length;
    const progressPercent = required.length ? Math.round(completed / required.length * 100) : 0;
    await tx.discipleshipJourney.update({ where: { id: enrollment.journeyId }, data: { progressPercent, version: { increment: 1 } } });
    await tx.discipleshipAuditEvent.create({ data: {
      ministryAdminId: journey.ministryAdminId, churchId: journey.churchId, journeyId: enrollment.journeyId,
      actorUserId, action: 'course.completed', entityType: 'class_enrollment', entityId: enrollment.id,
      metadata: { classId: enrollment.classId, requirementId: enrollment.requirementId },
    } });
  });
  return true;
}

export async function listCourses(req: Request, res: Response) {
  const churchIds = await scope(req);
  const items = await prisma.discipleshipCourse.findMany({ where: { OR: [{ churchId: { in: churchIds } }, ...churchIds.map(churchId => ({ churchIds: { array_contains: churchId } }))], status: req.query.includeDrafts === 'true' ? undefined : 'published' },
    include: { materials: { orderBy: { position: 'asc' } }, classes: { orderBy: { startsAt: 'desc' }, include: { sessions: { orderBy: { startsAt: 'asc' } }, _count: { select: { enrollments: true } } } }, assessments: true },
    orderBy: { updatedAt: 'desc' } });
  res.json({ success: true, data: await attachAssignments(items, 'course') });
}

export async function createCourse(req: Request, res: Response) {
  const parsed = courseSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || 'Invalid course' }); return; }
  const accessibleChurchIds = await scope(req);
  const selectedChurchIds = [...new Set(parsed.data.churchIds?.length ? parsed.data.churchIds : [parsed.data.churchId!])];
  if (selectedChurchIds.some(churchId => !accessibleChurchIds.includes(churchId))) { res.status(403).json({ success: false, message: 'A selected church is outside your access scope' }); return; }
  const churches = await prisma.church.findMany({ where: { id: { in: selectedChurchIds }, status: 'active', ministryAdminId: { not: null } }, select: { id: true, ministryAdminId: true } });
  if (churches.length !== selectedChurchIds.length || new Set(churches.map(church => church.ministryAdminId)).size !== 1) { res.status(422).json({ success: false, message: 'Selected churches must be active and belong to the same ministry' }); return; }
  const assignmentError = await validatePersonsInCharge(selectedChurchIds, parsed.data.personsInCharge);
  if (assignmentError) { res.status(422).json({ success: false, message: assignmentError }); return; }
  const item = await prisma.$transaction(async tx => {
    const course = await tx.discipleshipCourse.create({ data: { ministryAdminId: churches[0].ministryAdminId!, churchId: selectedChurchIds[0], churchIds: selectedChurchIds,
      title: parsed.data.title, description: parsed.data.description, status: parsed.data.status, createdById: req.user!.userId,
      materials: { create: parsed.data.materials.map((material, index) => ({ ...material, position: index + 1 })) } }, include: { materials: true } });
    await tx.discipleshipCatalogAssignment.createMany({ data: parsed.data.personsInCharge.map(assignment => ({ ...assignment, itemType: 'course', itemId: course.id })) });
    return course;
  });
  res.status(201).json({ success: true, data: item });
}

const classSchema = z.object({ churchId: z.string().min(1).optional(), title: z.string().trim().min(1).max(180), facilitatorId: z.string().optional(), location: z.string().trim().max(240).optional(),
  startsAt: z.string().datetime(), endsAt: z.string().datetime().optional(), capacity: z.number().int().positive().optional(), reminderMinutes: z.number().int().min(0).max(10080).default(1440),
  sessions: z.array(z.object({ title: z.string().trim().min(1).max(180), startsAt: z.string().datetime(), endsAt: z.string().datetime().optional(), location: z.string().trim().max(240).optional() })).min(1),
});

export async function createClass(req: Request, res: Response) {
  const parsed = classSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || 'Invalid class schedule' }); return; }
  const churchIds = await scope(req);
  const course = await prisma.discipleshipCourse.findUnique({ where: { id: String(req.params.courseId) } });
  if (!course) { res.status(404).json({ success: false, message: 'Course not found' }); return; }
  const availableChurchIds = jsonChurchIds(course.churchIds, course.churchId).filter(churchId => churchIds.includes(churchId));
  const classChurchId = parsed.data.churchId || (availableChurchIds.length === 1 ? availableChurchIds[0] : undefined);
  if (!classChurchId || !availableChurchIds.includes(classChurchId)) { res.status(422).json({ success: false, message: 'Select a church where this course is available' }); return; }
  if (parsed.data.endsAt && new Date(parsed.data.endsAt) <= new Date(parsed.data.startsAt)) { res.status(400).json({ success: false, message: 'Class end must be after its start' }); return; }
  const item = await prisma.discipleshipClass.create({ data: { courseId: course.id, churchId: classChurchId, title: parsed.data.title,
    facilitatorId: parsed.data.facilitatorId, location: parsed.data.location, startsAt: new Date(parsed.data.startsAt), endsAt: parsed.data.endsAt ? new Date(parsed.data.endsAt) : null,
    capacity: parsed.data.capacity, reminderMinutes: parsed.data.reminderMinutes, sessions: { create: parsed.data.sessions.map(session => ({ title: session.title,
      startsAt: new Date(session.startsAt), endsAt: session.endsAt ? new Date(session.endsAt) : null, location: session.location, checkInCode: crypto.randomBytes(4).toString('hex').toUpperCase() })) } },
    include: { sessions: { orderBy: { startsAt: 'asc' } } } });
  res.status(201).json({ success: true, data: item });
}

export async function listRequirementDefinitions(req: Request, res: Response) {
  const accessibleChurchIds = await scope(req);
  const items = await prisma.discipleshipRequirementDefinition.findMany({
    where: { status: req.query.includeDrafts === 'true' ? undefined : 'published' },
    include: { _count: { select: { questions: true } } },
    orderBy: [{ type: 'asc' }, { title: 'asc' }],
  });
  const visible = items.filter(item => jsonChurchIds(item.churchIds).some(churchId => accessibleChurchIds.includes(churchId)));
  res.json({ success: true, data: await attachAssignments(visible, 'requirement') });
}

export async function createRequirementDefinition(req: Request, res: Response) {
  const parsed = requirementDefinitionSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || 'Invalid requirement' }); return; }
  const accessibleChurchIds = await scope(req);
  if (parsed.data.churchIds.some(churchId => !accessibleChurchIds.includes(churchId))) { res.status(403).json({ success: false, message: 'A selected church is outside your access scope' }); return; }
  const churches = await prisma.church.findMany({ where: { id: { in: parsed.data.churchIds }, status: 'active', ministryAdminId: { not: null } }, select: { ministryAdminId: true } });
  if (churches.length !== parsed.data.churchIds.length || new Set(churches.map(church => church.ministryAdminId)).size !== 1) { res.status(422).json({ success: false, message: 'Selected churches must be active and belong to the same ministry' }); return; }
  const assignmentError = await validatePersonsInCharge(parsed.data.churchIds, parsed.data.personsInCharge);
  if (assignmentError) { res.status(422).json({ success: false, message: assignmentError }); return; }
  const { personsInCharge, ...definitionData } = parsed.data;
  const item = await prisma.$transaction(async tx => {
    const definition = await tx.discipleshipRequirementDefinition.create({ data: { ...definitionData, churchIds: [...new Set(definitionData.churchIds)], ministryAdminId: churches[0].ministryAdminId!, createdById: req.user!.userId } });
    await tx.discipleshipCatalogAssignment.createMany({ data: personsInCharge.map(assignment => ({ ...assignment, itemType: 'requirement', itemId: definition.id })) });
    return definition;
  });
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
  const courseCompleted = await completeCourseEnrollmentIfSatisfied(enrollment.id, req.user!.userId);
  res.json({ success: true, data: item, courseCompleted });
}

export async function checkInByCode(req: Request, res: Response) {
  const parsed = z.object({ code: z.string().trim().min(4), journeyId: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: 'Check-in code and journey are required' }); return; }
  const code = parsed.data.code.replace(/^ICIMS-DISCIPLESHIP:/i, '').trim().toUpperCase();
  const journey = await scopedJourney(req, parsed.data.journeyId);
  const session = journey ? await prisma.discipleshipClassSession.findFirst({ where: { checkInCode: code, status: 'open', class: { churchId: journey.churchId } } }) : null;
  const enrollment = session ? await prisma.discipleshipClassEnrollment.findUnique({ where: { classId_journeyId: { classId: session.classId, journeyId: parsed.data.journeyId } } }) : null;
  if (!session || !enrollment) { res.status(404).json({ success: false, message: 'No open session or enrollment matches this code' }); return; }
  const item = await prisma.discipleshipSessionAttendance.upsert({ where: { sessionId_enrollmentId: { sessionId: session.id, enrollmentId: enrollment.id } },
    update: { status: 'present', method: parsed.data.code.toUpperCase().startsWith('ICIMS-DISCIPLESHIP:') ? 'qr' : 'sms_code', checkedInAt: new Date() }, create: { sessionId: session.id, enrollmentId: enrollment.id, status: 'present', method: parsed.data.code.toUpperCase().startsWith('ICIMS-DISCIPLESHIP:') ? 'qr' : 'sms_code', checkedInAt: new Date() } });
  const courseCompleted = await completeCourseEnrollmentIfSatisfied(enrollment.id, req.user!.userId);
  res.json({ success: true, data: item, courseCompleted });
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

export async function getJourneyOperationsOptions(req: Request, res: Response) {
  const journey = await scopedJourney(req, String(req.params.id));
  if (!journey) { res.status(404).json({ success: false, message: 'Journey not found' }); return; }
  const [mentors, teams, cells, classes] = await Promise.all([
    prisma.user.findMany({
      where: { churchId: journey.churchId, status: 'active', role: { name: { notIn: ['discipleship_candidate', 'referrer'] } } },
      select: { id: true, firstName: true, lastName: true, email: true, role: { select: { name: true, displayName: true } } },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      take: 500,
    }),
    prisma.team.findMany({ where: { churchId: journey.churchId }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.cell.findMany({ where: { churchId: journey.churchId, status: 'active' }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.discipleshipClass.findMany({
      where: { churchId: journey.churchId, status: { in: ['scheduled', 'active'] }, course: { status: 'published' } },
      select: { id: true, courseId: true, title: true, startsAt: true, endsAt: true, capacity: true, status: true, course: { select: { id: true, title: true } }, _count: { select: { enrollments: true } } },
      orderBy: { startsAt: 'asc' },
      take: 500,
    }),
  ]);
  res.json({ success: true, data: { mentors, teams, cells, classes } });
}

export async function getClassRoster(req: Request, res: Response) {
  const churchIds = await scope(req);
  const klass = await prisma.discipleshipClass.findFirst({
    where: { id: String(req.params.classId), churchId: { in: churchIds } },
    include: { course: { select: { id: true, title: true } }, sessions: { orderBy: { startsAt: 'asc' } } },
  });
  if (!klass) { res.status(404).json({ success: false, message: 'Class not found' }); return; }
  const enrollments = await prisma.discipleshipClassEnrollment.findMany({ where: { classId: klass.id }, include: { attendance: true }, orderBy: { enrolledAt: 'asc' } });
  const journeys = enrollments.length ? await prisma.discipleshipJourney.findMany({
    where: { id: { in: enrollments.map(item => item.journeyId) } },
    select: { id: true, journeyCode: true, candidateUser: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } } },
  }) : [];
  const journeyMap = new Map(journeys.map(item => [item.id, item]));
  res.json({ success: true, data: { ...klass, enrollments: enrollments.map(item => ({ ...item, journey: journeyMap.get(item.journeyId) || null })) } });
}

export async function updateClassSessionStatus(req: Request, res: Response) {
  const parsed = z.object({ status: z.enum(['scheduled', 'open', 'completed', 'cancelled']) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: 'Invalid session status' }); return; }
  const churchIds = await scope(req);
  const session = await prisma.discipleshipClassSession.findFirst({ where: { id: String(req.params.sessionId), class: { churchId: { in: churchIds } } } });
  if (!session) { res.status(404).json({ success: false, message: 'Session not found' }); return; }
  const updated = await prisma.discipleshipClassSession.update({ where: { id: session.id }, data: { status: parsed.data.status } });
  res.json({ success: true, data: updated });
}

export async function getDiscipleshipReport(req: Request, res: Response) {
  const accessibleChurchIds = await scope(req);
  const accessibleChurches = await prisma.church.findMany({ where: { id: { in: accessibleChurchIds } }, select: { id: true, name: true, region: true } });
  const requestedChurchId = typeof req.query.churchId === 'string' ? req.query.churchId : undefined;
  const requestedRegion = typeof req.query.region === 'string' ? req.query.region.trim() : undefined;
  const requestedWorkflowId = typeof req.query.workflowId === 'string' ? req.query.workflowId : undefined;
  const requestedSourceType = typeof req.query.sourceType === 'string' ? req.query.sourceType : undefined;
  const mode = req.query.mode === 'activity' ? 'activity' : 'cohort';
  if (requestedChurchId && !accessibleChurchIds.includes(requestedChurchId)) { res.status(403).json({ success: false, message: 'The selected church is outside your access scope' }); return; }
  let selected = accessibleChurches.filter(church => !requestedRegion || church.region === requestedRegion).map(church => church.id);
  if (requestedChurchId) selected = selected.filter(id => id === requestedChurchId);
  const parseBoundary = (value: unknown, endOfDay: boolean) => typeof value === 'string'
    ? new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`)
    : new Date(Date.now() - (endOfDay ? 0 : 90 * 86400000));
  const from = parseBoundary(req.query.from, false); const to = parseBoundary(req.query.to, true);
  if (Number.isNaN(from.valueOf()) || Number.isNaN(to.valueOf()) || from > to) { res.status(400).json({ success: false, message: 'Invalid report date range' }); return; }
  const baseWhere: any = {
    churchId: { in: selected },
    ...(requestedWorkflowId ? { workflowId: requestedWorkflowId } : {}),
    ...(requestedSourceType ? { candidate: { intakes: { some: { sourceType: requestedSourceType } } } } : {}),
  };
  let activityIds: string[] | undefined;
  const activityWithdrawnIds = new Set<string>();
  if (mode === 'activity') {
    const [journeyActivity, auditActivity, milestones, attendance] = await Promise.all([
      prisma.discipleshipJourney.findMany({ where: { ...baseWhere, OR: [{ startedAt: { gte: from, lte: to } }, { completedAt: { gte: from, lte: to } }, { updatedAt: { gte: from, lte: to } }] }, select: { id: true } }),
      prisma.discipleshipAuditEvent.findMany({ where: { churchId: { in: selected }, journeyId: { not: null }, createdAt: { gte: from, lte: to } }, select: { journeyId: true, action: true } }),
      prisma.discipleshipMilestoneRecord.findMany({ where: { milestoneDate: { gte: from, lte: to } }, select: { journeyId: true } }),
      prisma.discipleshipSessionAttendance.findMany({ where: { enrollment: { class: { churchId: { in: selected } } }, OR: [{ checkedInAt: { gte: from, lte: to } }, { createdAt: { gte: from, lte: to } }] }, select: { enrollment: { select: { journeyId: true } } } }),
    ]);
    auditActivity.filter(item => item.action === 'journey.withdrawn' && item.journeyId).forEach(item => activityWithdrawnIds.add(item.journeyId!));
    activityIds = [...new Set([...journeyActivity.map(item => item.id), ...auditActivity.map(item => item.journeyId).filter((id): id is string => !!id), ...milestones.map(item => item.journeyId), ...attendance.map(item => item.enrollment.journeyId)])];
  }
  const journeys = await prisma.discipleshipJourney.findMany({ where: { ...baseWhere, ...(mode === 'cohort' ? { startedAt: { gte: from, lte: to } } : { id: { in: activityIds || [] } }) }, include: { church: { select: { id: true, name: true, region: true } }, workflow: { select: { id: true, name: true } }, stages: { orderBy: { position: 'asc' } } } });
  const intakeJourneys = journeys.filter(item => item.startedAt >= from && item.startedAt <= to);
  const completed = journeys.filter(item => mode === 'cohort' ? item.status === 'completed' : !!item.completedAt && item.completedAt >= from && item.completedAt <= to);
  const withdrawn = journeys.filter(item => mode === 'cohort' ? item.status === 'withdrawn' : activityWithdrawnIds.has(item.id));
  const stageCounts = new Map<string, number>(); journeys.filter(item => ['invited', 'active', 'paused'].includes(item.status)).forEach(item => { const stage = item.stages.find(value => value.id === item.currentStageId); if (stage) stageCounts.set(stage.name, (stageCounts.get(stage.name) || 0) + 1); });
  const dropoutCounts = new Map<string, number>(); withdrawn.forEach(item => { const stage = item.stages.find(value => value.id === item.currentStageId); const stageName = stage?.name || 'Stage not recorded'; dropoutCounts.set(stageName, (dropoutCounts.get(stageName) || 0) + 1); });
  const trend = new Map<string, number>(); intakeJourneys.forEach(item => { const key = item.startedAt.toISOString().slice(0, 7); trend.set(key, (trend.get(key) || 0) + 1); });
  const averageCompletionDays = completed.length ? completed.reduce((sum, item) => sum + ((item.completedAt!.getTime() - item.startedAt.getTime()) / 86400000), 0) / completed.length : 0;
  const journeyIds = journeys.map(item => item.id); const now = new Date(); const inSevenDays = new Date(now.getTime() + 7 * 86400000);
  const candidateIds = [...new Set(journeys.map(item => item.candidateId))];
  const [mentorAssignments, upcomingSessions, attendance, placements, milestoneRecords, intakes, filterWorkflows] = await Promise.all([
    prisma.discipleshipMentorAssignment.findMany({ where: { journeyId: { in: journeyIds }, status: 'active' }, select: { journeyId: true, nextFollowUpAt: true } }),
    prisma.discipleshipClassSession.count({ where: { class: { churchId: { in: selected }, enrollments: { some: { journeyId: { in: journeyIds }, status: 'enrolled' } } }, status: { in: ['scheduled', 'open'] }, startsAt: { gte: now, lte: inSevenDays } } }),
    prisma.discipleshipSessionAttendance.groupBy({ by: ['status'], where: { enrollment: { journeyId: { in: journeyIds } } }, _count: { _all: true } }),
    prisma.discipleshipPlacement.count({ where: { journeyId: { in: journeyIds }, status: 'planned' } }),
    prisma.discipleshipMilestoneRecord.findMany({ where: { journeyId: { in: journeyIds }, ...(mode === 'activity' ? { milestoneDate: { gte: from, lte: to } } : {}) }, select: { journeyId: true, requirementId: true, milestoneDate: true } }),
    prisma.discipleshipIntake.findMany({ where: { candidateId: { in: candidateIds } }, orderBy: { createdAt: 'asc' }, select: { candidateId: true, sourceType: true } }),
    prisma.discipleshipWorkflow.findMany({ where: { churchId: { in: accessibleChurchIds }, status: { in: ['published', 'archived'] } }, orderBy: { name: 'asc' }, select: { id: true, name: true, church: { select: { id: true, name: true } } } }),
  ]);
  const requirementIds = [...new Set(milestoneRecords.map(item => item.requirementId))];
  const milestoneRequirements = requirementIds.length ? await prisma.discipleshipJourneyRequirement.findMany({ where: { id: { in: requirementIds } }, select: { id: true, name: true } }) : [];
  const milestoneName = new Map(milestoneRequirements.map(item => [item.id, item.name])); const journeyStart = new Map(journeys.map(item => [item.id, item.startedAt]));
  const milestoneDurations = new Map<string, number[]>(); milestoneRecords.forEach(record => { const startedAt = journeyStart.get(record.journeyId); if (!startedAt) return; const days = (record.milestoneDate.getTime() - startedAt.getTime()) / 86400000; if (days < 0) return; const name = milestoneName.get(record.requirementId) || 'Milestone'; milestoneDurations.set(name, [...(milestoneDurations.get(name) || []), days]); });
  const timeToMilestone = [...milestoneDurations].map(([milestone, durations]) => { const sorted = [...durations].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; return { milestone, completed: durations.length, averageDays: Math.round(durations.reduce((sum, days) => sum + days, 0) / durations.length * 10) / 10, medianDays: Math.round(median * 10) / 10 }; }).sort((a, b) => a.averageDays - b.averageDays);
  const regionCounts = new Map<string, number>(); const workflowCounts = new Map<string, number>(); journeys.forEach(item => { const region = item.church.region || 'Region not recorded'; regionCounts.set(region, (regionCounts.get(region) || 0) + 1); workflowCounts.set(item.workflow.name, (workflowCounts.get(item.workflow.name) || 0) + 1); });
  const intakeByCandidate = new Map<string, string>(); intakes.forEach(item => { if (!intakeByCandidate.has(item.candidateId)) intakeByCandidate.set(item.candidateId, item.sourceType); });
  const sourceCounts = new Map<string, number>(); journeys.forEach(item => { const source = intakeByCandidate.get(item.candidateId) || 'direct'; sourceCounts.set(source, (sourceCounts.get(source) || 0) + 1); });
  const attendanceTotal = attendance.reduce((sum, item) => sum + item._count._all, 0); const attended = attendance.filter(item => ['present', 'late'].includes(item.status)).reduce((sum, item) => sum + item._count._all, 0);
  const activeJourneys = journeys.filter(item => item.status === 'active'); const assignedJourneyIds = new Set(mentorAssignments.map(item => item.journeyId));
  const overdueFollowUps = mentorAssignments.filter(item => item.nextFollowUpAt && item.nextFollowUpAt < now).length;
  res.json({ success: true, data: { range: { from, to, mode }, totals: { inScope: journeys.length, intake: intakeJourneys.length, active: journeys.filter(item => item.status === 'active').length,
    completed: completed.length, withdrawn: withdrawn.length, completionRate: journeys.length ? Math.round(completed.length / journeys.length * 1000) / 10 : 0,
    dropoutRate: journeys.length ? Math.round(withdrawn.length / journeys.length * 1000) / 10 : 0, averageCompletionDays: Math.round(averageCompletionDays * 10) / 10,
    attendanceRate: attendanceTotal ? Math.round(attended / attendanceTotal * 1000) / 10 : 0,
    unassignedMentors: activeJourneys.filter(item => !assignedJourneyIds.has(item.id)).length,
    overdueFollowUps, upcomingSessions, pendingPlacements: placements },
    intakeTrend: [...trend].map(([period, count]) => ({ period, count })).sort((a, b) => a.period.localeCompare(b.period)),
    candidatesByStage: [...stageCounts].map(([stage, count]) => ({ stage, count })).sort((a, b) => b.count - a.count),
    dropoutsByStage: [...dropoutCounts].map(([stage, count]) => ({ stage, count })).sort((a, b) => b.count - a.count),
    timeToMilestone,
    byRegion: [...regionCounts].map(([region, count]) => ({ region, count })).sort((a, b) => b.count - a.count),
    byWorkflow: [...workflowCounts].map(([workflow, count]) => ({ workflow, count })).sort((a, b) => b.count - a.count),
    bySource: [...sourceCounts].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count),
    filterOptions: { regions: [...new Set(accessibleChurches.map(church => church.region).filter((region): region is string => !!region))].sort(), workflows: filterWorkflows, sources: ['attendance', 'evangelism', 'direct', 'transfer'] } } });
}

export async function dispatchDiscipleshipReminders(req: Request, res: Response) {
  const churchIds = await scope(req);
  const result = await dispatchDiscipleshipNotifications({ churchIds });
  res.json({ success: true, data: result });
}

export async function syncAttendanceIntake(req: Request, res: Response) {
  const churchIds = await scope(req);
  const result = await syncFirstTimerAttendanceCandidates({ churchIds, take: 5000 });
  res.json({ success: true, data: result });
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
