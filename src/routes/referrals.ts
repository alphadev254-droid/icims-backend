import { Router } from 'express';
import {
  getMyReferrerDashboard,
  getMyPayoutOptions,
  listAdminReferrers,
  registerReferrer,
  updateMyPayoutSetup,
  updateAdminReferrerStatus,
} from '../controllers/referralController';
import { authenticate, authorize } from '../middleware/auth';

const router = Router();

router.post('/register', registerReferrer);
router.get('/me', authenticate, authorize('referrer'), getMyReferrerDashboard);
router.get('/payout-options', authenticate, authorize('referrer'), getMyPayoutOptions);
router.put('/payout-setup', authenticate, authorize('referrer'), updateMyPayoutSetup);
router.get('/admin/referrers', authenticate, authorize('ministry_admin', 'system_admin'), listAdminReferrers);
router.patch('/admin/referrers/:id/status', authenticate, authorize('ministry_admin', 'system_admin'), updateAdminReferrerStatus);

export default router;

