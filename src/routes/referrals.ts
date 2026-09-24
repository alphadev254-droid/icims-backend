import { Router } from 'express';
import {
  getMyReferrerDashboard,
  getMyReferrerReferrals,
  getMyReferrerWallet,
  getMyPayoutOptions,
  getAdminReferrer,
  listAdminReferrers,
  registerReferrer,
  requestPayoutSetupOtp,
  updateMyPayoutSetup,
  verifyPayoutSetupOtp,
  updateAdminReferrerStatus,
} from '../controllers/referralController';
import { authenticate, authorize } from '../middleware/auth';

const router = Router();

router.post('/register', registerReferrer);
router.get('/me', authenticate, authorize('referrer'), getMyReferrerDashboard);
router.get('/me/referrals', authenticate, authorize('referrer'), getMyReferrerReferrals);
router.get('/me/wallet', authenticate, authorize('referrer'), getMyReferrerWallet);
router.get('/payout-options', authenticate, authorize('referrer'), getMyPayoutOptions);
router.post('/payout-setup/otp', authenticate, authorize('referrer'), requestPayoutSetupOtp);
router.post('/payout-setup/otp/verify', authenticate, authorize('referrer'), verifyPayoutSetupOtp);
router.put('/payout-setup', authenticate, authorize('referrer'), updateMyPayoutSetup);
router.get('/admin/referrers', authenticate, authorize('ministry_admin', 'system_admin'), listAdminReferrers);
router.get('/admin/referrers/:id', authenticate, authorize('ministry_admin', 'system_admin'), getAdminReferrer);
router.patch('/admin/referrers/:id/status', authenticate, authorize('ministry_admin', 'system_admin'), updateAdminReferrerStatus);

export default router;

