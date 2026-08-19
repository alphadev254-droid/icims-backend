import { Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import prisma from '../lib/prisma';
import { getAccessibleChurchIds } from '../lib/churchScope';
import { calculateWithdrawalFee } from '../utils/feeCalculations';
import { debitChurchWallet, refundWithdrawal } from '../utils/walletOperations';
import axios from 'axios';
import { queueEmail } from '../lib/emailQueue';
import { withdrawalRequestUserTemplate, withdrawalRequestAdminTemplate, withdrawalOtpTemplate } from '../lib/emailTemplates';
import { recordWithdrawalEvent } from '../middleware/metrics';
import { maskPhone } from '../utils/logger';

const PAYCHANGU_SECRET_KEY = process.env.PAYCHANGU_SECRET_KEY!;

// Simple in-memory cache for Paychangu supported banks/operators
let paychanguBanksCache: any[] | null = null;
let paychanguBanksCacheAt: number | null = null;
let paychanguMobileOperatorsCache: any[] | null = null;
let paychanguMobileOperatorsCacheAt: number | null = null;
const BANKS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function fetchPaychanguBanks(): Promise<any[]> {
  const now = Date.now();
  if (paychanguBanksCache && paychanguBanksCacheAt && now - paychanguBanksCacheAt < BANKS_CACHE_TTL_MS) {
    return paychanguBanksCache;
  }

  const response = await axios.get(
    'https://api.paychangu.com/direct-charge/payouts/supported-banks?currency=MWK',
    {
      headers: {
        Authorization: `Bearer ${PAYCHANGU_SECRET_KEY}`,
      },
    },
  );

  const payload = response.data;
  const banks = Array.isArray(payload?.data) ? payload.data : payload;

  paychanguBanksCache = banks;
  paychanguBanksCacheAt = now;

  return banks;
}

async function fetchPaychanguMobileOperators(): Promise<any[]> {
  const now = Date.now();
  if (paychanguMobileOperatorsCache && paychanguMobileOperatorsCacheAt && now - paychanguMobileOperatorsCacheAt < BANKS_CACHE_TTL_MS) {
    return paychanguMobileOperatorsCache;
  }

  const response = await axios.get(
    'https://api.paychangu.com/mobile-money/',
    { headers: { Authorization: `Bearer ${PAYCHANGU_SECRET_KEY}`, Accept: 'application/json' } },
  );

  const payload = response.data;
  const operators = Array.isArray(payload?.data) ? payload.data : payload;
  paychanguMobileOperatorsCache = operators;
  paychanguMobileOperatorsCacheAt = now;
  return operators;
}

function getPaychanguMobileOperatorRefId(operators: any[], operator?: string | null): string | null {
  const op = String(operator || '').toLowerCase();
  const envValue = op === 'airtel'
    ? process.env.PAYCHANGU_AIRTEL_MONEY_OPERATOR_REF_ID
    : op === 'tnm'
      ? process.env.PAYCHANGU_TNM_MPAMBA_OPERATOR_REF_ID
      : null;
  if (envValue) return envValue;
  const match = operators.find((item: any) => {
    const name = String(item.name || '').toLowerCase();
    const shortCode = String(item.short_code || '').toLowerCase();
    if (op === 'airtel') return shortCode === 'airtel' || name.includes('airtel');
    if (op === 'tnm') return shortCode === 'tnm' || name.includes('tnm') || name.includes('mpamba');
    return false;
  });
  return match?.ref_id || match?.mobile_money_operator_ref_id || match?.operator_ref_id || null;
}

function normalizePaychanguMobilePayoutNumber(value?: string | null): string {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('265')) return `0${digits.slice(3)}`;
  if (digits.length === 9) return `0${digits}`;
  return digits;
}

function normalizeGatewayPayoutStatus(payload: any): 'completed' | 'failed' | 'processing' {
  const status = String(payload?.data?.status ?? payload?.status ?? '').toLowerCase();
  if (['success', 'successful', 'completed', 'paid'].includes(status)) return 'completed';
  if (['failed', 'failure', 'reversed', 'cancelled', 'canceled'].includes(status)) return 'failed';
  return 'processing';
}

