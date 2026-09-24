import axios from 'axios';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { recordWithdrawalEvent } from '../middleware/metrics';
import { fetchPaychanguMobilePayoutProviders } from './payoutProviderOptionsService';
import { getReferrerBalance } from './referralService';
import { logger, maskPhone } from '../utils/logger';

const PAYCHANGU_SECRET_KEY = process.env.PAYCHANGU_SECRET_KEY || '';

function money(value: number) {
  return new Prisma.Decimal(Math.round(value * 100) / 100);
}

function normalizeRate(raw: number) {
  return raw > 1 ? raw / 100 : raw;
}

function optionalEnv(key: string, fallback: number) {
  const value = Number(process.env[key] || fallback);
  return Number.isFinite(value) ? value : fallback;
}

function minimumPayoutAmount() {
  const value = Number(process.env.MARKETER_PAYOUT_MIN_AMOUNT || 1);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function ceilMoney(value: number) {
  return Math.ceil(value);
}

function normalizePaychanguMobilePayoutNumber(value?: string | null): string {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('265')) return `0${digits.slice(3)}`;
  if (digits.length === 9) return `0${digits}`;
  return digits;
}

function safeJsonParse(value?: string | null): any {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function collectValuesByKeys(source: unknown, keys: Set<string>, values: string[] = [], seen = new Set<unknown>()): string[] {
  if (!source || typeof source !== 'object' || seen.has(source)) return values;
  seen.add(source);
  if (Array.isArray(source)) {
    source.forEach(item => collectValuesByKeys(item, keys, values, seen));
    return values;
  }
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (keys.has(key) && value != null) values.push(String(value).trim());
    collectValuesByKeys(value, keys, values, seen);
  }
  return values;
}

function getNestedValue(source: any, path: string): unknown {
  return path.split('.').reduce((value, key) => value?.[key], source);
}

function normalizePayoutStatus(payload: any): 'completed' | 'failed' | 'processing' | null {
  const status = String(
    payload?.data?.status ||
    payload?.status ||
    payload?.data?.transaction_status ||
    payload?.transaction_status ||
    '',
  ).toLowerCase();

  if (['success', 'successful', 'completed', 'paid'].includes(status)) return 'completed';
  if (['failed', 'failure', 'cancelled', 'canceled', 'reversed', 'rejected'].includes(status)) return 'failed';
  if (['pending', 'processing', 'queued', 'initiated'].includes(status)) return 'processing';
  return null;
}

function getPaychanguLookupIds(withdrawal: any): string[] {
  const parsedResponse = safeJsonParse(withdrawal.gatewayResponse);
  const parsedPayload = safeJsonParse(withdrawal.gatewayPayload);
  const nestedIds = collectValuesByKeys(parsedResponse, new Set(['charge_id', 'ref_id', 'reference', 'trans_id']));
  return [...new Set([
    withdrawal.chargeId,
    ...nestedIds,
    getNestedValue(parsedResponse, 'initializeResponse.data.charge_id'),
    getNestedValue(parsedResponse, 'initializeResponse.data.id'),
    getNestedValue(parsedResponse, 'initializeResponse.data.ref_id'),
    getNestedValue(parsedResponse, 'initializeResponse.data.reference'),
    getNestedValue(parsedResponse, 'initializeResponse.data.trans_id'),
    getNestedValue(parsedResponse, 'initializeResponse.charge_id'),
    getNestedValue(parsedResponse, 'initializeResponse.id'),
    getNestedValue(parsedResponse, 'initializeResponse.ref_id'),
    getNestedValue(parsedResponse, 'initializeResponse.reference'),
    getNestedValue(parsedResponse, 'initializeResponse.trans_id'),
    getNestedValue(parsedPayload, 'payload.charge_id'),
  ].map(value => value == null ? '' : String(value).trim()).filter(Boolean))];
}

