import { Request, Response } from 'express';
import { z } from 'zod';
import axios from 'axios';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import prisma from '../lib/prisma';
import { queueEmail } from '../lib/emailQueue';
import { withdrawalOtpTemplate } from '../lib/emailTemplates';
import { refundWithdrawal } from '../utils/walletOperations';

const PAYCHANGU_SECRET_KEY = process.env.PAYCHANGU_SECRET_KEY!;
const OTP_EXPIRY_MINUTES = Number(process.env.WITHDRAWAL_OTP_EXPIRY_MINUTES || 5);
const OTP_MAX_ATTEMPTS = Number(process.env.WITHDRAWAL_OTP_MAX_ATTEMPTS || 5);

const treasuryBaseSchema = z.object({
  amount: z.number().positive(),
  method: z.enum(['mobile_money', 'bank_transfer']),
  mobileOperator: z.enum(['airtel', 'tnm']).optional(),
  mobileNumber: z.string().optional(),
  bankCode: z.string().optional(),
  accountName: z.string().optional(),
  accountNumber: z.string().optional(),
});

const treasurySchema = treasuryBaseSchema.refine((data) => {
  if (data.method === 'mobile_money') return !!data.mobileOperator && !!data.mobileNumber;
  return !!data.bankCode && !!data.accountName && !!data.accountNumber;
}, { message: 'Missing required fields for withdrawal method' });

const treasuryConfirmSchema = treasuryBaseSchema.extend({
  otpCode: z.string().regex(/^\d{6}$/, 'Enter the 6-digit OTP code'),
}).refine((data) => {
  if (data.method === 'mobile_money') return !!data.mobileOperator && !!data.mobileNumber;
  return !!data.bankCode && !!data.accountName && !!data.accountNumber;
}, { message: 'Missing required fields for withdrawal method' });

function normalizeRate(raw: number): number {
  return raw > 1 ? raw / 100 : raw;
}

function optionalEnv(key: string, fallback: number): number {
  const val = process.env[key];
  if (!val) return fallback;
  const num = parseFloat(val);
  return Number.isFinite(num) ? num : fallback;
}

function requireEnv(key: string): number {
  const val = process.env[key];
  const num = parseFloat(String(val || ''));
  if (!Number.isFinite(num)) throw new Error('Treasury payout configuration is not available.');
  return num;
}

function ceilMoney(value: number) {
  return Math.ceil(value);
}

function getMobileOperatorFromNumber(value?: string | null): 'airtel' | 'tnm' | null {
  const digits = String(value || '').replace(/\D/g, '');
  const local = digits.startsWith('265') ? `0${digits.slice(3)}` : digits;
  if (local.startsWith('099') || local.startsWith('098')) return 'airtel';
  if (local.startsWith('088') || local.startsWith('089')) return 'tnm';
  return null;
}

