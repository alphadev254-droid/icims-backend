import { Router } from 'express';
import { authenticate, authorizePermission } from '../middleware/auth';
import {
  createService,
  deleteService,
  getService,
  listServices,
  updateService,
} from '../controllers/serviceController';
import {
  getProgram,
  saveProgram,
  deleteProgram,
  searchProgramPeople,
} from '../controllers/programController';
import { requireFeature } from '../middleware/packageCheck';

const router = Router();
router.use(authenticate);
router.use(requireFeature('attendance_tracking'));
router.get('/', authorizePermission('attendance:read'), listServices);
router.post('/', authorizePermission('attendance:create'), createService);
router.get('/:id', authorizePermission('attendance:read'), getService);
router.put('/:id', authorizePermission('attendance:update'), updateService);
router.delete('/:id', authorizePermission('attendance:update'), deleteService);
router.get('/:id/program', authorizePermission('attendance:read'), getProgram);
router.put(
  '/:id/program',
  authorizePermission('attendance:update'),
  saveProgram,
);
router.delete(
  '/:id/program',
  authorizePermission('attendance:update'),
  deleteProgram,
);
router.get(
  '/:id/program/people',
  authorizePermission('attendance:read'),
  searchProgramPeople,
);
export default router;