async function fetchPaychanguPayoutStatus(withdrawal: any) {
  const lookupIds = getPaychanguLookupIds(withdrawal);
  const attempts: Array<{ lookupId: string; url: string; status?: number; error?: any }> = [];
  for (const lookupId of lookupIds) {
    const url = `https://api.paychangu.com/mobile-money/payments/${encodeURIComponent(lookupId)}/details`;
    try {
      const response = await axios.get(url, {
        headers: { Authorization: `Bearer ${PAYCHANGU_SECRET_KEY}`, Accept: 'application/json' },
      });
      return { url, lookupId, payload: response.data, attempts };
    } catch (error: any) {
      attempts.push({ lookupId, url, status: error.response?.status, error: error.response?.data || error.message });
    }
  }
  const error: any = new Error('PayChangu marketer payout lookup failed for all known references');
  error.reconciliationAttempts = attempts;
  throw error;
}

function normalizeOperator(value?: string | null): 'airtel' | 'tnm' | null {
  const provider = String(value || '').toLowerCase();
  if (provider.includes('airtel')) return 'airtel';
  if (provider.includes('tnm') || provider.includes('mpamba')) return 'tnm';

  const digits = String(value || '').replace(/\D/g, '');
  const local = digits.startsWith('265') ? `0${digits.slice(3)}` : digits;
  if (local.startsWith('099') || local.startsWith('098')) return 'airtel';
  if (local.startsWith('088') || local.startsWith('089')) return 'tnm';
  return null;
}

function calculateReferrerPayoutFees(balance: number, operator: 'airtel' | 'tnm') {
  const rate = normalizeRate(operator === 'airtel'
    ? optionalEnv('WITHDRAWAL_AIRTEL_MONEY_FEE_RATE', 0.018)
    : optionalEnv('WITHDRAWAL_TNM_MPAMBA_FEE_RATE', 0.015));
  const feeAmount = ceilMoney(balance * rate);
  const payoutAmount = Math.max(0, Math.round((balance - feeAmount) * 100) / 100);
  return { feeAmount, gatewayFeeRate: rate, payoutAmount };
}

class ReferrerPayoutError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function normalizePayoutAmount(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ReferrerPayoutError('Enter a valid payout amount.');
  }
  return Math.round(value * 100) / 100;
}

async function buildReferrerPayoutPlan(referrerId: string, amount: number) {
  const payoutAmount = normalizePayoutAmount(amount);
  const minimumAmount = minimumPayoutAmount();

  if (payoutAmount < minimumAmount) {
    throw new ReferrerPayoutError(`Minimum marketer payout amount is ${minimumAmount}.`);
  }

  const referrer = await prisma.referrer.findUnique({
    where: { id: referrerId },
    include: { pricingMarket: true },
  });
  if (!referrer) throw new ReferrerPayoutError('Marketer not found.', 404);
  if (referrer.status !== 'approved') throw new ReferrerPayoutError('Only approved marketers can receive payouts.');
  if (referrer.payoutSetupStatus !== 'complete' || !referrer.payoutPhone || !referrer.payoutProvider) {
    throw new ReferrerPayoutError('Marketer payout settings must be complete before payout.');
  }

  const active = await prisma.referrerWithdrawal.findFirst({
    where: { referrerId, status: { in: ['pending', 'processing', 'review_required'] } },
    select: { id: true },
  });
  if (active) {
    throw new ReferrerPayoutError('This marketer already has an active payout. Reconcile or complete it first.');
  }

  const balance = await getReferrerBalance(referrerId);
  if (payoutAmount > balance) throw new ReferrerPayoutError('Payout amount exceeds available wallet balance.');

  const operator = normalizeOperator(referrer.payoutProvider);
  if (!operator) throw new ReferrerPayoutError('Missing or unsupported marketer payout provider.');

  const fees = calculateReferrerPayoutFees(payoutAmount, operator);
  if (fees.payoutAmount < minimumAmount) {
    throw new ReferrerPayoutError(`Payout amount after provider fees must be at least ${minimumAmount}.`);
  }

  return {
    referrer,
    amount: payoutAmount,
    balance,
    minimumAmount,
    currency: String(referrer.pricingMarket?.currencyCode || 'MWK').toUpperCase(),
    operator,
    mobileNumber: referrer.payoutPhone,
    fees,
  };
}

