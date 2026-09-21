import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { hashPassword, comparePassword } from '../lib/password';

const DEFAULT_RATE = 0.2;
const COMMISSION_RATE_ENV = 'REFERRAL_COMMISSION_RATE';

type DbClient = typeof prisma | Prisma.TransactionClient;

export function normalizeReferralCode(code?: string | null): string | null {
  const value = String(code || '').trim().toUpperCase();
  return value || null;
}

export function getReferralCommissionRate(): number {
  const raw = process.env[COMMISSION_RATE_ENV];
  if (!raw) return DEFAULT_RATE;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RATE;
  return parsed > 1 ? parsed / 100 : parsed;
}

export function referralLinkForCode(code: string): string {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:8080';
  return `${frontendUrl.replace(/\/$/, '')}/register?ref=${encodeURIComponent(code)}`;
}

export async function generateUniqueReferralCode(db: DbClient = prisma): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const suffix = crypto.randomBytes(4).toString('hex').toUpperCase();
    const code = `ICIMS-REF-${suffix}`;
    const exists = await db.referrer.findUnique({ where: { code }, select: { id: true } });
    if (!exists) return code;
  }
  throw new Error('Could not generate a unique referral code');
}

export async function ensureReferrerRole(db: DbClient = prisma) {
  return db.role.upsert({
    where: { name: 'referrer' },
    update: {},
    create: {
      name: 'referrer',
      displayName: 'Referrer',
      description: 'Referral partner account',
      isSystemRole: true,
    },
  });
}

export async function linkReferralToMinistry(params: {
  db?: DbClient;
  referralCode?: string | null;
  ministryAdminId: string;
  churchId?: string | null;
}) {
  const db = params.db || prisma;
  const code = normalizeReferralCode(params.referralCode);
  if (!code) return null;

  const referrer = await db.referrer.findFirst({
    where: { code, status: 'approved' },
    select: { id: true, code: true },
  });
  if (!referrer) return null;

  return db.referralLink.upsert({
    where: { ministryAdminId: params.ministryAdminId },
    create: {
      referrerId: referrer.id,
      ministryAdminId: params.ministryAdminId,
      churchId: params.churchId || null,
      referralCode: referrer.code,
    },
    update: {},
  });
}

export async function getReferrerBalance(referrerId: string, db: DbClient = prisma): Promise<number> {
  const entries = await db.referrerLedgerEntry.findMany({
    where: { referrerId },
    select: { direction: true, amount: true },
  });

  return entries.reduce((total, entry) => {
    const amount = Number(entry.amount);
    return entry.direction === 'credit' ? total + amount : total - amount;
  }, 0);
}

function money(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2);
}

export async function handleCompletedPackagePayment(paymentId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({ where: { id: paymentId } });
    if (!payment || payment.status !== 'completed') return;
    if (payment.referralCommissionStatus === 'credited') return;

    const referral = await tx.referralLink.findUnique({
      where: { ministryAdminId: payment.ministryAdminId },
      include: { referrer: true },
    });
    if (!referral || referral.referrer.status !== 'approved') return;

    const commissionableAmount = Number(payment.baseAmount ?? payment.amount ?? 0);
    if (!Number.isFinite(commissionableAmount) || commissionableAmount <= 0) return;

    const rate = getReferralCommissionRate();
    const commissionAmount = Math.round(commissionableAmount * rate * 100) / 100;
    if (commissionAmount <= 0) return;

    const balanceBefore = await getReferrerBalance(referral.referrerId, tx);
    const balanceAfter = balanceBefore + commissionAmount;

    try {
      await tx.referrerLedgerEntry.create({
        data: {
          referrerId: referral.referrerId,
          direction: 'credit',
          category: 'commission',
          amount: money(commissionAmount),
          currency: payment.currency,
          balanceAfter: money(balanceAfter),
          sourceType: 'payment',
          sourceId: payment.id,
          paymentId: payment.id,
          description: `Referral commission for payment ${payment.reference || payment.id}`,
        },
      });
    } catch (error: any) {
      if (error?.code !== 'P2002') throw error;
    }

    await tx.payment.update({
      where: { id: payment.id },
      data: {
        referralId: referral.id,
        referrerId: referral.referrerId,
        referralCommissionRate: rate.toFixed(6),
        referralCommissionAmount: money(commissionAmount),
        referralCommissionStatus: 'credited',
      },
    });

    await tx.referralLink.update({
      where: { id: referral.id },
      data: {
        status: referral.firstPaymentAt ? referral.status : 'first_payment_made',
        firstPaymentAt: referral.firstPaymentAt || payment.paidAt || new Date(),
      },
    });
  });
}

export async function createWithdrawalOtp(referrerId: string, payload: unknown) {
  const otp = crypto.randomInt(100000, 999999).toString();
  const payloadHash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  const record = await prisma.referrerWithdrawalOtp.create({
    data: {
      referrerId,
      otpHash: await hashPassword(otp),
      payloadHash,
      expiresAt,
    },
  });

  return { record, otp: process.env.NODE_ENV === 'production' ? undefined : otp, payloadHash };
}

export async function consumeWithdrawalOtp(referrerId: string, otp: string, payload: unknown) {
  const payloadHash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const record = await prisma.referrerWithdrawalOtp.findFirst({
    where: { referrerId, payloadHash, usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!record) return null;
  if (!(await comparePassword(otp, record.otpHash))) {
    await prisma.referrerWithdrawalOtp.update({ where: { id: record.id }, data: { attempts: { increment: 1 } } });
    return null;
  }
  await prisma.referrerWithdrawalOtp.update({ where: { id: record.id }, data: { usedAt: new Date() } });
  return record;
}