export async function getWalletBalance(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const churchId = req.user?.churchId;
  const roleName = req.user?.role ?? 'member';

  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  // Get accessible churches based on role
  let churchIds: string[] = [];
  
  if (roleName === 'ministry_admin') {
    const churches = await prisma.church.findMany({
      where: { ministryAdminId: userId, status: 'active' },
      select: { id: true }
    });
    churchIds = churches.map(c => c.id);
  } else if (roleName === 'member') {
    churchIds = churchId ? [churchId] : [];
  } else {
    churchIds = await getAccessibleChurchIds(
      roleName,
      churchId,
      req.user?.districts,
      req.user?.traditionalAuthorities,
      req.user?.regions,
      userId
    );
  }

  if (churchIds.length === 0) {
    res.json({ success: true, data: { balance: 0, currency: 'MWK' } });
    return;
  }

  // Get total balance from all accessible wallets
  const wallets = await prisma.wallet.findMany({
    where: { churchId: { in: churchIds } },
    select: { balance: true, currency: true }
  });

  const totalBalance = wallets.reduce((sum, w) => sum + w.balance, 0);
  const currency = wallets[0]?.currency || 'MWK';

  res.json({
    success: true,
    data: {
      balance: totalBalance,
      currency
    }
  });
}

export async function getWalletTransactions(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const churchId = req.user?.churchId;
  const roleName = req.user?.role ?? 'member';
  const { page = 1, limit = 20 } = req.query;

  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  // Get accessible churches based on role
  let churchIds: string[] = [];
  
  if (roleName === 'ministry_admin') {
    const churches = await prisma.church.findMany({
      where: { ministryAdminId: userId, status: 'active' },
      select: { id: true }
    });
    churchIds = churches.map(c => c.id);
  } else if (roleName === 'member') {
    churchIds = churchId ? [churchId] : [];
  } else {
    churchIds = await getAccessibleChurchIds(
      roleName,
      churchId,
      req.user?.districts,
      req.user?.traditionalAuthorities,
      req.user?.regions,
      userId
    );
  }

  if (churchIds.length === 0) {
    res.json({ success: true, data: [], total: 0 });
    return;
  }

  const walletIds = await prisma.wallet.findMany({
    where: { churchId: { in: churchIds } },
    select: { id: true }
  });

  const skip = (Number(page) - 1) * Number(limit);

  const [transactions, total] = await Promise.all([
    prisma.walletTransaction.findMany({
      where: { walletId: { in: walletIds.map(w => w.id) } },
      orderBy: { createdAt: 'desc' },
      skip,
      take: Number(limit)
    }),
    prisma.walletTransaction.count({
      where: { walletId: { in: walletIds.map(w => w.id) } }
    })
  ]);

  res.json({ success: true, data: transactions, total });
}

const withdrawalBaseSchema = z.object({
  amount: z.number().positive(),
  method: z.enum(['mobile_money', 'bank_transfer']),
  mobileOperator: z.enum(['airtel', 'tnm']).optional(),
  mobileNumber: z.string().optional(),
  bankCode: z.string().optional(),
  accountName: z.string().optional(),
  accountNumber: z.string().optional(),
});

const withdrawalSchema = withdrawalBaseSchema.refine(
  (data) => {
    if (data.method === 'mobile_money') {
      return !!data.mobileOperator && !!data.mobileNumber;
    }
    if (data.method === 'bank_transfer') {
      return !!data.bankCode && !!data.accountName && !!data.accountNumber;
    }
    return true;
  },
  { message: 'Missing required fields for withdrawal method' }
);

const withdrawalConfirmSchema = withdrawalBaseSchema.extend({
  otpCode: z.string().regex(/^\d{6}$/, 'Enter the 6-digit OTP code'),
}).refine(
  (data) => {
    if (data.method === 'mobile_money') {
      return !!data.mobileOperator && !!data.mobileNumber;
    }
    if (data.method === 'bank_transfer') {
      return !!data.bankCode && !!data.accountName && !!data.accountNumber;
    }
    return true;
  },
  { message: 'Missing required fields for withdrawal method' }
);

const WITHDRAWAL_OTP_EXPIRY_MINUTES = Number(process.env.WITHDRAWAL_OTP_EXPIRY_MINUTES || 5);
const WITHDRAWAL_OTP_MAX_ATTEMPTS = Number(process.env.WITHDRAWAL_OTP_MAX_ATTEMPTS || 5);

function getMobileOperatorFromNumber(value?: string | null): 'airtel' | 'tnm' | null {
  const digits = String(value || '').replace(/\D/g, '');
  const local = digits.startsWith('265') ? `0${digits.slice(3)}` : digits;
  if (local.startsWith('099') || local.startsWith('098')) return 'airtel';
  if (local.startsWith('088') || local.startsWith('089')) return 'tnm';
  return null;
}

function validateMobileOperatorNumber(data: z.infer<typeof withdrawalBaseSchema>): string | null {
  if (data.method !== 'mobile_money') return null;
  const detected = getMobileOperatorFromNumber(data.mobileNumber);
  if (!detected) return 'Enter a valid Airtel Money or TNM Mpamba number.';
  if (data.mobileOperator && detected !== data.mobileOperator) {
    const expected = data.mobileOperator === 'airtel' ? 'Airtel Money' : 'TNM Mpamba';
    const actual = detected === 'airtel' ? 'Airtel Money' : 'TNM Mpamba';
    return `The selected operator is ${expected}, but the number looks like ${actual}. Please correct the operator or mobile number.`;
  }
  return null;
}