function referrerPayoutPlanDto(plan: Awaited<ReturnType<typeof buildReferrerPayoutPlan>>) {
  return {
    referrerId: plan.referrer.id,
    balance: plan.balance,
    minimumAmount: plan.minimumAmount,
    currency: plan.currency,
    amount: plan.amount,
    feeAmount: plan.fees.feeAmount,
    gatewayFeeRate: plan.fees.gatewayFeeRate,
    payoutAmount: plan.fees.payoutAmount,
    mobileOperator: plan.operator,
    mobileNumber: plan.mobileNumber,
  };
}

async function resolvePaychanguOperatorRefId(operator: 'airtel' | 'tnm') {
  const envValue = operator === 'airtel'
    ? process.env.PAYCHANGU_AIRTEL_MONEY_OPERATOR_REF_ID
    : process.env.PAYCHANGU_TNM_MPAMBA_OPERATOR_REF_ID;
  if (envValue) return envValue;

  const providers = await fetchPaychanguMobilePayoutProviders();
  const match = providers.find(provider => provider.code === operator);
  return match?.raw?.ref_id || match?.raw?.mobile_money_operator_ref_id || match?.raw?.operator_ref_id || null;
}

export async function previewAdminReferrerPayout(referrerId: string, amount: number) {
  const plan = await buildReferrerPayoutPlan(referrerId, amount);
  return referrerPayoutPlanDto(plan);
}

export async function createAdminReferrerWithdrawalPayout(referrerId: string, amount: number, adminId?: string) {
  const plan = await buildReferrerPayoutPlan(referrerId, amount);
  const withdrawal = await (prisma as any).referrerWithdrawal.create({
    data: {
      referrerId,
      amount: money(plan.amount),
      currency: plan.currency,
      status: 'pending',
      method: 'mobile_money',
      mobileOperator: plan.operator,
      mobileNumber: plan.mobileNumber,
      feeAmount: money(plan.fees.feeAmount),
      gatewayFeeRate: plan.fees.gatewayFeeRate.toFixed(6),
      payoutAmount: money(plan.fees.payoutAmount),
      processedById: adminId,
      approvedAt: new Date(),
      notes: 'Admin initiated marketer commission payout',
    },
  });

  const initiated = await initiateReferrerWithdrawalPayout(withdrawal.id);
  return { withdrawal: initiated, preview: referrerPayoutPlanDto(plan) };
}

export async function createAutomaticReferrerWithdrawal(referrer: any) {
  const active = await prisma.referrerWithdrawal.findFirst({
    where: { referrerId: referrer.id, status: { in: ['pending', 'processing', 'review_required'] } },
    select: { id: true },
  });
  if (active) return null;

  const balance = await getReferrerBalance(referrer.id);
  const minAmount = minimumPayoutAmount();
  if (balance < minAmount) return null;

  const operator = normalizeOperator(referrer.payoutProvider);
  if (!operator || !referrer.payoutPhone) return null;

  const fees = calculateReferrerPayoutFees(balance, operator);
  if (fees.payoutAmount < minAmount) return null;

  return (prisma as any).referrerWithdrawal.create({
    data: {
      referrerId: referrer.id,
      amount: money(balance),
      currency: String(referrer.pricingMarket?.currencyCode || 'MWK').toUpperCase(),
      status: 'pending',
      method: 'mobile_money',
      mobileOperator: operator,
      mobileNumber: referrer.payoutPhone,
      feeAmount: money(fees.feeAmount),
      gatewayFeeRate: fees.gatewayFeeRate.toFixed(6),
      payoutAmount: money(fees.payoutAmount),
      notes: 'Automatic marketer commission payout',
    },
  });
}

