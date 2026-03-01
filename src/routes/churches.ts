import { Router } from 'express';
import { getChurches, getChurch, createChurch, updateChurch, deleteChurch } from '../controllers/churchController';
import { authenticate, authorizePermission } from '../middleware/auth';
import { checkChurchLimit } from '../middleware/packageCheck';

const router = Router();
router.use(authenticate);

router.get('/',      authorizePermission('churches:read'),   getChurches);
router.get('/:id',   authorizePermission('churches:read'),   getChurch);
router.post('/',     authorizePermission('churches:create'), checkChurchLimit, createChurch);
router.put('/:id',   authorizePermission('churches:update'), updateChurch);
router.delete('/:id', authorizePermission('churches:delete'), deleteChurch);

export default router;