function getWithdrawalPayloadHash(payload: z.infer<typeof withdrawalBaseSchema>) {
  const normalized = {
    amount: Number(payload.amount),
    method: payload.method,
    mobileOperator: payload.mobileOperator || null,
    mobileNumber: payload.mobileNumber || null,
    bankCode: payload.bankCode || null,
    accountName: payload.accountName || null,
    accountNumber: payload.accountNumber || null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

async function getWithdrawalContext(req: Request) {
  const userId = req.user?.userId;
  const churchId = req.user?.churchId;
  const roleName = req.user?.role ?? 'member';

  if (!userId) return { errorStatus: 401, errorMessage: 'Not authenticated' };
  if (roleName === 'member') return { errorStatus: 403, errorMessage: 'Members do not have access to withdrawals' };

  const userPermissions = req.user?.permissions || [];
  if (!userPermissions.includes('withdrawals:create')) {
    return { errorStatus: 403, errorMessage: 'You do not have permission to create withdrawals' };
  }

  let ministryAdminId: string;
  if (roleName === 'ministry_admin') {
    ministryAdminId = userId;
  } else {
    const currentUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { ministryAdminId: true }
    });
    ministryAdminId = currentUser?.ministryAdminId || '';
  }

  if (!ministryAdminId) return { errorStatus: 400, errorMessage: 'No national admin found' };

  const ministryAdmin = await prisma.user.findUnique({
    where: { id: ministryAdminId },
    select: { accountCountry: true }
  });

  if (ministryAdmin?.accountCountry !== 'Malawi') {
    return { errorStatus: 403, errorMessage: 'Withdrawals are only available for Malawi accounts' };
  }

  let churchIds: string[] = [];
  if (roleName === 'ministry_admin') {
    const churches = await prisma.church.findMany({
      where: { ministryAdminId: userId, status: 'active' },
      select: { id: true }
    });
    churchIds = churches.map(c => c.id);
  } else {
    churchIds = await getAccessibleChurchIds(
      roleName,
      churchId,
      req.user?.districts,
      req.user?.traditionalAuthorities,
      req.user?.regions,
      userId
    );
  }

  if (churchIds.length === 0) return { errorStatus: 400, errorMessage: 'No churches found' };

  const wallets = await prisma.wallet.findMany({
    where: { churchId: { in: churchIds } },
    include: { church: { select: { name: true, ministryAdminId: true } } }
  });

  if (wallets.length === 0) {
    return { errorStatus: 400, errorMessage: 'No wallet found. Please contact support.' };
  }

  return { userId, roleName, wallets };
}

export async function getWithdrawalFeePreview(req: Request, res: Response): Promise<void> {
  const parsed = withdrawalSchema.safeParse({
    ...req.query,
    amount: Number(req.query.amount),
  });
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }
  const mobileValidationError = validateMobileOperatorNumber(parsed.data);
  if (mobileValidationError) {
    res.status(400).json({ success: false, message: mobileValidationError });
    return;
  }

  const context = await getWithdrawalContext(req);
  if ('errorStatus' in context) {
    res.status(context.errorStatus ?? 400).json({ success: false, message: context.errorMessage });
    return;
  }

  const fees = calculateWithdrawalFee(parsed.data.amount, parsed.data.method, parsed.data.mobileOperator);
  const totalBalance = context.wallets.reduce((sum, w) => sum + w.balance, 0);
  res.json({
    success: true,
    data: {
      ...fees,
      availableBalance: totalBalance,
      hasEnoughBalance: totalBalance >= fees.netAmount,
      shortfall: Math.max(0, fees.netAmount - totalBalance),
      currency: context.wallets[0]?.currency || 'MWK',
    },
  });
}

