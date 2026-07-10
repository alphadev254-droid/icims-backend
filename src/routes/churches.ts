import { Router } from 'express';
import { getChurches, getChurch, getChurchSelect, createChurch, updateChurch, deleteChurch, generateInviteLink, getChurchByInvite } from '../controllers/churchController';
import { authenticate, authorizeAnyPermission, authorizePermission } from '../middleware/auth';
import { uploadImage } from '../middleware/upload';

const router = Router();

const setChurchUploadDir = (req: any, _res: any, next: any) => { req.uploadSubDir = 'churches'; next(); };
const logoUpload = [setChurchUploadDir, uploadImage.single('logo')];

router.get('/by-invite/:token', getChurchByInvite);
router.use(authenticate);

router.get('/select', authorizeAnyPermission([
  'churches:read',
  'churches:create',
  'cells:read',
  'cells:create',
  'cells:update',
  'attendance:read',
  'attendance:create',
  'attendance:update',
  'events:read',
  'events:create',
  'events:update',
  'campaigns:read',
  'campaigns:create',
  'campaigns:update',
  'donations:read',
  'transactions:read',
  'users:read',
  'users:create',
  'users:update',
  'children:read',
  'children:create',
  'children:update',
  'communication:read',
  'communication:create',
  'resources:read',
  'resources:create',
  'reports:read',
  'teams:read',
  'teams:create',
  'teams:update',
  'roles:read',
  'roles:manage',
  'roles:assign',
  'subaccounts:view',
]), getChurchSelect);
router.get('/',      authorizePermission('churches:read'),   getChurches);
router.get('/:id',   authorizePermission('churches:read'),   getChurch);
router.post('/',     authorizePermission('churches:create'), ...logoUpload, createChurch);
router.post('/:id/generate-invite', authorizePermission('churches:invite'), generateInviteLink);
router.put('/:id',   authorizePermission('churches:update'), ...logoUpload, updateChurch);
router.delete('/:id', authorizePermission('churches:delete'), deleteChurch);

export default router;
