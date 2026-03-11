import { Router } from 'express';
import { getChurches, getChurch, createChurch, updateChurch, deleteChurch, generateInviteLink, getChurchByInvite } from '../controllers/churchController';
import { authenticate, authorizePermission } from '../middleware/auth';

const router = Router();

router.get('/by-invite/:token', getChurchByInvite);
router.use(authenticate);

router.get('/',      authorizePermission('churches:read'),   getChurches);
router.get('/:id',   authorizePermission('churches:read'),   getChurch);
router.post('/',     authorizePermission('churches:create'), createChurch);
router.post('/:id/generate-invite', authorizePermission('churches:invite'), generateInviteLink);
router.put('/:id',   authorizePermission('churches:update'), updateChurch);
router.delete('/:id', authorizePermission('churches:delete'), deleteChurch);

export default router;