export async function sendWithdrawalOtp(req: Request, res: Response): Promise<void> {
  const parsed = withdrawalSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }
  const mobileValidationError = validateMobileOperatorNumber(parsed.data);
  if (mobileValidationError) {
    res.status(400).json({ success: false, message: mobileValidationError });
    return;
  }

  const context = await getWithdrawalContext(req);
  if ('errorStatus' in context) {
    res.status(context.errorStatus ?? 400).json({ success: false, message: context.errorMessage });
    return;
  }

  const totalBalance = context.wallets.reduce((sum, w) => sum + w.balance, 0);
  const fees = calculateWithdrawalFee(parsed.data.amount, parsed.data.method, parsed.data.mobileOperator);
  if (totalBalance < fees.netAmount) {
    res.status(400).json({
      success: false,
      message: `Insufficient transaction cost to withdraw ${parsed.data.amount}. You need ${fees.netAmount} including fees, but available balance is ${totalBalance}. Reduce the withdrawal amount.`,
    });
    return;
  }

  const selectedWallet = context.wallets.find(w => w.balance >= fees.netAmount) || context.wallets.sort((a, b) => b.balance - a.balance)[0];
  const user = await prisma.user.findUnique({
    where: { id: context.userId },
    select: { firstName: true, email: true },
  });

  if (!user?.email) {
    res.status(400).json({ success: false, message: 'Your account does not have an email address for OTP verification' });
    return;
  }

  const otpCode = String(crypto.randomInt(100000, 1000000));
  const otpHash = await bcrypt.hash(otpCode, 10);
  const payloadHash = getWithdrawalPayloadHash(parsed.data);
  const expiresAt = new Date(Date.now() + WITHDRAWAL_OTP_EXPIRY_MINUTES * 60 * 1000);

  await (prisma as any).withdrawalOtp.updateMany({
    where: { userId: context.userId, usedAt: null },
    data: { usedAt: new Date() },
  });

  await (prisma as any).withdrawalOtp.create({
    data: {
      userId: context.userId,
      otpHash,
      payloadHash,
      expiresAt,
    },
  });

  await queueEmail(
    user.email,
    'Withdrawal OTP Code',
    withdrawalOtpTemplate({
      firstName: user.firstName,
      otpCode,
      amount: parsed.data.amount,
      currency: selectedWallet.currency,
      method: parsed.data.method,
      expiresInMinutes: WITHDRAWAL_OTP_EXPIRY_MINUTES,
      churchName: selectedWallet.church.name,
    }),
    'withdrawal_otp',
  );

  res.json({
    success: true,
    message: `OTP sent to ${user.email}`,
    expiresInSeconds: WITHDRAWAL_OTP_EXPIRY_MINUTES * 60,
    data: {
      ...fees,
      availableBalance: totalBalance,
      hasEnoughBalance: true,
      shortfall: 0,
      currency: selectedWallet.currency,
    },
  });
}

