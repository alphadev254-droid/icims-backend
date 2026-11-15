import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { getAccessibleChurchIds } from '../lib/churchScope';

const optionSchema = z.object({ id: z.string().trim().min(1).max(80), text: z.string().trim().min(1).max(500) });
const questionSchema = z.object({
  prompt: z.string().trim().min(1).max(5000),
  type: z.enum(['single_choice', 'multiple_choice', 'true_false']),
  options: z.array(optionSchema).min(2).max(10),
  correctAnswerIds: z.array(z.string().trim().min(1)).min(1).max(10),
  points: z.number().positive().max(1000).default(1),
  explanation: z.string().trim().max(5000).optional(),
}).superRefine((question, ctx) => {
  const optionIds = new Set(question.options.map(option => option.id));
  if (optionIds.size !== question.options.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Option identifiers must be unique', path: ['options'] });
  if (question.correctAnswerIds.some(id => !optionIds.has(id))) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Every correct answer must match an option', path: ['correctAnswerIds'] });
  if (question.type !== 'multiple_choice' && question.correctAnswerIds.length !== 1) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'This question type requires exactly one correct answer', path: ['correctAnswerIds'] });
});
const questionSetSchema = z.object({ questions: z.array(questionSchema).min(1).max(100) });
const submissionSchema = z.object({
  answers: z.array(z.object({ questionId: z.string().min(1), selectedOptionIds: z.array(z.string().min(1)).max(10) })).max(100),
});

async function requestChurchIds(req: Request) {
  const user = req.user!;
  return getAccessibleChurchIds(user.role, user.churchId, user.districts, user.traditionalAuthorities, user.regions, user.userId);
}

function churchIds(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

async function visibleDefinition(req: Request, definitionId: string) {
  const accessible = await requestChurchIds(req);
  const definition = await prisma.discipleshipRequirementDefinition.findUnique({ where: { id: definitionId }, include: { questions: { orderBy: { position: 'asc' } } } });
  return definition && churchIds(definition.churchIds).some(id => accessible.includes(id)) ? definition : null;
}

export async function getAssessmentQuestions(req: Request, res: Response) {
  const definition = await visibleDefinition(req, String(req.params.definitionId));
  if (!definition || definition.type !== 'assessment') { res.status(404).json({ success: false, message: 'Assessment not found' }); return; }
  res.json({ success: true, data: { definitionId: definition.id, title: definition.title, passScore: definition.passScore, maxScore: definition.maxScore, questions: definition.questions.map(question => ({
    id: question.id, prompt: question.prompt, type: question.type, options: question.options, correctAnswerIds: question.correctAnswers, points: question.points, explanation: question.explanation, position: question.position,
  })) } });
}

export async function replaceAssessmentQuestions(req: Request, res: Response) {
  const parsed = questionSetSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || 'Invalid assessment questions' }); return; }
  const definition = await visibleDefinition(req, String(req.params.definitionId));
  if (!definition || definition.type !== 'assessment') { res.status(404).json({ success: false, message: 'Assessment not found' }); return; }
  const attempts = await prisma.discipleshipAssessmentAttempt.count({ where: { definitionId: definition.id } });
  if (attempts) { res.status(409).json({ success: false, message: 'Questions cannot be replaced after candidates have submitted this assessment. Create a new assessment version instead.' }); return; }
  const questions = await prisma.$transaction(async tx => {
    await tx.discipleshipAssessmentQuestion.deleteMany({ where: { definitionId: definition.id } });
    await tx.discipleshipAssessmentQuestion.createMany({ data: parsed.data.questions.map((question, index) => ({
      definitionId: definition.id, prompt: question.prompt, type: question.type, options: question.options,
      correctAnswers: question.correctAnswerIds, points: question.points, explanation: question.explanation, position: index + 1,
    })) });
    return tx.discipleshipAssessmentQuestion.findMany({ where: { definitionId: definition.id }, orderBy: { position: 'asc' } });
  });
  res.json({ success: true, data: questions });
}

async function scopedAssessmentRequirement(req: Request, journeyId: string, requirementId: string) {
  const accessible = await requestChurchIds(req);
  return prisma.discipleshipJourneyRequirement.findFirst({
    where: {
      id: requirementId,
      type: 'assessment',
      journeyStage: { journey: { id: journeyId, churchId: { in: accessible }, ...(req.user!.role === 'discipleship_candidate' ? { candidateUserId: req.user!.userId } : {}) } },
    },
    include: { journeyStage: { include: { journey: true } } },
  });
}

