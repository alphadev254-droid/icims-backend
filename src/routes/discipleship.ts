import { Router } from 'express';
import { authenticate, authorizePermission } from '../middleware/auth';
import { requireFeature } from '../middleware/packageCheck';
import {
  advanceStage,
  completeRequirement,
  createJourney,
  createWorkflow,
  getJourney,
  listJourneys,
  listWorkflows,
  updateWorkflow,
} from '../controllers/discipleshipController';
import {
  addMentorFollowUp, assignMentor, checkInByCode, createClass, createCourse, createRequirementDefinition, enrollCandidate,
  dispatchDiscipleshipReminders, getDiscipleshipReport, listBelongingPrompts, listCourses, listRequirementDefinitions, recordSessionAttendance, savePlacement, syncAttendanceIntake, updateBelongingPrompt,
} from '../controllers/discipleshipOperationsController';

const router = Router();
router.use(authenticate);
router.use(requireFeature('discipleship_management'));

router.get('/workflows', authorizePermission('discipleship_workflows:read'), listWorkflows);
router.post('/workflows', authorizePermission('discipleship_workflows:manage'), createWorkflow);
router.put('/workflows/:id', authorizePermission('discipleship_workflows:manage'), updateWorkflow);
router.get('/courses', authorizePermission('discipleship_courses:read'), listCourses);
router.post('/courses', authorizePermission('discipleship_courses:manage'), createCourse);
router.post('/courses/:courseId/classes', authorizePermission('discipleship_courses:manage'), createClass);
router.get('/requirement-definitions', authorizePermission('discipleship_courses:read'), listRequirementDefinitions);
router.post('/requirement-definitions', authorizePermission('discipleship_courses:manage'), createRequirementDefinition);
router.post('/classes/:classId/enrollments', authorizePermission('discipleship_courses:manage'), enrollCandidate);
router.post('/sessions/:sessionId/attendance', authorizePermission('discipleship_attendance:manage'), recordSessionAttendance);
router.post('/attendance/check-in', authorizePermission('discipleship_attendance:checkin'), checkInByCode);
router.get('/reports/summary', authorizePermission('discipleship_reports:read'), getDiscipleshipReport);
router.post('/notifications/dispatch', authorizePermission('discipleship_courses:manage'), dispatchDiscipleshipReminders);
router.post('/intake/sync-attendance', authorizePermission('discipleship_journeys:create'), syncAttendanceIntake);
router.get('/intake/prompts', authorizePermission('discipleship_journeys:read'), listBelongingPrompts);
router.patch('/intake/prompts/:promptId', authorizePermission('discipleship_journeys:update'), updateBelongingPrompt);
router.get('/journeys', authorizePermission('discipleship_journeys:read'), listJourneys);
router.post('/journeys', authorizePermission('discipleship_journeys:create'), createJourney);
router.get('/journeys/:id', authorizePermission('discipleship_journeys:read'), getJourney);
router.post('/journeys/:id/requirements/:requirementId/complete', authorizePermission('discipleship_journeys:update'), completeRequirement);
router.post('/journeys/:id/advance', authorizePermission('discipleship_journeys:advance'), advanceStage);
router.post('/journeys/:id/mentor', authorizePermission('discipleship_mentors:manage'), assignMentor);
router.post('/journeys/:id/mentor/follow-ups', authorizePermission('discipleship_mentors:manage'), addMentorFollowUp);
router.put('/journeys/:id/placement', authorizePermission('discipleship_journeys:update'), savePlacement);

export default router;