export async function requestWithdrawal(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const churchId = req.user?.churchId;
  const roleName = req.user?.role ?? 'member';

  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  // Block members from accessing withdrawals
  if (roleName === 'member') {
    res.status(403).json({ success: false, message: 'Members do not have access to withdrawals' });
    return;
  }

  console.log('=== WITHDRAWAL REQUEST ===');
  console.log('User ID:', userId);
  console.log('Role:', roleName);
  console.log('Church ID:', churchId);

  // Check permission
  const userPermissions = req.user?.permissions || [];
  if (!userPermissions.includes('withdrawals:create')) {
    res.status(403).json({ success: false, message: 'You do not have permission to create withdrawals' });
    return;
  }

  const parsed = withdrawalConfirmSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }
  const mobileValidationError = validateMobileOperatorNumber(parsed.data);
  if (mobileValidationError) {
    res.status(400).json({ success: false, message: mobileValidationError });
    return;
  }

  const { amount, method, mobileOperator, mobileNumber, bankCode, accountName, accountNumber, otpCode } = parsed.data;

  // Get national admin to check account country
  let ministryAdminId: string;
  if (roleName === 'ministry_admin') {
    ministryAdminId = userId;
  } else {
    const currentUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { ministryAdminId: true }
    });
    ministryAdminId = currentUser?.ministryAdminId || '';
  }

  if (!ministryAdminId) {
    res.status(400).json({ success: false, message: 'No national admin found' });
    return;
  }

  const ministryAdmin = await prisma.user.findUnique({
    where: { id: ministryAdminId },
    select: { accountCountry: true }
  });

  if (ministryAdmin?.accountCountry !== 'Malawi') {
    res.status(403).json({ success: false, message: 'Withdrawals are only available for Malawi accounts' });
    return;
  }

  // Get accessible churches based on role
  let churchIds: string[] = [];
  
  if (roleName === 'ministry_admin') {
    const churches = await prisma.church.findMany({
      where: { ministryAdminId: userId, status: 'active' },
      select: { id: true }
    });
    churchIds = churches.map(c => c.id);
    console.log('National admin churches:', churchIds);
  } else {
    churchIds = await getAccessibleChurchIds(
      roleName,
      churchId,
      req.user?.districts,
      req.user?.traditionalAuthorities,
      req.user?.regions,
      userId
    );
  }

  if (churchIds.length === 0) {
    console.error('ERROR: No accessible churches found');
    res.status(400).json({ success: false, message: 'No churches found' });
    return;
  }

  // Get all wallets from accessible churches
  const wallets = await prisma.wallet.findMany({
    where: { churchId: { in: churchIds } },
    include: { church: { select: { name: true, ministryAdminId: true } } }
  });

  console.log('Wallets found:', wallets.length);
  wallets.forEach(w => console.log('  -', w.church.name, ':', w.balance, w.currency));

  if (wallets.length === 0) {
    console.error('ERROR: No wallets found for accessible churches');
    res.status(400).json({ success: false, message: 'No wallet found. Please contact support.' });
    return;
  }

  // Calculate total available balance
  const totalBalance = wallets.reduce((sum, w) => sum + w.balance, 0);
  console.log('Total balance:', totalBalance);

  const fees = calculateWithdrawalFee(amount, method, mobileOperator);
  console.log('Fees calculated:', fees);

  if (totalBalance < fees.netAmount) {
    console.error('ERROR: Insufficient transaction cost. Total:', totalBalance, 'Required:', fees.netAmount, 'Requested:', amount);
    res.status(400).json({
      success: false,
      message: `Insufficient transaction cost to withdraw ${amount}. You need ${fees.netAmount} including fees, but available balance is ${totalBalance}. Reduce the withdrawal amount.`,
    });
    return;
  }

  const payloadHash = getWithdrawalPayloadHash({ amount, method, mobileOperator, mobileNumber, bankCode, accountName, accountNumber });
  const withdrawalOtp = await (prisma as any).withdrawalOtp.findFirst({
    where: {
      userId,
      payloadHash,
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!withdrawalOtp) {
    res.status(400).json({ success: false, message: 'OTP is missing or expired. Request a new OTP code.' });
    return;
  }

  if (withdrawalOtp.attempts >= WITHDRAWAL_OTP_MAX_ATTEMPTS) {
    await (prisma as any).withdrawalOtp.update({
      where: { id: withdrawalOtp.id },
      data: { usedAt: new Date() },
    });
    res.status(400).json({ success: false, message: 'Too many OTP attempts. Request a new OTP code.' });
    return;
  }

  const otpValid = await bcrypt.compare(otpCode, withdrawalOtp.otpHash);
  if (!otpValid) {
    await (prisma as any).withdrawalOtp.update({
      where: { id: withdrawalOtp.id },
      data: { attempts: { increment: 1 } },
    });
    res.status(400).json({ success: false, message: 'Invalid OTP code' });
    return;
  }

  await (prisma as any).withdrawalOtp.update({
    where: { id: withdrawalOtp.id },
    data: { usedAt: new Date() },
  });

  // Use the first wallet with sufficient balance, or the one with highest balance
  let selectedWallet = wallets.find(w => w.balance >= fees.netAmount) || wallets.sort((a, b) => b.balance - a.balance)[0];
  console.log('Selected wallet:', selectedWallet.id, 'Balance:', selectedWallet.balance);

  const withdrawal = await prisma.withdrawal.create({
    data: {
      walletId: selectedWallet.id,
      ministryAdminId: userId,
      amount: fees.amount,
      fee: fees.fee,
      gatewayFeeAmount: fees.gatewayFeeAmount,
      gatewayFeeRate: fees.gatewayFeeRate,
      bankFixedFeeAmount: fees.bankFixedFeeAmount,
      systemFeeAmount: fees.systemFeeAmount,
      systemFeeRate: fees.systemFeeRate,
      netAmount: fees.netAmount,
      payoutAmount: fees.payoutAmount,
      method,
      mobileOperator,
      mobileNumber,
      bankCode,
      accountName,
      accountNumber,
      status: 'pending',
      initiatedBy: userId,
    } as any
  });
  recordWithdrawalEvent(method, 'requested', 'ministry', {
    requestId: req.requestId,
    withdrawalId: withdrawal.id,
    walletId: selectedWallet.id,
    ministryAdminId: userId,
    initiatedBy: userId,
    initiatedByName: req.user?.userName,
    amount: fees.amount,
    totalDebited: fees.netAmount,
    payoutAmount: fees.payoutAmount,
    fee: fees.fee,
    gatewayFeeAmount: fees.gatewayFeeAmount,
    systemFeeAmount: fees.systemFeeAmount,
    currency: selectedWallet.currency,
    mobileOperator,
    mobileNumber: maskPhone(mobileNumber),
  });

  console.log('Withdrawal created:', withdrawal.id);

  await debitChurchWallet(
    selectedWallet.id,
    fees.netAmount,
    'withdrawal',
    withdrawal.id,
    `Withdrawal request - ${method}`
  );

  console.log('Wallet debited successfully');

  // Get user details for email
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { firstName: true, lastName: true, email: true, ministryAdminId: true }
  });

  // Send email to user
 // Send email to user
