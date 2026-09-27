import { Router } from 'express';
import { authenticate, authorizePermission } from '../middleware/auth';
import { requireFeature } from '../middleware/packageCheck';
import {
  approveRegistrationRequest,
  bulkCreateUsers,
  createUser,
  deleteUser,
  getRegistrationRequests,
  getUsers,
  rejectRegistrationRequest,
  updateUser,
} from '../controllers/userController';

const router = Router();
router.use(authenticate);
router.use(requireFeature('users_management'));

router.get('/',      authorizePermission('users:read'),   getUsers);
router.post('/',     authorizePermission('users:create'), createUser);
router.post('/bulk', authorizePermission('users:create'), bulkCreateUsers);
router.get('/registration-requests', authorizePermission('registration_requests:read'), getRegistrationRequests);
router.post('/registration-requests/:id/approve', authorizePermission('registration_requests:approve'), approveRegistrationRequest);
router.post('/registration-requests/:id/reject', authorizePermission('registration_requests:reject'), rejectRegistrationRequest);
router.put('/:id',   authorizePermission('users:update'), updateUser);
router.delete('/:id', authorizePermission('users:delete'), deleteUser);

export default router;
