import { Router } from 'express';
import { authenticate, authorizePermission } from '../middleware/auth';
import { requireFeature } from '../middleware/packageCheck';
import { getCalendarActivities } from '../controllers/calendarController';

const router = Router();

router.use(authenticate);
router.use(requireFeature('calendar'));

router.get('/activities', authorizePermission('calendar:read'), getCalendarActivities);

export default router;