if (user?.email) {
  const userEmailHtml = withdrawalRequestUserTemplate({
    firstName: user.firstName,
    amount,
    fee: fees.fee,
    netAmount: fees.netAmount,
    currency: selectedWallet.currency,
    method,
    withdrawalId: withdrawal.id,
    churchName: selectedWallet.church.name,
    mobileOperator,
    mobileNumber,
    bankCode,
    accountName,
    accountNumber,
  });
  await queueEmail(
    user.email,
    'Withdrawal Request Received',
    userEmailHtml,
    'withdrawal_request_user',
  );
}

  // Send email to national admin (only if requester is not the national admin)
  const adminId = roleName === 'ministry_admin' ? userId : (user?.ministryAdminId || selectedWallet.church.ministryAdminId);
  if (adminId && adminId !== userId) {
    const ministryAdmin = await prisma.user.findUnique({
      where: { id: adminId },
      select: { email: true }
    });

    if (ministryAdmin?.email && user) {
      const adminEmailHtml = withdrawalRequestAdminTemplate({
        userName: `${user.firstName} ${user.lastName}`,
        userEmail: user.email,
        amount,
        fee: fees.fee,
        netAmount: fees.netAmount,
        currency: selectedWallet.currency,
        method,
        withdrawalId: withdrawal.id,
        mobileOperator,
        mobileNumber,
        bankCode,
        accountName,
        accountNumber,
        churchName: selectedWallet.church.name,
      });
      await queueEmail(ministryAdmin.email, 'New Withdrawal Request', adminEmailHtml, 'withdrawal_request_admin');
    }
  }

  try {
    await processPaychanguPayout(withdrawal);
    
    // Fetch updated withdrawal status
    const updatedWithdrawal = await prisma.withdrawal.findUnique({
      where: { id: withdrawal.id }
    });

    res.json({
      success: true,
      data: {
        id: updatedWithdrawal!.id,
        amount: updatedWithdrawal!.amount,
        fee: updatedWithdrawal!.fee,
        gatewayFeeAmount: (updatedWithdrawal as any)!.gatewayFeeAmount,
        gatewayFeeRate: (updatedWithdrawal as any)!.gatewayFeeRate,
        bankFixedFeeAmount: (updatedWithdrawal as any)!.bankFixedFeeAmount,
        systemFeeAmount: (updatedWithdrawal as any)!.systemFeeAmount,
        systemFeeRate: (updatedWithdrawal as any)!.systemFeeRate,
        netAmount: updatedWithdrawal!.netAmount,
        payoutAmount: (updatedWithdrawal as any)!.payoutAmount,
        status: updatedWithdrawal!.status
      }
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      message: error.message || 'Withdrawal processing failed'
    });
  }
}