export async function initiateReferrerWithdrawalPayout(withdrawalId: string) {
  const withdrawal = await (prisma as any).referrerWithdrawal.findUnique({
    where: { id: withdrawalId },
    include: { referrer: true },
  });
  if (!withdrawal || withdrawal.status !== 'pending') return withdrawal;

  const operator = normalizeOperator(withdrawal.mobileOperator || withdrawal.referrer?.payoutProvider);
  if (!operator) throw new Error('Missing or unsupported marketer payout provider.');
  const operatorRefId = await resolvePaychanguOperatorRefId(operator);
  if (!operatorRefId) throw new Error(`Unable to resolve PayChangu operator ref_id for ${operator}.`);
  if (!withdrawal.mobileNumber) throw new Error('Missing marketer payout phone number.');

  const chargeId = `MARKETER-PAYOUT-${withdrawal.id}`;
  const payoutPayload = {
    mobile: normalizePaychanguMobilePayoutNumber(withdrawal.mobileNumber),
    mobile_money_operator_ref_id: operatorRefId,
    amount: String(withdrawal.payoutAmount || withdrawal.amount),
    charge_id: chargeId,
  };

  await (prisma as any).referrerWithdrawal.update({
    where: { id: withdrawal.id },
    data: {
      status: 'processing',
      chargeId,
      attempts: { increment: 1 },
      gatewayPayload: JSON.stringify({
        provider: 'paychangu',
        action: 'mobile-money.payouts.initialize',
        payload: payoutPayload,
      }),
    },
  });

  try {
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

    await (prisma as any).referrerWithdrawal.update({
      where: { id: withdrawal.id },
      data: {
        gatewayResponse: JSON.stringify({ initializeResponse: response.data }),
      },
    });

    recordWithdrawalEvent('mobile_money', 'processing', 'marketer', {
      withdrawalId: withdrawal.id,
      chargeId,
      amount: Number(withdrawal.amount),
      payoutAmount: Number(withdrawal.payoutAmount),
      mobileOperator: operator,
      mobileNumber: maskPhone(withdrawal.mobileNumber),
    });

    return (prisma as any).referrerWithdrawal.findUnique({ where: { id: withdrawal.id } });
  } catch (error: any) {
    const failureReason = String(error.response?.data?.message || error.message || 'Marketer payout failed').substring(0, 2000);
    await (prisma as any).referrerWithdrawal.update({
      where: { id: withdrawal.id },
      data: {
        status: 'failed',
        failureReason,
        gatewayResponse: JSON.stringify({ error: error.response?.data ?? { message: error.message }, status: error.response?.status ?? null }),
      },
    });
    recordWithdrawalEvent('mobile_money', 'failed', 'marketer', {
      withdrawalId: withdrawal.id,
      chargeId,
      amount: Number(withdrawal.amount),
      payoutAmount: Number(withdrawal.payoutAmount),
      mobileOperator: operator,
      mobileNumber: maskPhone(withdrawal.mobileNumber),
      errorMessage: failureReason,
    });
    throw error;
  }
}

async function postReferrerPayoutDebit(withdrawal: any, tx: Prisma.TransactionClient) {
  const balanceBefore = await getReferrerBalance(withdrawal.referrerId, tx);
  const debitAmount = Number(withdrawal.amount || 0);
  const balanceAfter = balanceBefore - debitAmount;

  await tx.referrerLedgerEntry.create({
    data: {
      referrerId: withdrawal.referrerId,
      direction: 'debit',
      category: 'withdrawal',
      amount: money(debitAmount),
      currency: withdrawal.currency || 'MWK',
      balanceAfter: money(balanceAfter),
      sourceType: 'referrer_withdrawal',
      sourceId: withdrawal.id,
      withdrawalId: withdrawal.id,
      description: `Automatic marketer payout ${withdrawal.chargeId || withdrawal.id}`,
    },
  }).catch((error: any) => {
    if (error?.code !== 'P2002') throw error;
  });
}

export async function markReferrerPayoutCompleted(withdrawalId: string, payload: any = {}) {
  return prisma.$transaction(async (tx) => {
    const withdrawal = await (tx as any).referrerWithdrawal.findUnique({ where: { id: withdrawalId } });
    if (!withdrawal) return null;
    if (withdrawal.status === 'paid') return withdrawal;

    await postReferrerPayoutDebit(withdrawal, tx);
    return (tx as any).referrerWithdrawal.update({
      where: { id: withdrawalId },
      data: {
        status: 'paid',
        paidAt: new Date(),
        processedAt: new Date(),
        failureReason: null,
        gatewayResponse: JSON.stringify({
          previous: safeJsonParse(withdrawal.gatewayResponse),
          webhookPayload: payload,
        }),
      },
    });
  });
}

