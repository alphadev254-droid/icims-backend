import { Router } from 'express';
import { login, register, logout, getMe, updateProfile } from '../controllers/authController';
import { authenticate } from '../middleware/auth';

const router = Router();

router.post('/login', login);
router.post('/register', register);
router.post('/logout', logout);
router.get('/me', authenticate, getMe);
router.put('/profile', authenticate, updateProfile);

export default router;
