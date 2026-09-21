import { Router } from 'express';
import {
  confirmWithdrawal,
  getMyReferrerDashboard,
  getMyPayoutOptions,
  listAdminReferrers,
  registerReferrer,
  requestWithdrawalOtp,
  updateMyPayoutSetup,
  updateAdminReferrerStatus,
} from '../controllers/referralController';
import { authenticate, authorize } from '../middleware/auth';

const router = Router();

router.post('/register', registerReferrer);
router.get('/me', authenticate, authorize('referrer'), getMyReferrerDashboard);
router.get('/payout-options', authenticate, authorize('referrer'), getMyPayoutOptions);
router.put('/payout-setup', authenticate, authorize('referrer'), updateMyPayoutSetup);
router.post('/withdrawals/otp', authenticate, authorize('referrer'), requestWithdrawalOtp);
router.post('/withdrawals', authenticate, authorize('referrer'), confirmWithdrawal);
router.get('/admin/referrers', authenticate, authorize('ministry_admin', 'system_admin'), listAdminReferrers);
router.patch('/admin/referrers/:id/status', authenticate, authorize('ministry_admin', 'system_admin'), updateAdminReferrerStatus);

export default router;
