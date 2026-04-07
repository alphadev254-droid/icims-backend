import { Router } from 'express';
import { authenticate, authorizeSystemAdmin } from '../middleware/auth';
import {
  getAdminStats,
  getAdminUsers,
  getAdminUser,
  updateAdminUser,
  deleteAdminUser,
  resetAdminUserPassword,
  sendEmailToUser,
  manageAdminSubscription,
  updateAdminSubscription,
  getAdminTransactions,
  getAdminChurch,
  updateAdminChurch,
  deleteAdminChurch,
  updateAdminChurchUser,
} from '../controllers/adminController';

const router = Router();
router.use(authenticate, authorizeSystemAdmin);

router.get('/stats', getAdminStats);

router.get('/users', getAdminUsers);
router.get('/users/:id', getAdminUser);
router.put('/users/:id', updateAdminUser);
router.delete('/users/:id', deleteAdminUser);
router.post('/users/:id/reset-password', resetAdminUserPassword);
router.post('/users/:id/send-email', sendEmailToUser);
router.post('/users/:id/subscription', manageAdminSubscription);
router.put('/users/:id/subscription/:subId', updateAdminSubscription);

router.get('/transactions', getAdminTransactions);

router.get('/churches/:id', getAdminChurch);
router.put('/churches/:id', updateAdminChurch);
router.delete('/churches/:id', deleteAdminChurch);

router.put('/church-users/:id', updateAdminChurchUser);

export default router;
