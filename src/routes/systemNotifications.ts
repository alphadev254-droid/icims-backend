import { Router } from 'express';
import { authenticate, authorizePermission } from '../middleware/auth';
import { getUnreadSystemNotificationCount, listSystemNotifications, markAllSystemNotificationsRead, markSystemNotificationRead } from '../controllers/systemNotificationController';

const router = Router();
router.use(authenticate);
router.get('/', authorizePermission('system_notifications:read'), listSystemNotifications);
router.get('/unread-count', authorizePermission('system_notifications:read'), getUnreadSystemNotificationCount);
router.post('/read-all', authorizePermission('system_notifications:acknowledge'), markAllSystemNotificationsRead);
router.post('/:id/read', authorizePermission('system_notifications:acknowledge'), markSystemNotificationRead);
export default router;
