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
} from '../controllers/discipleshipController';

const router = Router();
router.use(authenticate);
router.use(requireFeature('discipleship_management'));

router.get('/workflows', authorizePermission('discipleship_workflows:read'), listWorkflows);
router.post('/workflows', authorizePermission('discipleship_workflows:manage'), createWorkflow);
router.get('/journeys', authorizePermission('discipleship_journeys:read'), listJourneys);
router.post('/journeys', authorizePermission('discipleship_journeys:create'), createJourney);
router.get('/journeys/:id', authorizePermission('discipleship_journeys:read'), getJourney);
router.post('/journeys/:id/requirements/:requirementId/complete', authorizePermission('discipleship_journeys:update'), completeRequirement);
router.post('/journeys/:id/advance', authorizePermission('discipleship_journeys:advance'), advanceStage);

export default router;
