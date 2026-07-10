import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import {
  getWalletBalance,
  getWalletTransactions,
  sendWithdrawalOtp,
  requestWithdrawal,
  getWithdrawals,
  getSupportedBanks,
} from '../controllers/walletController';

const router = Router();

router.get('/balance', authenticate, getWalletBalance);
router.get('/transactions', authenticate, getWalletTransactions);
router.post('/withdraw/otp', authenticate, sendWithdrawalOtp);
router.post('/withdraw', authenticate, requestWithdrawal);
router.get('/withdrawals', authenticate, getWithdrawals);
router.get('/supported-banks', authenticate, getSupportedBanks);

export default router;
