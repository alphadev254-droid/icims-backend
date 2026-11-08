import crypto from 'crypto';
import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { hashPassword } from '../lib/password';
import { getAccessibleChurchIds } from '../lib/churchScope';
import { checkMemberLimit } from '../lib/packageChecker';

const stageSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
  requirements: z.array(z.object({
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(2000).optional(),
    type: z.enum(['checklist', 'approval', 'course', 'milestone', 'assessment']).default('checklist'),
    isRequired: z.boolean().default(true),
  })).default([]),
});

const workflowSchema = z.object({
  churchId: z.string().min(1),
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(4000).optional(),
  isDefault: z.boolean().default(false),
  publish: z.boolean().default(false),
  stages: z.array(stageSchema).min(1).max(30),
});

const journeySchema = z.object({
  churchId: z.string().min(1),
  workflowId: z.string().min(1),
  existingUserId: z.string().min(1).optional(),
  candidate: z.object({
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    email: z.string().trim().toLowerCase().email(),
    phone: z.string().trim().max(30).optional(),
    preferredLanguage: z.string().trim().max(80).optional(),
    referralSource: z.string().trim().max(120).optional(),
  }).optional(),
  sourceType: z.enum(['direct', 'attendance', 'evangelism', 'transfer']).default('direct'),
  sourceRecordId: z.string().trim().max(191).optional(),
  consentStatus: z.literal('yes'),
  consentAt: z.string().datetime().optional(),
  notes: z.string().trim().max(4000).optional(),
}).refine(value => value.existingUserId || value.candidate, {
  message: 'Select an existing user or provide candidate details',
});

const completeRequirementSchema = z.object({
  version: z.number().int().positive(),
  note: z.string().trim().max(4000).optional(),
});

const advanceStageSchema = z.object({ version: z.number().int().positive() });

async function requestScope(req: Request) {
  const user = req.user!;
  const ids = await getAccessibleChurchIds(
    user.role,
    user.churchId,
    user.districts,
    user.traditionalAuthorities,
    user.regions,
    user.userId,
  );
  return ids;
}

async function scopedChurch(req: Request, churchId: string) {
  const accessible = await requestScope(req);
  if (!accessible.includes(churchId)) return null;
  return prisma.church.findFirst({
    where: { id: churchId, status: 'active' },
    select: { id: true, ministryAdminId: true, memberApprovalMode: true },
  });
}

