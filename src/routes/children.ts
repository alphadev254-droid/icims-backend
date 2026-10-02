import { Router } from 'express';
import { authenticate, authorizePermission } from '../middleware/auth';
import { requireFeature } from '../middleware/packageCheck';
import {
  bulkCreateChildren,
  createChild,
  deleteChild,
  getChild,
  getChildren,
  linkGuardian,
  unlinkGuardian,
  updateChild,
  updateGuardianLink,
} from '../controllers/childrenController';

const router = Router();
router.use(authenticate);
router.use(requireFeature('users_management'));

router.get('/', authorizePermission('children:read'), getChildren);
router.post('/', authorizePermission('children:create'), createChild);
router.post('/bulk', authorizePermission('children:create'), bulkCreateChildren);
router.get('/:id', authorizePermission('children:read'), getChild);
router.put('/:id', authorizePermission('children:update'), updateChild);
router.delete('/:id', authorizePermission('children:delete'), deleteChild);

router.post('/:id/guardians', authorizePermission('children:update'), linkGuardian);
router.put('/:id/guardians/:guardianId', authorizePermission('children:update'), updateGuardianLink);
router.delete('/:id/guardians/:guardianId', authorizePermission('children:update'), unlinkGuardian);

export default router;