export async function markReferrerPayoutFailed(withdrawalId: string, reason: string, payload: any = {}) {
  return (prisma as any).referrerWithdrawal.update({
    where: { id: withdrawalId },
    data: {
      status: 'failed',
      failureReason: reason.substring(0, 2000),
      gatewayResponse: JSON.stringify({ webhookPayload: payload }),
    },
  });
}

export async function reconcileReferrerWithdrawalPayout(withdrawalId: string, checkedBy?: string) {
  const withdrawal = await (prisma as any).referrerWithdrawal.findUnique({ where: { id: withdrawalId } });
  if (!withdrawal) return { status: 'missing' as const, data: null };
  if (!withdrawal.chargeId) {
    const updated = await (prisma as any).referrerWithdrawal.update({
      where: { id: withdrawalId },
      data: {
        status: 'failed',
        failureReason: 'Manual reconciliation: no PayChangu payout reference exists.',
        gatewayResponse: JSON.stringify({
          previous: safeJsonParse(withdrawal.gatewayResponse),
          reconciliation: {
            checkedAt: new Date().toISOString(),
            checkedBy,
            source: 'manual_no_gateway_charge_id',
            normalizedStatus: 'failed',
          },
        }),
      },
    });
    return { status: 'failed' as const, data: updated };
  }

  const result = await fetchPaychanguPayoutStatus(withdrawal);
  const normalized = normalizePayoutStatus(result.payload);
  const gatewayResponse = JSON.stringify({
    previous: safeJsonParse(withdrawal.gatewayResponse),
    reconciliation: {
      checkedAt: new Date().toISOString(),
      checkedBy,
      endpoint: result.url,
      lookupId: result.lookupId,
      attempts: result.attempts,
      payload: result.payload,
      normalizedStatus: normalized,
    },
  });

  if (normalized === 'completed') {
    const updated = await markReferrerPayoutCompleted(withdrawalId, result.payload);
    return { status: 'completed' as const, data: updated };
  }

  if (normalized === 'failed') {
    const updated = await markReferrerPayoutFailed(withdrawalId, 'Reconciled with PayChangu as failed.', result.payload);
    return { status: 'failed' as const, data: updated };
  }

  const updated = await (prisma as any).referrerWithdrawal.update({
    where: { id: withdrawalId },
    data: {
      status: normalized === 'processing' ? 'processing' : 'review_required',
      failureReason: normalized === 'processing' ? null : 'PayChangu reconciliation returned an unclear payout status. Manual review still required.',
      gatewayResponse,
    },
  });
  return { status: normalized === 'processing' ? 'processing' as const : 'review_required' as const, data: updated };
}

export async function processAutomaticReferrerPayouts(options: { limit?: number; traceId?: string } = {}) {
  const traceId = options.traceId || `MARKETER-PAYOUT-${Date.now()}`;
  const limit = options.limit || 100;
  const referrers = await prisma.referrer.findMany({
    where: {
      status: 'approved',
      payoutSetupStatus: 'complete',
      payoutPhone: { not: null },
      payoutProvider: { not: null },
    },
    include: { pricingMarket: true },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });

  let created = 0;
  let initiated = 0;
  let failed = 0;

  for (const referrer of referrers) {
    try {
      const withdrawal = await createAutomaticReferrerWithdrawal(referrer);
      if (!withdrawal) continue;
      created += 1;
      await initiateReferrerWithdrawalPayout(withdrawal.id);
      initiated += 1;
    } catch (error) {
      failed += 1;
      logger.error('marketer_payout_worker_item_failed', { traceId, referrerId: referrer.id, error });
    }
  }

  logger.info('marketer_payout_worker_finished', { traceId, checked: referrers.length, created, initiated, failed });
  return { checked: referrers.length, created, initiated, failed };
}