function journeyCode() {
  return `DJ-${new Date().getUTCFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function safeUserSelect() {
  return {
    id: true,
    firstName: true,
    lastName: true,
    email: true,
    phone: true,
    membershipType: true,
    membershipApprovalStatus: true,
    loginEnabled: true,
  } as const;
}

export async function listWorkflows(req: Request, res: Response) {
  const churchIds = await requestScope(req);
  const requestedChurchId = typeof req.query.churchId === 'string' ? req.query.churchId : undefined;
  const allowedChurchIds = requestedChurchId && churchIds.includes(requestedChurchId) ? [requestedChurchId] : churchIds;
  const workflows = await prisma.discipleshipWorkflow.findMany({
    where: { churchId: { in: allowedChurchIds }, status: req.query.includeDrafts === 'true' ? undefined : 'published' },
    include: { stages: { orderBy: { position: 'asc' }, include: { requirements: { orderBy: { position: 'asc' } } } }, church: { select: { id: true, name: true } } },
    orderBy: [{ churchId: 'asc' }, { name: 'asc' }, { version: 'desc' }],
  });
  res.json({ success: true, data: workflows });
}

export async function createWorkflow(req: Request, res: Response) {
  const parsed = workflowSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || 'Invalid workflow' });
    return;
  }
  const church = await scopedChurch(req, parsed.data.churchId);
  if (!church?.ministryAdminId) {
    res.status(404).json({ success: false, message: 'Church not found' });
    return;
  }
  const existingVersion = await prisma.discipleshipWorkflow.aggregate({
    where: { churchId: church.id, name: parsed.data.name },
    _max: { version: true },
  });
  const workflow = await prisma.$transaction(async tx => {
    if (parsed.data.isDefault) {
      await tx.discipleshipWorkflow.updateMany({ where: { churchId: church.id, isDefault: true }, data: { isDefault: false } });
    }
    return tx.discipleshipWorkflow.create({
      data: {
        ministryAdminId: church.ministryAdminId!,
        churchId: church.id,
        name: parsed.data.name,
        description: parsed.data.description,
        status: parsed.data.publish ? 'published' : 'draft',
        version: (existingVersion._max.version || 0) + 1,
        isDefault: parsed.data.isDefault,
        stages: {
          create: parsed.data.stages.map((stage, stageIndex) => ({
            name: stage.name,
            description: stage.description,
            position: stageIndex + 1,
            requirements: {
              create: stage.requirements.map((requirement, requirementIndex) => ({
                ...requirement,
                position: requirementIndex + 1,
              })),
            },
          })),
        },
      },
      include: { stages: { orderBy: { position: 'asc' }, include: { requirements: { orderBy: { position: 'asc' } } } } },
    });
  });
  res.status(201).json({ success: true, data: workflow });
}

export async function listJourneys(req: Request, res: Response) {
  const churchIds = await requestScope(req);
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 25));
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const churchId = typeof req.query.churchId === 'string' && churchIds.includes(req.query.churchId) ? req.query.churchId : undefined;
  const where: any = {
    churchId: churchId || { in: churchIds },
    ...(req.user!.role === 'discipleship_candidate' ? { candidateUserId: req.user!.userId } : {}),
    ...(status ? { status } : {}),
    ...(search ? { candidateUser: { OR: [
      { firstName: { contains: search } }, { lastName: { contains: search } },
      { email: { contains: search } }, { phone: { contains: search } },
    ] } } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.discipleshipJourney.findMany({
      where,
      select: {
        id: true, journeyCode: true, status: true, progressPercent: true, currentStageId: true,
        startedAt: true, updatedAt: true, version: true,
        candidateUser: { select: safeUserSelect() },
        church: { select: { id: true, name: true } },
        workflow: { select: { id: true, name: true, version: true } },
        stages: { where: { status: 'active' }, select: { id: true, name: true, position: true }, take: 1 },
      },
      orderBy: { updatedAt: 'desc' }, skip: (page - 1) * limit, take: limit,
    }),
    prisma.discipleshipJourney.count({ where }),
  ]);
  res.json({ success: true, data: items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
}

export async function createJourney(req: Request, res: Response) {
  const parsed = journeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || 'Invalid journey' });
    return;
  }
  const church = await scopedChurch(req, parsed.data.churchId);
  if (!church?.ministryAdminId) {
    res.status(404).json({ success: false, message: 'Church not found' });
    return;
  }
  const workflow = await prisma.discipleshipWorkflow.findFirst({
    where: { id: parsed.data.workflowId, churchId: church.id, status: 'published' },
    include: { stages: { orderBy: { position: 'asc' }, include: { requirements: { orderBy: { position: 'asc' } } } } },
  });
  if (!workflow || workflow.stages.length === 0) {
    res.status(422).json({ success: false, message: 'A published workflow with at least one stage is required' });
    return;
  }

  try {
    const result = await prisma.$transaction(async tx => {
      let candidateUser;
      if (parsed.data.existingUserId) {
        candidateUser = await tx.user.findFirst({ where: { id: parsed.data.existingUserId, churchId: church.id, status: 'active' } });
        if (!candidateUser) throw new Error('CANDIDATE_NOT_FOUND');
      } else {
        const candidateRole = await tx.role.findUnique({ where: { name: 'discipleship_candidate' } });
        if (!candidateRole) throw new Error('CANDIDATE_ROLE_MISSING');
        const existingEmail = await tx.user.findUnique({ where: { email: parsed.data.candidate!.email } });
        if (existingEmail) throw new Error('EMAIL_EXISTS');
        candidateUser = await tx.user.create({
          data: {
            email: parsed.data.candidate!.email,
            password: await hashPassword(crypto.randomBytes(32).toString('hex')),
            firstName: parsed.data.candidate!.firstName,
            lastName: parsed.data.candidate!.lastName,
            phone: parsed.data.candidate!.phone,
            churchId: church.id,
            ministryAdminId: church.ministryAdminId,
            roleId: candidateRole.id,
            membershipType: 'Candidate',
            membershipApprovalStatus: 'pending',
            loginEnabled: false,
            emailVerified: false,
          },
        });
      }
      const existingActive = await tx.discipleshipJourney.findFirst({
        where: { candidateUserId: candidateUser.id, churchId: church.id, status: { in: ['invited', 'active', 'paused'] } },
        select: { id: true },
      });
      if (existingActive) throw new Error('ACTIVE_JOURNEY_EXISTS');
      const profile = await tx.discipleshipCandidateProfile.upsert({
        where: { userId: candidateUser.id },
        update: {
          owningChurchId: church.id,
          preferredLanguage: parsed.data.candidate?.preferredLanguage,
          referralSource: parsed.data.candidate?.referralSource,
          status: 'active',
        },
        create: {
          userId: candidateUser.id,
          ministryAdminId: church.ministryAdminId!,
          owningChurchId: church.id,
          preferredLanguage: parsed.data.candidate?.preferredLanguage,
          referralSource: parsed.data.candidate?.referralSource,
        },
      });
      await tx.discipleshipIntake.create({
        data: {
          candidateId: profile.id, churchId: church.id, sourceType: parsed.data.sourceType,
          sourceRecordId: parsed.data.sourceRecordId, consentStatus: 'yes',
          consentAt: parsed.data.consentAt ? new Date(parsed.data.consentAt) : new Date(),
          consentById: req.user!.userId, notes: parsed.data.notes,
        },
      });
      const journey = await tx.discipleshipJourney.create({
        data: {
          journeyCode: journeyCode(), ministryAdminId: church.ministryAdminId!, churchId: church.id,
          candidateId: profile.id, candidateUserId: candidateUser.id, workflowId: workflow.id,
          status: 'active', createdById: req.user!.userId,
          stages: { create: workflow.stages.map((stage, index) => ({
            sourceStageId: stage.id, name: stage.name, description: stage.description, position: stage.position,
            status: index === 0 ? 'active' : 'not_started', startedAt: index === 0 ? new Date() : null,
            requirements: { create: stage.requirements.map(requirement => ({
              sourceRequirementId: requirement.id, name: requirement.name, description: requirement.description,
              type: requirement.type, isRequired: requirement.isRequired, position: requirement.position,
            })) },
          })) },
        },
        include: { stages: { orderBy: { position: 'asc' } } },
      });
      const firstStage = journey.stages[0];
      const updated = await tx.discipleshipJourney.update({ where: { id: journey.id }, data: { currentStageId: firstStage.id } });
      await tx.discipleshipAuditEvent.create({ data: {
        ministryAdminId: church.ministryAdminId!, churchId: church.id, journeyId: journey.id,
        actorUserId: req.user!.userId, action: 'journey.created', entityType: 'journey', entityId: journey.id,
        metadata: { workflowId: workflow.id, candidateUserId: candidateUser.id },
      } });
      return updated;
    });
    res.status(201).json({ success: true, data: result });
  } catch (error: any) {
    const messages: Record<string, [number, string]> = {
      CANDIDATE_NOT_FOUND: [404, 'Candidate user not found in this church'],
      CANDIDATE_ROLE_MISSING: [500, 'Candidate role is not configured'],
      EMAIL_EXISTS: [409, 'A user with this email already exists; select that user instead'],
      ACTIVE_JOURNEY_EXISTS: [409, 'This user already has an active discipleship journey'],
    };
    const known = messages[error.message];
    if (known) { res.status(known[0]).json({ success: false, message: known[1] }); return; }
    throw error;
  }
}

export async function getJourney(req: Request, res: Response) {
  const journeyId = String(req.params.id);
  const churchIds = await requestScope(req);
  const journey = await prisma.discipleshipJourney.findFirst({
    where: {
      id: journeyId,
      churchId: { in: churchIds },
      ...(req.user!.role === 'discipleship_candidate' ? { candidateUserId: req.user!.userId } : {}),
    },
    include: {
      candidateUser: { select: safeUserSelect() },
      candidate: true,
      church: { select: { id: true, name: true, timezone: true } },
      workflow: { select: { id: true, name: true, version: true } },
      stages: { orderBy: { position: 'asc' }, include: { requirements: { orderBy: { position: 'asc' } } } },
      auditEvents: { orderBy: { createdAt: 'desc' }, take: 20, include: { actor: { select: { id: true, firstName: true, lastName: true } } } },
    },
  });
  if (!journey) { res.status(404).json({ success: false, message: 'Journey not found' }); return; }
  const currentStage = journey.stages.find(stage => stage.id === journey.currentStageId) || null;
  const blockingRequirements = currentStage?.requirements.filter(item => item.isRequired && item.status === 'pending') || [];
  res.json({ success: true, data: {
    ...journey,
    currentStage,
    blockingRequirements,
    availableActions: {
      canCompleteRequirement: journey.status === 'active',
      canAdvance: journey.status === 'active' && blockingRequirements.length === 0 && !!currentStage,
      canCompleteJourney: journey.status === 'active' && journey.progressPercent === 100,
    },
  } });
}

async function recalculateProgress(tx: any, journeyId: string) {
  const stages = await tx.discipleshipJourneyStage.findMany({
    where: { journeyId }, include: { requirements: true }, orderBy: { position: 'asc' },
  });
  const requirements = stages.flatMap((stage: any) => stage.requirements).filter((item: any) => item.isRequired);
  const completed = requirements.filter((item: any) => item.status !== 'pending').length;
  return requirements.length ? Math.round((completed / requirements.length) * 100) : 0;
}

export async function completeRequirement(req: Request, res: Response) {
  const journeyId = String(req.params.id);
  const requirementId = String(req.params.requirementId);
  const parsed = completeRequirementSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: 'A current journey version is required' }); return; }
  const churchIds = await requestScope(req);
  const requirement = await prisma.discipleshipJourneyRequirement.findFirst({
    where: { id: requirementId, journeyStage: { journey: { id: journeyId, churchId: { in: churchIds } } } },
    include: { journeyStage: { include: { journey: true } } },
  });
  if (!requirement) { res.status(404).json({ success: false, message: 'Requirement not found' }); return; }
  if (requirement.journeyStage.journey.version !== parsed.data.version) {
    res.status(409).json({ success: false, code: 'JOURNEY_VERSION_CONFLICT', message: 'The journey changed. Refresh and try again.' }); return;
  }
  if (requirement.type !== 'checklist') {
    res.status(422).json({ success: false, message: 'This requirement type needs its dedicated completion process' }); return;
  }
  const journey = await prisma.$transaction(async tx => {
    await tx.discipleshipJourneyRequirement.update({ where: { id: requirement.id }, data: {
      status: 'completed', completedById: req.user!.userId, completionNote: parsed.data.note, completedAt: new Date(),
    } });
    const progressPercent = await recalculateProgress(tx, journeyId);
    const updated = await tx.discipleshipJourney.updateMany({
      where: { id: journeyId, version: parsed.data.version },
      data: { progressPercent, version: { increment: 1 } },
    });
    if (!updated.count) throw new Error('VERSION_CONFLICT');
    await tx.discipleshipAuditEvent.create({ data: {
      ministryAdminId: requirement.journeyStage.journey.ministryAdminId,
      churchId: requirement.journeyStage.journey.churchId, journeyId,
      actorUserId: req.user!.userId, action: 'requirement.completed', entityType: 'requirement', entityId: requirement.id,
    } });
    return tx.discipleshipJourney.findUnique({ where: { id: journeyId } });
  });
  res.json({ success: true, data: journey });
}

export async function advanceStage(req: Request, res: Response) {
  const journeyId = String(req.params.id);
  const parsed = advanceStageSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: 'A current journey version is required' }); return; }
  const churchIds = await requestScope(req);
  const journey = await prisma.discipleshipJourney.findFirst({
    where: { id: journeyId, churchId: { in: churchIds } },
    include: {
      stages: { orderBy: { position: 'asc' }, include: { requirements: true } },
      church: { select: { memberApprovalMode: true } },
      candidateUser: { select: { id: true, membershipType: true, role: { select: { name: true } } } },
    },
  });
  if (!journey) { res.status(404).json({ success: false, message: 'Journey not found' }); return; }
  if (journey.version !== parsed.data.version) { res.status(409).json({ success: false, code: 'JOURNEY_VERSION_CONFLICT', message: 'The journey changed. Refresh and try again.' }); return; }
  const currentIndex = journey.stages.findIndex(stage => stage.id === journey.currentStageId);
  const current = journey.stages[currentIndex];
  if (!current) { res.status(422).json({ success: false, message: 'Journey has no active stage' }); return; }
  const blocking = current.requirements.filter(item => item.isRequired && item.status === 'pending');
  if (blocking.length) {
    res.status(422).json({ success: false, code: 'JOURNEY_STAGE_BLOCKED', message: 'Complete the required items before advancing.', details: { blockingRequirements: blocking.map(item => ({ id: item.id, name: item.name })) } }); return;
  }
  const next = journey.stages[currentIndex + 1];
  if (!next && journey.candidateUser.membershipType !== 'Member') {
    const memberLimit = await checkMemberLimit(journey.ministryAdminId, journey.churchId);
    if (!memberLimit.allowed) {
      res.status(422).json({ success: false, code: 'MEMBER_LIMIT_REACHED', message: memberLimit.message || 'The membership package limit has been reached.' });
      return;
    }
  }
  const updated = await prisma.$transaction(async tx => {
    await tx.discipleshipJourneyStage.update({ where: { id: current.id }, data: { status: 'completed', completedAt: new Date() } });
    if (next) await tx.discipleshipJourneyStage.update({ where: { id: next.id }, data: { status: 'active', startedAt: new Date() } });
    const result = await tx.discipleshipJourney.updateMany({ where: { id: journey.id, version: parsed.data.version }, data: {
      currentStageId: next?.id || null,
      status: next ? 'active' : 'completed',
      progressPercent: next ? journey.progressPercent : 100,
      completedAt: next ? null : new Date(),
      version: { increment: 1 },
    } });
    if (!result.count) throw new Error('VERSION_CONFLICT');
    if (!next) {
      const userUpdate: any = {
        membershipType: 'Member',
        membershipApprovalStatus: journey.church.memberApprovalMode === 'manual' ? 'pending' : 'approved',
      };
      if (journey.candidateUser.role?.name === 'discipleship_candidate') {
        const memberRole = await tx.role.findUnique({ where: { name: 'member' }, select: { id: true } });
        if (!memberRole) throw new Error('MEMBER_ROLE_MISSING');
        userUpdate.roleId = memberRole.id;
      }
      await tx.user.update({ where: { id: journey.candidateUserId }, data: userUpdate });
      await tx.discipleshipCandidateProfile.update({ where: { id: journey.candidateId }, data: { status: 'completed' } });
    }
    await tx.discipleshipAuditEvent.create({ data: {
      ministryAdminId: journey.ministryAdminId, churchId: journey.churchId, journeyId: journey.id,
      actorUserId: req.user!.userId, action: next ? 'stage.advanced' : 'journey.completed',
      entityType: next ? 'stage' : 'journey', entityId: next?.id || journey.id,
    } });
    return tx.discipleshipJourney.findUnique({ where: { id: journey.id } });
  });
  res.json({ success: true, data: updated });
}
