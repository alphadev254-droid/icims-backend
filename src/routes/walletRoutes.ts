import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { requireFeature } from '../middleware/packageCheck';
import {
  getWalletBalance,
  getWalletTransactions,
  getWithdrawalFeePreview,
  sendWithdrawalOtp,
  requestWithdrawal,
  getWithdrawals,
  getSupportedBanks,
} from '../controllers/walletController';

const router = Router();

router.get('/balance', authenticate, requireFeature('giving_wallets'), getWalletBalance);
router.get('/transactions', authenticate, requireFeature('giving_wallets'), getWalletTransactions);
router.get('/withdraw/fees', authenticate, requireFeature('giving_withdrawals'), getWithdrawalFeePreview);
router.post('/withdraw/otp', authenticate, requireFeature('giving_withdrawals'), sendWithdrawalOtp);
router.post('/withdraw', authenticate, requireFeature('giving_withdrawals'), requestWithdrawal);
router.get('/withdrawals', authenticate, requireFeature('giving_withdrawals'), getWithdrawals);
router.get('/supported-banks', authenticate, requireFeature('giving_withdrawals'), getSupportedBanks);

export default router;
