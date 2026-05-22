import { Router } from 'express';
import { registerDeviceToken, unregisterDeviceToken } from '../controllers/pushTokenController';
import { authenticate } from '../middleware/auth';

const router = Router();
router.use(authenticate);

router.post('/register-token', registerDeviceToken);
router.delete('/unregister-token', unregisterDeviceToken);

export default router;