export async function getWithdrawals(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const churchId = req.user?.churchId;
  const roleName = req.user?.role ?? 'member';
  const { page = 1, limit = 20, startDate, endDate } = req.query;

  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  // Block members from accessing withdrawals
  if (roleName === 'member') {
    res.status(403).json({ success: false, message: 'Members do not have access to withdrawals' });
    return;
  }

  // Check permission
  const userPermissions = req.user?.permissions || [];
  if (!userPermissions.includes('withdrawals:read')) {
    res.status(403).json({ success: false, message: 'You do not have permission to view withdrawals' });
    return;
  }

  // Get accessible churches based on role
  let churchIds: string[] = [];
  
  if (roleName === 'ministry_admin') {
    const churches = await prisma.church.findMany({
      where: { ministryAdminId: userId, status: 'active' },
      select: { id: true }
    });
    churchIds = churches.map(c => c.id);
  } else {
    churchIds = await getAccessibleChurchIds(
      roleName,
      churchId,
      req.user?.districts,
      req.user?.traditionalAuthorities,
      req.user?.regions,
      userId
    );
  }

  if (churchIds.length === 0) {
    res.json({ success: true, data: [], total: 0 });
    return;
  }

  const walletIds = await prisma.wallet.findMany({
    where: { churchId: { in: churchIds } },
    select: { id: true }
  });

  const skip = (Number(page) - 1) * Number(limit);

  // Build date filter
  const dateFilter: any = {};
  if (startDate) {
    dateFilter.gte = new Date(String(startDate));
  }
  if (endDate) {
    const endDateTime = new Date(String(endDate));
    endDateTime.setHours(23, 59, 59, 999);
    dateFilter.lte = endDateTime;
  }

  const [withdrawals, total] = await Promise.all([
    prisma.withdrawal.findMany({
      where: {
        walletId: { in: walletIds.map(w => w.id) },
        ...(Object.keys(dateFilter).length > 0 && { createdAt: dateFilter }),
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: Number(limit)
    }),
    prisma.withdrawal.count({
      where: {
        walletId: { in: walletIds.map(w => w.id) },
        ...(Object.keys(dateFilter).length > 0 && { createdAt: dateFilter }),
      }
    })
  ]);

  res.json({ success: true, data: withdrawals, total });
}

export async function getSupportedBanks(req: Request, res: Response): Promise<void> {
  try {
    const banks = await fetchPaychanguBanks();
    res.json({ success: true, data: banks });
  } catch (error: any) {
    console.error('❌ Failed to fetch Paychangu supported banks', error.response?.data || error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch supported banks' });
  }
}

async function processPaychanguPayout(withdrawal: any) {
  try {
    console.log('=== PAYCHANGU PAYOUT ===');
    console.log('Withdrawal ID:', withdrawal.id);
    console.log('Method:', withdrawal.method);
    console.log('Payout Amount:', withdrawal.payoutAmount ?? withdrawal.netAmount);

    if (withdrawal.method === 'mobile_money') {
      const operators = await fetchPaychanguMobileOperators();
      const operatorRefId = getPaychanguMobileOperatorRefId(operators, withdrawal.mobileOperator);
      if (!operatorRefId) {
        throw new Error(`Unable to resolve Paychangu mobile money operator ref_id for ${withdrawal.mobileOperator}`);
      }
      if (!withdrawal.mobileNumber) {
        throw new Error('Missing mobileNumber for mobile money withdrawal');
      }

      const chargeId = `PAYOUT-${withdrawal.id}`;
      const payoutPayload = {
        mobile: normalizePaychanguMobilePayoutNumber(withdrawal.mobileNumber),
        mobile_money_operator_ref_id: operatorRefId,
        amount: String(withdrawal.payoutAmount ?? withdrawal.netAmount),
        charge_id: chargeId,
      };

      console.log('Paychangu Mobile Payout Payload:', payoutPayload);
      await prisma.withdrawal.update({
        where: { id: withdrawal.id },
        data: { gatewayPayload: JSON.stringify({ provider: 'paychangu', action: 'mobile-money.payouts.initialize', payload: payoutPayload }) } as any,
      });

      const response = await axios.post(
        'https://api.paychangu.com/mobile-money/payouts/initialize',
        payoutPayload,
        {
          headers: {
            Authorization: `Bearer ${PAYCHANGU_SECRET_KEY}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
        },
      );

      console.log('Paychangu Mobile Payout Response Status:', response.status);
      console.log('Paychangu Mobile Payout Response Data:', JSON.stringify(response.data, null, 2));

      const normalizedStatus = normalizeGatewayPayoutStatus(response.data);
      await prisma.withdrawal.update({
        where: { id: withdrawal.id },
        data: {
          status: normalizedStatus,
          chargeId,
          processedAt: normalizedStatus === 'completed' ? new Date() : null,
          failureReason: normalizedStatus === 'failed' ? String(response.data?.message || 'Mobile payout failed').substring(0, 2000) : null,
          gatewayResponse: JSON.stringify({ initializeResponse: response.data }),
        } as any,
      });

      recordWithdrawalEvent(withdrawal.method, normalizedStatus === 'completed' ? 'completed' : normalizedStatus === 'failed' ? 'failed' : 'processing', 'ministry', {
        withdrawalId: withdrawal.id,
        chargeId,
        amount: withdrawal.amount,
        payoutAmount: withdrawal.payoutAmount,
        totalDebited: withdrawal.netAmount,
        gatewayStatus: response.status,
        mobileOperator: withdrawal.mobileOperator,
        mobileNumber: maskPhone(withdrawal.mobileNumber),
      });

      if (normalizedStatus === 'failed') {
        throw new Error(response.data?.message || 'Mobile payout failed');
      }

      console.log(`Withdrawal status updated to ${normalizedStatus}`);
      return;
    }

    // Map withdrawal details to Paychangu direct-charge payout payload
    let bankUuid: string;
    let accountNumber: string;
    let accountName: string | undefined = withdrawal.accountName || undefined;

    if (withdrawal.method === 'mobile_money') {
      // Dynamically resolve operator UUID from supported-banks list
      const banks = await fetchPaychanguBanks();
      const op = String(withdrawal.mobileOperator || '').toLowerCase();

      const match = banks.find((b: any) => {
        const name: string = String(b.name || '').toLowerCase();
        if (op === 'airtel') return name.includes('airtel');
        if (op === 'tnm') return name.includes('tnm') || name.includes('mpamba');
        return false;
      });

      const uuid = match?.uuid || match?.id || match?.bank_uuid;
      if (!uuid) {
        throw new Error(`Unable to resolve Paychangu bank UUID for mobile operator: ${withdrawal.mobileOperator}`);
      }
      bankUuid = uuid;

      // Normalise MSISDN to international format 265XXXXXXXXX
      if (!withdrawal.mobileNumber) {
        throw new Error('Missing mobileNumber for mobile money withdrawal');
      }
      let msisdn = String(withdrawal.mobileNumber).replace(/\D/g, '');
      if (msisdn.startsWith('0')) {
        msisdn = `265${msisdn.slice(1)}`;
      } else if (!msisdn.startsWith('265')) {
        msisdn = `265${msisdn}`;
      }
      accountNumber = msisdn;
      if (!accountName) accountName = 'Mobile Money Withdrawal';
    } else {
      // Bank transfer — bankCode is expected to hold the Paychangu bank_uuid
      if (!withdrawal.bankCode || !withdrawal.accountNumber) {
        throw new Error('Missing bank details for bank transfer withdrawal');
      }
      bankUuid = withdrawal.bankCode;
      accountNumber = String(withdrawal.accountNumber);
      if (!accountName) accountName = 'Bank Withdrawal';
    }

    const payoutPayload = {
      payout_method: 'bank_transfer',
      bank_uuid: bankUuid,
      amount: String(Math.round(withdrawal.payoutAmount ?? withdrawal.netAmount)),
      charge_id: `PAYOUT-${withdrawal.id}`,
      bank_account_name: accountName,
      bank_account_number: accountNumber,
    };

    console.log('Paychangu Payout Payload:', payoutPayload);
    await prisma.withdrawal.update({
      where: { id: withdrawal.id },
      data: { gatewayPayload: JSON.stringify({ provider: 'paychangu', action: 'payouts.initialize', payload: payoutPayload }) } as any,
    });

    const response = await axios.post(
      'https://api.paychangu.com/direct-charge/payouts/initialize',
      payoutPayload,
      {
        headers: {
          Authorization: `Bearer ${PAYCHANGU_SECRET_KEY}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      },
    );

    console.log('✅ Paychangu Response Status:', response.status);
    console.log('✅ Paychangu Response Data:', JSON.stringify(response.data, null, 2));

    // Check if webhook already updated the status
    const currentWithdrawal = await prisma.withdrawal.findUnique({
      where: { id: withdrawal.id }
    });

    if (currentWithdrawal?.status === 'completed') {
      console.log('✅ Withdrawal already marked as completed by webhook');
      return;
    }

    await prisma.withdrawal.update({
      where: { id: withdrawal.id },
      data: {
        status: 'processing',
        chargeId: `PAYOUT-${withdrawal.id}`,
        gatewayResponse: JSON.stringify({ initializeResponse: response.data }),
      } as any,
    });

    recordWithdrawalEvent(withdrawal.method, 'processing', 'ministry', {
      withdrawalId: withdrawal.id,
      chargeId: `PAYOUT-${withdrawal.id}`,
      amount: withdrawal.amount,
      payoutAmount: withdrawal.payoutAmount,
      totalDebited: withdrawal.netAmount,
      gatewayStatus: response.status,
      mobileOperator: withdrawal.mobileOperator,
      mobileNumber: maskPhone(withdrawal.mobileNumber),
    });
    console.log('✅ Withdrawal status updated to processing');
  } catch (error: any) {
    // Re-throw error to be caught by requestWithdrawal
    console.error('❌ PAYCHANGU PAYOUT FAILED');
    console.error('Error Message:', error.message);
    console.error('Error Response:', error.response?.data);
    console.error('Error Status:', error.response?.status);

    await refundWithdrawal(withdrawal.id);
    console.log('✅ Refund processed');
    
    // Convert error response to string for storage
    const fullReason = error.response?.data 
      ? JSON.stringify(error.response.data) 
      : error.message;
    
    // failureReason is TEXT in DB — keep full detail; truncate only as safety net
    const failureReason = fullReason.substring(0, 2000);
    
    await prisma.withdrawal.update({
      where: { id: withdrawal.id },
      data: {
        status: 'failed',
        failureReason,
        gatewayResponse: JSON.stringify({
          error: error.response?.data ?? { message: error.message },
          status: error.response?.status ?? null,
        }),
      } as any
    });

    recordWithdrawalEvent(withdrawal.method, 'failed', 'ministry', {
      withdrawalId: withdrawal.id,
      chargeId: withdrawal.chargeId || `PAYOUT-${withdrawal.id}`,
      amount: withdrawal.amount,
      payoutAmount: withdrawal.payoutAmount,
      totalDebited: withdrawal.netAmount,
      gatewayStatus: error.response?.status,
      errorMessage: error.message,
      mobileOperator: withdrawal.mobileOperator,
      mobileNumber: maskPhone(withdrawal.mobileNumber),
    });
    console.log('✅ Withdrawal status updated to failed');
    
    throw new Error(failureReason);
  }
}