function validateMobileOperatorNumber(data: z.infer<typeof treasuryBaseSchema>): string | null {
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

function calculatePlatformPayoutFee(amount: number, method: 'mobile_money' | 'bank_transfer', mobileOperator?: 'airtel' | 'tnm') {
  let gatewayFeeRate: number;
  let bankFixedFeeAmount = 0;
  if (method === 'mobile_money') {
    const operatorRate = mobileOperator === 'airtel'
      ? optionalEnv('WITHDRAWAL_AIRTEL_MONEY_FEE_RATE', 0.018)
      : mobileOperator === 'tnm'
        ? optionalEnv('WITHDRAWAL_TNM_MPAMBA_FEE_RATE', 0.015)
        : null;
    if (operatorRate == null) throw new Error('Mobile money operator is required for treasury payout fee calculation.');
    gatewayFeeRate = normalizeRate(operatorRate);
  } else {
    gatewayFeeRate = normalizeRate(requireEnv('WITHDRAWAL_BANK_FEE_RATE'));
    bankFixedFeeAmount = ceilMoney(requireEnv('WITHDRAWAL_BANK_FIXED_FEE'));
  }
  const gatewayFeeAmount = ceilMoney((amount * gatewayFeeRate) + bankFixedFeeAmount);
  const fee = gatewayFeeAmount;
  return {
    amount: parseFloat(amount.toFixed(2)),
    fee: parseFloat(fee.toFixed(2)),
    gatewayFeeAmount: parseFloat(gatewayFeeAmount.toFixed(2)),
    gatewayFeeRate,
    bankFixedFeeAmount: parseFloat(bankFixedFeeAmount.toFixed(2)),
    netAmount: parseFloat((amount + fee).toFixed(2)),
    payoutAmount: parseFloat(amount.toFixed(2)),
  };
}

function getPayloadHash(payload: z.infer<typeof treasuryBaseSchema>) {
  return crypto.createHash('sha256').update(JSON.stringify({
    amount: Number(payload.amount),
    method: payload.method,
    mobileOperator: payload.mobileOperator || null,
    mobileNumber: payload.mobileNumber || null,
    bankCode: payload.bankCode || null,
    accountName: payload.accountName || null,
    accountNumber: payload.accountNumber || null,
  })).digest('hex');
}

async function fetchPaychanguBalance(currency = 'MWK') {
  const endpoints = [
    `https://api.paychangu.com/wallet-balance?currency=${currency}`,
    `https://api.paychangu.com/balance?currency=${currency}`,
  ];
  let lastError: any;
  for (const url of endpoints) {
    try {
      const response = await axios.get(url, {
        headers: { Authorization: `Bearer ${PAYCHANGU_SECRET_KEY}`, Accept: 'application/json' },
      });
      const payload = response.data;
      const raw =
        payload?.data?.main_balance ??
        payload?.main_balance ??
        payload?.data?.available_balance ??
        payload?.available_balance ??
        payload?.data?.balance ??
        payload?.balance ??
        0;
      return { balance: Number(raw) || 0, currency, raw: payload };
    } catch (error: any) {
      lastError = error;
    }
  }
  throw lastError;
}

async function fetchPaychanguBanks() {
  const response = await axios.get('https://api.paychangu.com/direct-charge/payouts/supported-banks?currency=MWK', {
    headers: { Authorization: `Bearer ${PAYCHANGU_SECRET_KEY}` },
  });
  return Array.isArray(response.data?.data) ? response.data.data : response.data;
}

async function fetchPayoutStatus(chargeId: string) {
  const endpoints = [
    `https://api.paychangu.com/mobile-money/payments/${encodeURIComponent(chargeId)}/details`,
    `https://api.paychangu.com/direct-charge/payouts/${encodeURIComponent(chargeId)}`,
    `https://api.paychangu.com/direct-charge/payouts/verify/${encodeURIComponent(chargeId)}`,
    `https://api.paychangu.com/direct-charge/payouts/status/${encodeURIComponent(chargeId)}`,
  ];
  let lastError: any;
  for (const url of endpoints) {
    try {
      const response = await axios.get(url, {
        headers: { Authorization: `Bearer ${PAYCHANGU_SECRET_KEY}`, Accept: 'application/json' },
      });
      return { url, payload: response.data };
    } catch (error: any) {
      lastError = error;
    }
  }
  throw lastError;
}

function safeParseJson(value?: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizePayoutStatus(payload: any): 'completed' | 'failed' | 'processing' | null {
  const status = String(
    payload?.data?.status ??
    payload?.status ??
    payload?.data?.payout_status ??
    payload?.payout_status ??
    ''
  ).toLowerCase();
  if (['success', 'successful', 'completed', 'paid'].includes(status)) return 'completed';
  if (['failed', 'failure', 'reversed', 'cancelled', 'canceled'].includes(status)) return 'failed';
  if (['pending', 'processing', 'queued', 'initiated'].includes(status)) return 'processing';
  return null;
}

async function getTreasurySummaryData() {
  const [paychangu, walletAgg, pendingMinistryAgg, pendingPlatformAgg, completedRevenueAgg] = await Promise.all([
    fetchPaychanguBalance('MWK'),
    prisma.wallet.aggregate({ where: { currency: 'MWK' }, _sum: { balance: true }, _count: { _all: true } }),
    prisma.withdrawal.aggregate({
      where: { status: { in: ['pending', 'processing', 'review_required'] }, wallet: { currency: 'MWK' } } as any,
      _sum: { payoutAmount: true },
      _count: { _all: true },
    }),
    (prisma as any).platformWithdrawal.aggregate({
      where: { status: { in: ['pending', 'processing', 'review_required'] } },
      _sum: { payoutAmount: true },
      _count: { _all: true },
    }),
    prisma.transaction.aggregate({
      where: { status: 'completed', currency: 'MWK' },
      _sum: { systemFeeAmount: true, ceilRoundingAmount: true } as any,
    }),
  ]);
  const ministryWalletBalance = walletAgg._sum.balance ?? 0;
  const pendingMinistryPayouts = pendingMinistryAgg._sum.payoutAmount ?? 0;
  const pendingPlatformPayouts = pendingPlatformAgg._sum.payoutAmount ?? 0;
  const safeAvailableBalance = Math.max(0, paychangu.balance - ministryWalletBalance - pendingMinistryPayouts - pendingPlatformPayouts);
  return {
    currency: 'MWK',
    paychanguBalance: paychangu.balance,
    paychanguRaw: paychangu.raw,
    ministryWalletBalance,
    ministryWalletCount: walletAgg._count._all,
    pendingMinistryPayouts,
    pendingMinistryWithdrawalCount: pendingMinistryAgg._count._all,
    pendingPlatformPayouts,
    pendingPlatformWithdrawalCount: pendingPlatformAgg._count._all,
    safeAvailableBalance,
    systemRevenue: ((completedRevenueAgg._sum as any)?.systemFeeAmount ?? 0) + ((completedRevenueAgg._sum as any)?.ceilRoundingAmount ?? 0),
  };
}

export async function getAdminTreasurySummary(_req: Request, res: Response): Promise<void> {
  try {
    const data = await getTreasurySummaryData();
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Failed to fetch treasury balance', error: error.response?.data || error.message });
  }
}

export async function getAdminTreasuryWithdrawals(req: Request, res: Response): Promise<void> {
  const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
  const limit = Math.min(100, Math.max(10, parseInt(String(req.query.limit || '50'), 10) || 50));
  const status = req.query.status as string | undefined;
  const where = status ? { status } : {};
  const [rows, total] = await Promise.all([
    (prisma as any).platformWithdrawal.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    (prisma as any).platformWithdrawal.count({ where }),
  ]);
  res.json({ success: true, data: rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
}

export async function getAdminTreasuryBanks(_req: Request, res: Response): Promise<void> {
  try {
    res.json({ success: true, data: await fetchPaychanguBanks() });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Failed to fetch supported banks', error: error.response?.data || error.message });
  }
}

export async function sendAdminTreasuryOtp(req: Request, res: Response): Promise<void> {
  const parsed = treasurySchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }
  const validation = validateMobileOperatorNumber(parsed.data);
  if (validation) { res.status(400).json({ success: false, message: validation }); return; }
  const fees = calculatePlatformPayoutFee(parsed.data.amount, parsed.data.method, parsed.data.mobileOperator);
  const summary = await getTreasurySummaryData();
  if (fees.netAmount > summary.safeAvailableBalance) {
    res.status(400).json({ success: false, message: `Insufficient platform safe balance to withdraw ${fees.amount}. You need ${fees.netAmount} including payout cost, but safe balance is ${summary.safeAvailableBalance}.` });
    return;
  }
  const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: { email: true, firstName: true } });
  if (!user?.email) { res.status(400).json({ success: false, message: 'Your account does not have an email address for OTP verification' }); return; }
  const otpCode = String(crypto.randomInt(100000, 1000000));
  await (prisma as any).platformWithdrawalOtp.updateMany({ where: { userId: req.user!.userId, usedAt: null }, data: { usedAt: new Date() } });
  await (prisma as any).platformWithdrawalOtp.create({
    data: {
      userId: req.user!.userId,
      otpHash: await bcrypt.hash(otpCode, 10),
      payloadHash: getPayloadHash(parsed.data),
      expiresAt: new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000),
    },
  });
  await queueEmail(user.email, 'Platform Treasury OTP Code', withdrawalOtpTemplate({
    firstName: user.firstName,
    otpCode,
    amount: parsed.data.amount,
    currency: summary.currency,
    method: parsed.data.method,
    expiresInMinutes: OTP_EXPIRY_MINUTES,
    churchName: 'ICIMS Platform Treasury',
  }), 'platform_treasury_otp');
  res.json({ success: true, message: 'OTP sent to your email', expiresInSeconds: OTP_EXPIRY_MINUTES * 60 });
}

