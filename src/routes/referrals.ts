import { Router } from 'express';
import {
  getMyReferrerDashboard,
  getMyReferrerProfile,
  getMyReferrerReferrals,
  getMyReferrerWallet,
  getMyPayoutOptions,
  getAdminReferrer,
  initiateAdminReferrerWithdrawal,
  listAdminReferrers,
  previewAdminReferrerWithdrawal,
  reconcileAdminReferrerWithdrawal,
  registerReferrer,
  requestPayoutSetupOtp,
  reviewAdminReferrerAgreement,
  updateMyPayoutSetup,
  uploadMyReferrerAgreement,
  verifyPayoutSetupOtp,
  updateAdminReferrerStatus,
} from '../controllers/referralController';
import { authenticate, authorize } from '../middleware/auth';
import { uploadAgreementFile } from '../middleware/upload';

const router = Router();

const setSignedAgreementDir = (req: any, _res: any, next: any) => {
  req.uploadSubDir = 'marketer-agreements/signed';
  next();
};

router.post('/register', registerReferrer);
router.get('/me', authenticate, authorize('referrer'), getMyReferrerDashboard);
router.get('/me/profile', authenticate, authorize('referrer'), getMyReferrerProfile);
router.post('/me/agreement', authenticate, authorize('referrer'), setSignedAgreementDir, uploadAgreementFile.single('agreement'), uploadMyReferrerAgreement);
router.get('/me/referrals', authenticate, authorize('referrer'), getMyReferrerReferrals);
router.get('/me/wallet', authenticate, authorize('referrer'), getMyReferrerWallet);
router.get('/payout-options', authenticate, authorize('referrer'), getMyPayoutOptions);
router.post('/payout-setup/otp', authenticate, authorize('referrer'), requestPayoutSetupOtp);
router.post('/payout-setup/otp/verify', authenticate, authorize('referrer'), verifyPayoutSetupOtp);
router.put('/payout-setup', authenticate, authorize('referrer'), updateMyPayoutSetup);
router.get('/admin/referrers', authenticate, authorize('ministry_admin', 'system_admin'), listAdminReferrers);
router.get('/admin/referrers/:id', authenticate, authorize('ministry_admin', 'system_admin'), getAdminReferrer);
router.patch('/admin/referrers/:id/status', authenticate, authorize('ministry_admin', 'system_admin'), updateAdminReferrerStatus);
router.patch('/admin/referrers/:id/agreement', authenticate, authorize('system_admin'), reviewAdminReferrerAgreement);
router.post('/admin/referrers/:id/withdrawals/preview', authenticate, authorize('system_admin'), previewAdminReferrerWithdrawal);
router.post('/admin/referrers/:id/withdrawals/initiate', authenticate, authorize('system_admin'), initiateAdminReferrerWithdrawal);
router.post('/admin/referrer-withdrawals/:withdrawalId/reconcile', authenticate, authorize('system_admin'), reconcileAdminReferrerWithdrawal);

export default router;

