import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { hashPassword } from '../lib/password';
import {
  consumeWithdrawalOtp,
  consumePayoutSetupEditSession,
  createPayoutSetupEditSession,
  createWithdrawalOtp,
  ensureReferrerRole,
  generateUniqueReferralCode,
  getReferrerBalance,
  getWithdrawalOtpResendWaitSeconds,
  referralLinkForCode,
} from '../services/referralService';
import { sendEmailVerificationOtp } from '../services/emailVerificationService';
import { fetchPayoutProvidersForMarket } from '../services/payoutProviderOptionsService';
import { queueEmail } from '../lib/emailQueue';
import { phoneSchema } from '../lib/inputValidation';
import {
  createAdminReferrerWithdrawalPayout,
  previewAdminReferrerPayout,
  reconcileReferrerWithdrawalPayout,
} from '../services/referrerPayoutService';

const registerReferrerSchema = z.object({
  firstName: z.string().min(2, 'First name must be at least 2 characters'),
  lastName: z.string().min(2, 'Last name must be at least 2 characters'),
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  phone: z.string().min(6, 'Phone number is required'),
  country: z.string().min(2, 'Country is required'),
  city: z.string().min(1, 'City is required'),
  district: z.string().min(1, 'District is required'),
  acceptedTerms: z.literal(true, {
    errorMap: () => ({ message: 'You must accept the Partner Terms to register as a referrer' }),
  }),
});

const statusSchema = z.object({
  status: z.enum(['pending', 'approved', 'suspended', 'rejected']),
  reason: z.string().optional(),
});

const withdrawalOtpSchema = z.object({
  amount: z.coerce.number().positive(),
  method: z.string().min(2),
  accountName: z.string().optional(),
  accountNumber: z.string().optional(),
  mobileNumber: z.string().optional(),
  bankName: z.string().optional(),
});

const withdrawalConfirmSchema = withdrawalOtpSchema.extend({
  otp: z.string().length(6),
});

const payoutSetupSchema = z.object({
  payoutPhone: phoneSchema,
  payoutProvider: z.string().min(2, 'Payout provider is required'),
});

const payoutSetupConfirmSchema = payoutSetupSchema.extend({
  editToken: z.string().min(32, 'Payout edit session is required'),
});

const payoutSetupOtpVerifySchema = z.object({
  otp: z.string().regex(/^\d{6}$/, 'Enter the 6-digit OTP code'),
});

const adminReferrerPayoutSchema = z.object({
  amount: z.coerce.number().positive('Enter a valid payout amount'),
});

async function resolveCountryMarket(countryName: string, db: typeof prisma | any = prisma) {
  const country = await db.country.findFirst({
    where: {
      isActive: true,
      OR: [
        { name: { equals: countryName } },
        { iso2: { equals: countryName.toUpperCase() } },
      ],
    },
    include: { pricingMarket: true },
  });
  return country?.pricingMarket?.isActive ? country.pricingMarket : null;
}

async function getCurrentReferrer(userId?: string) {
  if (!userId) return null;
  return prisma.referrer.findUnique({
    where: { userId },
    include: { pricingMarket: true },
  });
}

function referrerCurrency(referrer: { pricingMarket?: { currencyCode?: string | null } | null }) {
  return String(referrer.pricingMarket?.currencyCode || 'MWK').toUpperCase();
}

function referrerProfileDto(referrer: any) {
  return {
    id: referrer.id,
    code: referrer.code,
    type: referrer.type,
    status: referrer.status,
    displayName: referrer.displayName,
    referralLink: referralLinkForCode(referrer.code),
    country: referrer.country,
    market: referrer.pricingMarket ? {
      id: referrer.pricingMarket.id,
      code: referrer.pricingMarket.code,
      name: referrer.pricingMarket.name,
      currencyCode: referrer.pricingMarket.currencyCode,
    } : null,
    payoutPhone: referrer.payoutPhone,
    payoutProvider: referrer.payoutProvider,
    payoutSetupStatus: referrer.payoutSetupStatus,
  };
}