async function processPlatformPayout(withdrawal: any) {
  const banks = await fetchPaychanguBanks();
  let bankUuid: string;
  let accountNumber: string;
  let accountName = withdrawal.accountName || 'Platform Withdrawal';
  if (withdrawal.method === 'mobile_money') {
    const op = String(withdrawal.mobileOperator || '').toLowerCase();
    const match = banks.find((b: any) => {
      const name = String(b.name || '').toLowerCase();
      if (op === 'airtel') return name.includes('airtel');
      if (op === 'tnm') return name.includes('tnm') || name.includes('mpamba');
      return false;
    });
    bankUuid = match?.uuid || match?.id || match?.bank_uuid;
    if (!bankUuid) throw new Error(`Unable to resolve PayChangu bank UUID for ${withdrawal.mobileOperator}`);
    let msisdn = String(withdrawal.mobileNumber || '').replace(/\D/g, '');
    if (msisdn.startsWith('0')) msisdn = `265${msisdn.slice(1)}`;
    else if (!msisdn.startsWith('265')) msisdn = `265${msisdn}`;
    accountNumber = msisdn;
  } else {
    bankUuid = withdrawal.bankCode;
    accountNumber = withdrawal.accountNumber;
  }
  const payload = {
    payout_method: 'bank_transfer',
    bank_uuid: bankUuid,
    amount: String(Math.round(withdrawal.payoutAmount)),
    charge_id: `PLATFORM-PAYOUT-${withdrawal.id}`,
    bank_account_name: accountName,
    bank_account_number: accountNumber,
  };
  await (prisma as any).platformWithdrawal.update({ where: { id: withdrawal.id }, data: { gatewayPayload: JSON.stringify({ provider: 'paychangu', action: 'payouts.initialize', payload }) } });
  const response = await axios.post('https://api.paychangu.com/direct-charge/payouts/initialize', payload, {
    headers: { Authorization: `Bearer ${PAYCHANGU_SECRET_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' },
  });
  await (prisma as any).platformWithdrawal.update({
    where: { id: withdrawal.id },
    data: { status: 'processing', chargeId: `PLATFORM-PAYOUT-${withdrawal.id}`, gatewayResponse: JSON.stringify({ initializeResponse: response.data }) },
  });
}

export async function requestAdminTreasuryWithdrawal(req: Request, res: Response): Promise<void> {
  const parsed = treasuryConfirmSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }
  const validation = validateMobileOperatorNumber(parsed.data);
  if (validation) { res.status(400).json({ success: false, message: validation }); return; }
  const userId = req.user!.userId;
  const otp = await (prisma as any).platformWithdrawalOtp.findFirst({
    where: { userId, payloadHash: getPayloadHash(parsed.data), usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!otp) { res.status(400).json({ success: false, message: 'OTP is missing or expired. Request a new OTP code.' }); return; }
  if (otp.attempts >= OTP_MAX_ATTEMPTS) {
    await (prisma as any).platformWithdrawalOtp.update({ where: { id: otp.id }, data: { usedAt: new Date() } });
    res.status(400).json({ success: false, message: 'Too many OTP attempts. Request a new OTP code.' });
    return;
  }
  const otpValid = await bcrypt.compare(parsed.data.otpCode, otp.otpHash);
  if (!otpValid) {
    await (prisma as any).platformWithdrawalOtp.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
    res.status(400).json({ success: false, message: 'Invalid OTP code' });
    return;
  }
  const fees = calculatePlatformPayoutFee(parsed.data.amount, parsed.data.method, parsed.data.mobileOperator);
  const summary = await getTreasurySummaryData();
  if (fees.netAmount > summary.safeAvailableBalance) {
    res.status(400).json({ success: false, message: `Insufficient platform safe balance to withdraw ${fees.amount}. You need ${fees.netAmount} including payout cost, but safe balance is ${summary.safeAvailableBalance}.` });
    return;
  }
  await (prisma as any).platformWithdrawalOtp.update({ where: { id: otp.id }, data: { usedAt: new Date() } });
  const withdrawal = await (prisma as any).platformWithdrawal.create({
    data: {
      initiatedBy: userId,
      amount: fees.amount,
      fee: fees.fee,
      gatewayFeeAmount: fees.gatewayFeeAmount,
      gatewayFeeRate: fees.gatewayFeeRate,
      bankFixedFeeAmount: fees.bankFixedFeeAmount,
      netAmount: fees.netAmount,
      payoutAmount: fees.payoutAmount,
      method: parsed.data.method,
      mobileOperator: parsed.data.mobileOperator,
      mobileNumber: parsed.data.mobileNumber,
      bankCode: parsed.data.bankCode,
      accountName: parsed.data.accountName,
      accountNumber: parsed.data.accountNumber,
      status: 'pending',
    },
  });
  try {
    await processPlatformPayout(withdrawal);
    const updated = await (prisma as any).platformWithdrawal.findUnique({ where: { id: withdrawal.id } });
    res.json({ success: true, data: updated });
  } catch (error: any) {
    await (prisma as any).platformWithdrawal.update({
      where: { id: withdrawal.id },
      data: { status: 'failed', failureReason: String(error.response?.data?.message || error.message || 'Payout failed').substring(0, 500), gatewayResponse: JSON.stringify({ error: error.response?.data || error.message }) },
    });
    res.status(500).json({ success: false, message: error.response?.data?.message || error.message || 'Platform withdrawal failed' });
  }
}

export async function reconcileAdminWithdrawal(req: Request, res: Response): Promise<void> {
  const kind = String(req.params.kind);
  const id = String(req.params.id);
  if (!['ministry', 'platform'].includes(kind)) {
    res.status(400).json({ success: false, message: 'Invalid withdrawal type' });
    return;
  }

  const withdrawal = kind === 'ministry'
    ? await prisma.withdrawal.findUnique({ where: { id } }) as any
    : await (prisma as any).platformWithdrawal.findUnique({ where: { id } });

  if (!withdrawal) {
    res.status(404).json({ success: false, message: 'Withdrawal not found' });
    return;
  }
  if (!withdrawal.chargeId) {
    res.status(400).json({ success: false, message: 'Withdrawal has no gateway charge ID to reconcile' });
    return;
  }

  try {
    const result = await fetchPayoutStatus(withdrawal.chargeId);
    const normalized = normalizePayoutStatus(result.payload);
    const gatewayResponse = JSON.stringify({
      previous: safeParseJson(withdrawal.gatewayResponse),
      reconciliation: {
        checkedAt: new Date().toISOString(),
        checkedBy: req.user?.userId,
        endpoint: result.url,
        payload: result.payload,
        normalizedStatus: normalized,
      },
    });

    if (normalized === 'completed') {
      const data = { status: 'completed', processedAt: new Date(), failureReason: null, gatewayResponse };
      const updated = kind === 'ministry'
        ? await prisma.withdrawal.update({ where: { id }, data: data as any })
        : await (prisma as any).platformWithdrawal.update({ where: { id }, data });
      res.json({ success: true, message: 'Withdrawal reconciled as completed', data: updated });
      return;
    }

    if (normalized === 'failed') {
      if (kind === 'ministry' && withdrawal.status !== 'failed') {
        await refundWithdrawal(id);
      }
      const data = {
        status: 'failed',
        failureReason: 'Reconciled with PayChangu as failed.',
        gatewayResponse,
      };
      const updated = kind === 'ministry'
        ? await prisma.withdrawal.update({ where: { id }, data: data as any })
        : await (prisma as any).platformWithdrawal.update({ where: { id }, data });
      res.json({ success: true, message: kind === 'ministry' ? 'Withdrawal reconciled as failed and refunded' : 'Platform withdrawal reconciled as failed', data: updated });
      return;
    }

    const data = {
      status: normalized === 'processing' ? 'processing' : 'review_required',
      failureReason: normalized === 'processing' ? null : 'PayChangu reconciliation returned an unclear payout status. Manual review still required.',
      gatewayResponse,
    };
    const updated = kind === 'ministry'
      ? await prisma.withdrawal.update({ where: { id }, data: data as any })
      : await (prisma as any).platformWithdrawal.update({ where: { id }, data });
    res.json({ success: true, message: 'Reconciliation checked, but payout is not final yet', data: updated });
  } catch (error: any) {
    const message = error.response?.data?.message || error.message || 'Failed to reconcile payout';
    const data = {
      status: 'review_required',
      failureReason: `Reconciliation failed: ${message}`,
      gatewayResponse: JSON.stringify({
        previous: safeParseJson(withdrawal.gatewayResponse),
        reconciliationError: error.response?.data || error.message,
        checkedAt: new Date().toISOString(),
        checkedBy: req.user?.userId,
      }),
    };
    const updated = kind === 'ministry'
      ? await prisma.withdrawal.update({ where: { id }, data: data as any })
      : await (prisma as any).platformWithdrawal.update({ where: { id }, data });
    res.status(502).json({ success: false, message, data: updated });
  }
}
