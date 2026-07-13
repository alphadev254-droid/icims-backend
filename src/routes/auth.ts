import { Router } from 'express';
import { login, register, registerMember, logout, getMe, updateProfile, getAttendanceQr } from '../controllers/authController';
import { authenticate } from '../middleware/auth';
import { uploadImage } from '../middleware/upload';

const router = Router();

const setAvatarDir = (req: any, _res: any, next: any) => {
  req.uploadSubDir = 'avatars';
  next();
};

router.post('/login', login);
router.post('/register', register);
router.post('/register/member', registerMember);
router.post('/logout', logout);
router.get('/me', authenticate, getMe);
router.get('/attendance-qr', authenticate, getAttendanceQr);
router.put('/profile', authenticate, setAvatarDir, uploadImage.single('avatar'), updateProfile);

export default router;
