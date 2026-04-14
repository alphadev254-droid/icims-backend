import { Router } from 'express';
import { authenticate, authorizePermission } from '../middleware/auth';
import { uploadFiles } from '../middleware/upload';
import { getResources, createResource, updateResource, deleteResource } from '../controllers/resourceController';
import { recordResourceView, getResourceViewStats, getResourceViewers } from '../controllers/contentViewController';

const router = Router();
router.use(authenticate);

router.get('/',               authorizePermission('resources:read'),   getResources);
router.post('/',              authorizePermission('resources:create'), (req, _res, next) => { (req as any).uploadSubDir = 'resources'; next(); }, uploadFiles.array('files', 10), createResource);
router.put('/:id',            authorizePermission('resources:create'), (req, _res, next) => { (req as any).uploadSubDir = 'resources'; next(); }, uploadFiles.array('files', 10), updateResource);
router.delete('/:id',         authorizePermission('resources:create'), deleteResource);
router.post('/:id/view',      authorizePermission('resources:read'),   recordResourceView);
router.get('/:id/view-stats', authorizePermission('resources:read'),   getResourceViewStats);
router.get('/:id/viewers',    authorizePermission('resources:read'),   getResourceViewers);

export default router;