function referralDto(referral: any) {
  return {
    id: referral.id,
    ministryName: referral.ministryAdmin?.ministryName || referral.church?.name || 'Ministry',
    status: referral.status || 'registered',
  };
}

function ledgerDto(entry: any) {
  return {
    id: entry.id,
    direction: entry.direction,
    category: entry.category,
    amount: entry.amount,
    currency: entry.currency,
    balanceAfter: entry.balanceAfter,
    description: entry.description,
    createdAt: entry.createdAt,
  };
}

function ledgerSummary(ledger: Array<{ direction: string; amount: any }>) {
  return ledger.reduce((summary, entry) => {
    const amount = Number(entry.amount);
    if (entry.direction === 'credit') summary.totalCredits += amount;
    if (entry.direction === 'debit') summary.totalWithdrawn += amount;
    return summary;
  }, { totalCredits: 0, totalWithdrawn: 0 });
}

async function withLedgerMinistryNames(ledgerEntries: any[]) {
  const paymentIds = [...new Set(ledgerEntries.map(entry => entry.paymentId).filter(Boolean))];
  if (paymentIds.length === 0) return ledgerEntries;

  const payments = await prisma.payment.findMany({
    where: { id: { in: paymentIds } },
    select: { id: true, ministryAdminId: true },
  });
  const ministryAdminIds = [...new Set(payments.map(payment => payment.ministryAdminId).filter(Boolean))];
  const ministryAdmins = await prisma.user.findMany({
    where: { id: { in: ministryAdminIds } },
    select: { id: true, ministryName: true },
  });

  const paymentMinistryAdminId = new Map(payments.map(payment => [payment.id, payment.ministryAdminId]));
  const ministryNameByAdminId = new Map(ministryAdmins.map(admin => [admin.id, admin.ministryName]));

  return ledgerEntries.map(entry => {
    const ministryAdminId = entry.paymentId ? paymentMinistryAdminId.get(entry.paymentId) : null;
    return {
      ...entry,
      ministryName: ministryAdminId ? ministryNameByAdminId.get(ministryAdminId) || null : null,
    };
  });
}

function payoutSetupOtpPayload() {
  return { purpose: 'payout_setup_edit' };
}

