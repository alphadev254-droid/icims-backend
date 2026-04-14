import { Router } from 'express';
import { getAnnouncements, createAnnouncement, updateAnnouncement, deleteAnnouncement } from '../controllers/announcementController';
import { recordAnnouncementView, getAnnouncementViewStats, getAnnouncementViewers } from '../controllers/contentViewController';
import { authenticate, authorizePermission } from '../middleware/auth';

const router = Router();
router.use(authenticate);

router.get('/',                authorizePermission('communication:read'),   getAnnouncements);
router.post('/',               authorizePermission('communication:create'), createAnnouncement);
router.put('/:id',             authorizePermission('communication:update'), updateAnnouncement);
router.delete('/:id',          authorizePermission('communication:delete'), deleteAnnouncement);
router.post('/:id/view',       authorizePermission('communication:read'),   recordAnnouncementView);
router.get('/:id/view-stats',  authorizePermission('communication:read'),   getAnnouncementViewStats);
router.get('/:id/viewers',     authorizePermission('communication:read'),   getAnnouncementViewers);

export default router;