export async function getJourneyAssessment(req: Request, res: Response) {
  const requirement = await scopedAssessmentRequirement(req, String(req.params.id), String(req.params.requirementId));
  if (!requirement?.definitionId) { res.status(404).json({ success: false, message: 'Assessment requirement not found' }); return; }
  const definition = await prisma.discipleshipRequirementDefinition.findUnique({ where: { id: requirement.definitionId }, include: { questions: { orderBy: { position: 'asc' } } } });
  if (!definition || !definition.questions.length) { res.status(422).json({ success: false, message: 'This assessment has no published questions yet' }); return; }
  const attempts = await prisma.discipleshipAssessmentAttempt.findMany({ where: { journeyId: requirement.journeyStage.journeyId, requirementId: requirement.id }, orderBy: { submittedAt: 'desc' }, select: { id: true, score: true, passed: true, submittedAt: true } });
  res.json({ success: true, data: {
    definitionId: definition.id, title: definition.title, description: definition.description, passScore: definition.passScore ?? 0, maxScore: definition.maxScore ?? 100,
    status: requirement.status, attempts,
    questions: definition.questions.map(question => ({ id: question.id, prompt: question.prompt, type: question.type, options: question.options, points: question.points, position: question.position })),
  } });
}

export async function submitJourneyAssessment(req: Request, res: Response) {
  const parsed = submissionSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || 'Invalid assessment submission' }); return; }
  const journeyId = String(req.params.id); const requirementId = String(req.params.requirementId);
  const requirement = await scopedAssessmentRequirement(req, journeyId, requirementId);
  if (!requirement?.definitionId) { res.status(404).json({ success: false, message: 'Assessment requirement not found' }); return; }
  if (requirement.status !== 'pending') { res.status(409).json({ success: false, message: 'This assessment requirement is already completed' }); return; }
  if (requirement.journeyStage.journey.status !== 'active') { res.status(422).json({ success: false, message: 'The journey must be active before submitting an assessment' }); return; }
  const definition = await prisma.discipleshipRequirementDefinition.findUnique({ where: { id: requirement.definitionId }, include: { questions: { orderBy: { position: 'asc' } } } });
  if (!definition || !definition.questions.length) { res.status(422).json({ success: false, message: 'This assessment has no questions' }); return; }
  const answerMap = new Map(parsed.data.answers.map(answer => [answer.questionId, [...new Set(answer.selectedOptionIds)].sort()]));
  if (definition.questions.some(question => !answerMap.has(question.id))) { res.status(422).json({ success: false, message: 'Answer every question before submitting' }); return; }
  const unknownQuestion = parsed.data.answers.some(answer => !definition.questions.some(question => question.id === answer.questionId));
  if (unknownQuestion) { res.status(422).json({ success: false, message: 'The submission contains a question that is not part of this assessment' }); return; }

  let pointsEarned = 0; const pointsAvailable = definition.questions.reduce((sum, question) => sum + question.points, 0);
  const gradedAnswers = definition.questions.map(question => {
    const selected = answerMap.get(question.id) || [];
    const correct = Array.isArray(question.correctAnswers) ? question.correctAnswers.filter((item): item is string => typeof item === 'string').sort() : [];
    const isCorrect = selected.length === correct.length && selected.every((value, index) => value === correct[index]);
    if (isCorrect) pointsEarned += question.points;
    return { questionId: question.id, selectedOptionIds: selected, correctAnswerIds: correct, isCorrect, explanation: question.explanation };
  });
  const maxScore = definition.maxScore ?? 100;
  const score = pointsAvailable ? Math.round((pointsEarned / pointsAvailable) * maxScore * 100) / 100 : 0;
  const passed = score >= (definition.passScore ?? 0);
  const journey = requirement.journeyStage.journey;
  const result = await prisma.$transaction(async tx => {
    const attempt = await tx.discipleshipAssessmentAttempt.create({ data: {
      definitionId: definition.id, journeyId, requirementId, candidateUserId: journey.candidateUserId,
      score, pointsEarned, pointsAvailable, passed, answers: gradedAnswers,
    } });
    await tx.discipleshipJourneyRequirement.update({ where: { id: requirement.id }, data: {
      assessmentScore: score, assessmentPassed: passed,
      completionNote: passed ? 'Completed automatically from the question-based assessment.' : 'Assessment submitted below the required pass score.',
      ...(passed ? { status: 'completed', completedById: req.user!.userId, completedAt: new Date() } : {}),
    } });
    const stages = await tx.discipleshipJourneyStage.findMany({ where: { journeyId }, include: { requirements: true } });
    const required = stages.flatMap(stage => stage.requirements).filter(item => item.isRequired);
    const completed = required.filter(item => item.id === requirement.id ? passed : item.status !== 'pending').length;
    const progressPercent = required.length ? Math.round(completed / required.length * 100) : 0;
    const updatedJourney = await tx.discipleshipJourney.update({ where: { id: journeyId }, data: { progressPercent, version: { increment: 1 } } });
    await tx.discipleshipAuditEvent.create({ data: {
      ministryAdminId: journey.ministryAdminId, churchId: journey.churchId, journeyId, actorUserId: req.user!.userId,
      action: passed ? 'assessment.passed' : 'assessment.failed', entityType: 'assessment_attempt', entityId: attempt.id,
      metadata: { requirementId, definitionId: definition.id, score, pointsEarned, pointsAvailable },
    } });
    return { attempt, journeyVersion: updatedJourney.version };
  });
  res.status(201).json({ success: true, data: { id: result.attempt.id, score, maxScore, passScore: definition.passScore ?? 0, passed, pointsEarned, pointsAvailable, answers: gradedAnswers, journeyVersion: result.journeyVersion } });
}