function payoutSetupOtpTemplate(data: {
  firstName: string;
  otpCode: string;
  expiresInMinutes: number;
}) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111827">
      <h2 style="margin:0 0 12px">Confirm your ICIMS payout settings</h2>
      <p>Hello ${data.firstName},</p>
      <p>Use this OTP code to unlock editing for your marketer payout settings.</p>
      <div style="font-size:32px;letter-spacing:8px;font-weight:700;background:#f3f4f6;border-radius:12px;padding:18px;text-align:center;margin:20px 0">
        ${data.otpCode}
      </div>
      <p>This code expires in ${data.expiresInMinutes} minutes.</p>
      <p style="font-size:12px;color:#6b7280">If you did not request this change, do not share this code.</p>
    </div>
  `;
}

async function fetchValidPayoutProviders(referrer: { pricingMarket?: any }) {
  if (!referrer.pricingMarket) {
    throw new Error('Payout setup is not available for your selected country yet.');
  }
  return fetchPayoutProvidersForMarket(referrer.pricingMarket);
}

export async function registerReferrer(req: Request, res: Response): Promise<void> {
  const parsed = registerReferrerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const data = parsed.data;
  const existing = await prisma.user.findUnique({ where: { email: data.email } });
  if (existing) {
    res.status(409).json({ success: false, message: 'An account with this email already exists' });
    return;
  }

  const result = await prisma.$transaction(async (tx) => {
    const role = await ensureReferrerRole(tx);
    const pricingMarket = await resolveCountryMarket(data.country, tx);
    const user = await tx.user.create({
      data: {
        email: data.email,
        password: await hashPassword(data.password),
        firstName: data.firstName,
        lastName: data.lastName,
        phone: data.phone,
        emailVerified: false,
        roleId: role.id,
        status: 'active',
        loginEnabled: true,
        acceptedTerms: true,
        termsAcceptedAt: new Date(),
      },
    });
    const code = await generateUniqueReferralCode(tx);
    const referrer = await tx.referrer.create({
      data: {
        userId: user.id,
        code,
        type: 'referrer',
        status: 'pending',
        displayName: `${data.firstName} ${data.lastName}`,
        phone: data.phone,
        country: data.country,
        city: data.city,
        district: data.district,
        pricingMarketId: pricingMarket?.id || null,
        payoutSetupStatus: pricingMarket ? 'pending' : 'unsupported_market',
      },
    });
    return { user, referrer };
  });

  await sendEmailVerificationOtp(result.user.id);

  res.status(201).json({
    success: true,
    requiresEmailVerification: true,
    email: result.user.email,
    message: 'Referrer registration submitted. Verify your email to continue.',
    data: {
      id: result.referrer.id,
      status: result.referrer.status,
      code: result.referrer.code,
        referralLink: referralLinkForCode(result.referrer.code),
        payoutSetupStatus: result.referrer.payoutSetupStatus,
      },
  });
}

export async function getMyReferrerDashboard(req: Request, res: Response): Promise<void> {
  const referrer = await getCurrentReferrer(req.user?.userId);
  if (!referrer) {
    res.status(404).json({ success: false, message: 'Referrer profile not found' });
    return;
  }

  const [balance, recentReferrals, recentLedger, summaryLedger, referralsCount] = await Promise.all([
    getReferrerBalance(referrer.id),
    prisma.referralLink.findMany({
      where: { referrerId: referrer.id },
      include: {
        ministryAdmin: { select: { ministryName: true } },
        church: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
    }),
    prisma.referrerLedgerEntry.findMany({
      where: { referrerId: referrer.id },
      orderBy: { createdAt: 'desc' },
      take: 5,
    }),
    prisma.referrerLedgerEntry.findMany({
      where: { referrerId: referrer.id },
      select: { direction: true, amount: true },
    }),
    prisma.referralLink.count({ where: { referrerId: referrer.id } }),
  ]);
  const summary = ledgerSummary(summaryLedger);

  res.json({
    success: true,
    data: {
      currency: referrerCurrency(referrer),
      referrer: referrerProfileDto(referrer),
      balance,
      summary: {
        ...summary,
        referralsCount,
      },
      referrals: recentReferrals.map(referralDto),
      ledger: recentLedger.map(ledgerDto),
    },
  });
}

export async function getMyReferrerReferrals(req: Request, res: Response): Promise<void> {
  const referrer = await getCurrentReferrer(req.user?.userId);
  if (!referrer) {
    res.status(404).json({ success: false, message: 'Referrer profile not found' });
    return;
  }

  const referrals = await prisma.referralLink.findMany({
    where: { referrerId: referrer.id },
    include: {
      ministryAdmin: { select: { ministryName: true } },
      church: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  res.json({
    success: true,
    data: {
      referrer: referrerProfileDto(referrer),
      referrals: referrals.map(referralDto),
    },
  });
}

export async function getMyReferrerWallet(req: Request, res: Response): Promise<void> {
  const referrer = await getCurrentReferrer(req.user?.userId);
  if (!referrer) {
    res.status(404).json({ success: false, message: 'Referrer profile not found' });
    return;
  }

  const [balance, ledger] = await Promise.all([
    getReferrerBalance(referrer.id),
    prisma.referrerLedgerEntry.findMany({
      where: { referrerId: referrer.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
  ]);

  res.json({
    success: true,
    data: {
      currency: referrerCurrency(referrer),
      referrer: referrerProfileDto(referrer),
      balance,
      summary: ledgerSummary(ledger),
      ledger: ledger.map(ledgerDto),
    },
  });
}

export async function getMyPayoutOptions(req: Request, res: Response): Promise<void> {
  const referrer = await prisma.referrer.findUnique({
    where: { userId: req.user!.userId },
    include: { pricingMarket: true },
  });
  if (!referrer) { res.status(404).json({ success: false, message: 'Referrer profile not found' }); return; }
  if (!referrer.pricingMarket) {
    res.json({
      success: true,
      data: {
        supported: false,
        payoutSetupStatus: 'unsupported_market',
        message: 'Payout setup is not available for your selected country yet.',
        market: null,
        providers: [],
      },
    });
    return;
  }

  let providers: Awaited<ReturnType<typeof fetchPayoutProvidersForMarket>> = [];
  try {
    providers = await fetchPayoutProvidersForMarket(referrer.pricingMarket);
  } catch (error: any) {
    res.status(502).json({
      success: false,
      message: 'Failed to fetch payout providers from the payment provider.',
      error: error.response?.data || error.message,
    });
    return;
  }
  res.json({
    success: true,
    data: {
      supported: providers.length > 0,
      payoutSetupStatus: referrer.payoutSetupStatus,
      market: {
        id: referrer.pricingMarket.id,
        code: referrer.pricingMarket.code,
        name: referrer.pricingMarket.name,
      },
      providers,
    },
  });
}

export async function updateMyPayoutSetup(req: Request, res: Response): Promise<void> {
  const referrer = await prisma.referrer.findUnique({
    where: { userId: req.user!.userId },
    include: { pricingMarket: true },
  });
  if (!referrer) { res.status(404).json({ success: false, message: 'Referrer profile not found' }); return; }
  if (!referrer.pricingMarket) {
    res.status(400).json({ success: false, message: 'Payout setup is not available for your selected country yet.' });
    return;
  }

  const parsed = payoutSetupConfirmSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  let providers: Awaited<ReturnType<typeof fetchPayoutProvidersForMarket>> = [];
  try {
    providers = await fetchPayoutProvidersForMarket(referrer.pricingMarket);
  } catch (error: any) {
    res.status(502).json({
      success: false,
      message: 'Failed to fetch payout providers from the payment provider.',
      error: error.response?.data || error.message,
    });
    return;
  }
  if (!providers.some(provider => provider.code === parsed.data.payoutProvider)) {
    res.status(400).json({ success: false, message: 'Selected payout provider is not supported for your market.' });
    return;
  }

  const { editToken } = parsed.data;
  const editSession = await consumePayoutSetupEditSession(referrer.id, editToken);
  if (!editSession) { res.status(400).json({ success: false, message: 'Your payout edit session has expired. Request a new OTP.' }); return; }

  const updated = await prisma.referrer.update({
    where: { id: referrer.id },
    data: {
      payoutPhone: parsed.data.payoutPhone,
      payoutProvider: parsed.data.payoutProvider,
      payoutSetupStatus: 'complete',
    },
    include: { pricingMarket: true },
  });

  res.json({ success: true, data: updated });
}

export async function requestPayoutSetupOtp(req: Request, res: Response): Promise<void> {
  const referrer = await prisma.referrer.findUnique({
    where: { userId: req.user!.userId },
    include: {
      pricingMarket: true,
      user: { select: { id: true, email: true, firstName: true } },
    },
  });
  if (!referrer) { res.status(404).json({ success: false, message: 'Referrer profile not found' }); return; }
  if (referrer.status !== 'approved') { res.status(403).json({ success: false, message: 'Referrer account is not approved' }); return; }
  if (!referrer.user?.email) { res.status(400).json({ success: false, message: 'Your account does not have an email address for OTP verification' }); return; }

  try {
    await fetchValidPayoutProviders(referrer);
  } catch (error: any) {
    res.status(error.message?.includes('not available') ? 400 : 502).json({
      success: false,
      message: error.message || 'Failed to fetch payout providers from the payment provider.',
      error: error.response?.data,
    });
    return;
  }

  const otpPayload = payoutSetupOtpPayload();
  const resendWaitSeconds = await getWithdrawalOtpResendWaitSeconds(referrer.id, otpPayload);
  if (resendWaitSeconds > 0) {
    res.status(429).json({
      success: false,
      message: `You can request another OTP in ${resendWaitSeconds}s`,
      retryAfterSeconds: resendWaitSeconds,
    });
    return;
  }

  const { otp } = await createWithdrawalOtp(referrer.id, otpPayload, { exposeOtp: true });
  await queueEmail(
    referrer.user.email,
    'Confirm your ICIMS payout settings',
    payoutSetupOtpTemplate({
      firstName: referrer.user.firstName,
      otpCode: otp!,
      expiresInMinutes: 10,
    }),
    'referrer_payout_setup_otp',
  );

  res.json({
    success: true,
    message: `OTP sent to ${referrer.user.email}`,
    expiresInSeconds: 10 * 60,
    retryAfterSeconds: 40,
  });
}

export async function verifyPayoutSetupOtp(req: Request, res: Response): Promise<void> {
  const referrer = await getCurrentReferrer(req.user?.userId);
  if (!referrer) { res.status(404).json({ success: false, message: 'Referrer profile not found' }); return; }
  if (referrer.status !== 'approved') { res.status(403).json({ success: false, message: 'Referrer account is not approved' }); return; }

  const parsed = payoutSetupOtpVerifySchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const otpRecord = await consumeWithdrawalOtp(referrer.id, parsed.data.otp, payoutSetupOtpPayload());
  if (!otpRecord) { res.status(400).json({ success: false, message: 'Invalid or expired OTP' }); return; }

  const session = await createPayoutSetupEditSession(referrer.id);
  res.json({
    success: true,
    message: 'Payout edit session unlocked',
    data: session,
  });
}

export async function requestWithdrawalOtp(req: Request, res: Response): Promise<void> {
  const referrer = await getCurrentReferrer(req.user?.userId);
  if (!referrer) { res.status(404).json({ success: false, message: 'Referrer profile not found' }); return; }
  if (referrer.status !== 'approved') { res.status(403).json({ success: false, message: 'Referrer account is not approved' }); return; }
  if (referrer.payoutSetupStatus !== 'complete' || !referrer.payoutPhone || !referrer.payoutProvider) {
    res.status(400).json({ success: false, message: 'Complete payout setup before requesting a withdrawal.' });
    return;
  }

  const parsed = withdrawalOtpSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const balance = await getReferrerBalance(referrer.id);
  if (parsed.data.amount > balance) {
    res.status(400).json({ success: false, message: 'Withdrawal amount exceeds available balance' });
    return;
  }

  const { otp, payloadHash } = await createWithdrawalOtp(referrer.id, parsed.data);
  res.json({ success: true, message: 'Withdrawal OTP generated', data: { payloadHash, devOtp: otp } });
}

export async function confirmWithdrawal(req: Request, res: Response): Promise<void> {
  const referrer = await getCurrentReferrer(req.user?.userId);
  if (!referrer) { res.status(404).json({ success: false, message: 'Referrer profile not found' }); return; }
  if (referrer.status !== 'approved') { res.status(403).json({ success: false, message: 'Referrer account is not approved' }); return; }

  const parsed = withdrawalConfirmSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const { otp, ...payload } = parsed.data;
  const otpRecord = await consumeWithdrawalOtp(referrer.id, otp, payload);
  if (!otpRecord) { res.status(400).json({ success: false, message: 'Invalid or expired OTP' }); return; }

  const withdrawal = await prisma.$transaction(async (tx) => {
    const balance = await getReferrerBalance(referrer.id, tx);
    if (payload.amount > balance) throw new Error('Withdrawal amount exceeds available balance');
    const currency = referrerCurrency(referrer);

    const created = await tx.referrerWithdrawal.create({
      data: {
        referrerId: referrer.id,
        amount: payload.amount.toFixed(2),
        currency,
        status: 'pending',
        method: payload.method,
        accountName: payload.accountName,
        accountNumber: payload.accountNumber,
        mobileNumber: payload.mobileNumber,
        bankName: payload.bankName,
      },
    });

    await tx.referrerLedgerEntry.create({
      data: {
        referrerId: referrer.id,
        direction: 'debit',
        category: 'withdrawal',
        amount: payload.amount.toFixed(2),
        currency,
        balanceAfter: (balance - payload.amount).toFixed(2),
        sourceType: 'referrer_withdrawal',
        sourceId: created.id,
        withdrawalId: created.id,
        description: 'Referrer withdrawal request',
      },
    });

    await tx.referrerWithdrawalOtp.update({ where: { id: otpRecord.id }, data: { withdrawalId: created.id } });
    return created;
  });

  res.status(201).json({ success: true, data: withdrawal });
}

export async function listAdminReferrers(_req: Request, res: Response): Promise<void> {
  const referrers = await prisma.referrer.findMany({
    include: {
      user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, status: true, emailVerified: true } },
      pricingMarket: { select: { id: true, code: true, name: true, currencyCode: true } },
      _count: { select: { referrals: true, ledgerEntries: true, withdrawals: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ success: true, data: referrers });
}

export async function getAdminReferrer(req: Request, res: Response): Promise<void> {
  const referrer = await prisma.referrer.findUnique({
    where: { id: String(req.params.id) },
    include: {
      user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, status: true, emailVerified: true, createdAt: true } },
      pricingMarket: { select: { id: true, code: true, name: true, currencyCode: true, packageGateway: true } },
      referrals: {
        include: {
          ministryAdmin: { select: { id: true, firstName: true, lastName: true, email: true, ministryName: true, accountCountry: true } },
          church: { select: { id: true, name: true, country: true } },
        },
        orderBy: { createdAt: 'desc' },
      },
      ledgerEntries: { orderBy: { createdAt: 'desc' }, take: 100 },
      withdrawals: { orderBy: { createdAt: 'desc' }, take: 50 },
    },
  });

  if (!referrer) { res.status(404).json({ success: false, message: 'Marketer not found' }); return; }

  const balance = await getReferrerBalance(referrer.id);
  const ledgerEntries = await withLedgerMinistryNames(referrer.ledgerEntries);
  res.json({ success: true, data: { ...referrer, ledgerEntries, balance, currency: referrerCurrency(referrer) } });
}

export async function updateAdminReferrerStatus(req: Request, res: Response): Promise<void> {
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const updated = await prisma.referrer.update({
    where: { id: String(req.params.id) },
    data: {
      status: parsed.data.status,
      approvedAt: parsed.data.status === 'approved' ? new Date() : undefined,
      approvedById: parsed.data.status === 'approved' ? req.user?.userId : undefined,
      rejectionReason: parsed.data.status === 'rejected' || parsed.data.status === 'suspended' ? parsed.data.reason : null,
    },
  });
  res.json({ success: true, data: updated });
}

export async function previewAdminReferrerWithdrawal(req: Request, res: Response): Promise<void> {
  const parsed = adminReferrerPayoutSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  try {
    const preview = await previewAdminReferrerPayout(String(req.params.id), parsed.data.amount);
    res.json({ success: true, data: preview });
  } catch (error: any) {
    res.status(error.statusCode || 400).json({
      success: false,
      message: error.message || 'Unable to preview marketer payout',
    });
  }
}

export async function initiateAdminReferrerWithdrawal(req: Request, res: Response): Promise<void> {
  const parsed = adminReferrerPayoutSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  try {
    const result = await createAdminReferrerWithdrawalPayout(String(req.params.id), parsed.data.amount, req.user?.userId);
    res.status(201).json({
      success: true,
      message: 'Marketer payout initiated',
      data: result,
    });
  } catch (error: any) {
    res.status(error.statusCode || (error.response ? 502 : 400)).json({
      success: false,
      message: error.response?.data?.message || error.message || 'Unable to initiate marketer payout',
      error: error.response?.data,
    });
  }
}

export async function reconcileAdminReferrerWithdrawal(req: Request, res: Response): Promise<void> {
  const withdrawalId = String(req.params.withdrawalId);
  const withdrawal = await prisma.referrerWithdrawal.findUnique({
    where: { id: withdrawalId },
    select: { id: true },
  });
  if (!withdrawal) {
    res.status(404).json({ success: false, message: 'Marketer payout not found' });
    return;
  }

  try {
    const result = await reconcileReferrerWithdrawalPayout(withdrawalId, req.user?.userId);
    res.json({
      success: true,
      message: result.status === 'completed'
        ? 'Marketer payout reconciled as paid'
        : result.status === 'failed'
          ? 'Marketer payout reconciled as failed'
          : 'Marketer payout checked; final status is not available yet',
      data: result.data,
    });
  } catch (error: any) {
    res.status(502).json({
      success: false,
      message: error.response?.data?.message || error.message || 'Failed to reconcile marketer payout',
      error: error.response?.data,
    });
  }
}
