import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import * as reminderController from '../controllers/reminderController';

const router = Router();

router.get('/upcoming', authenticate, reminderController.getReminders);
router.get('/today', authenticate, reminderController.getTodayReminders);
router.get('/scheduled', authenticate, reminderController.getScheduledReminders);
router.post('/scheduled', authenticate, reminderController.createScheduledReminder);
router.get('/scheduled/logs', authenticate, reminderController.getScheduledReminderLogs);
router.put('/scheduled/:id', authenticate, reminderController.updateScheduledReminder);
router.delete('/scheduled/:id', authenticate, reminderController.deleteScheduledReminder);

export default router;
