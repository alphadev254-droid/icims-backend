import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { hashPassword } from '../lib/password';
import {
  consumeWithdrawalOtp,
  createWithdrawalOtp,
  ensureReferrerRole,
  generateUniqueReferralCode,
  getReferrerBalance,
  referralLinkForCode,
} from '../services/referralService';
import { sendEmailVerificationOtp } from '../services/emailVerificationService';
import { fetchPayoutProvidersForMarket } from '../services/payoutProviderOptionsService';

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
  payoutPhone: z.string().min(6, 'Payout phone number is required'),
  payoutProvider: z.string().min(2, 'Payout provider is required'),
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
  return prisma.referrer.findUnique({ where: { userId } });
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

  const [balance, referrals, ledger, withdrawals] = await Promise.all([
    getReferrerBalance(referrer.id),
    prisma.referralLink.findMany({
      where: { referrerId: referrer.id },
      include: {
        ministryAdmin: { select: { id: true, firstName: true, lastName: true, email: true, ministryName: true } },
        church: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.referrerLedgerEntry.findMany({
      where: { referrerId: referrer.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
    prisma.referrerWithdrawal.findMany({
      where: { referrerId: referrer.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
  ]);

  res.json({
    success: true,
    data: {
      referrer: {
        id: referrer.id,
        code: referrer.code,
        type: referrer.type,
        status: referrer.status,
        displayName: referrer.displayName,
        referralLink: referralLinkForCode(referrer.code),
        country: referrer.country,
        payoutPhone: referrer.payoutPhone,
        payoutProvider: referrer.payoutProvider,
        payoutSetupStatus: referrer.payoutSetupStatus,
      },
      balance,
      referrals,
      ledger,
      withdrawals,
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

  const parsed = payoutSetupSchema.safeParse(req.body);
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

    const created = await tx.referrerWithdrawal.create({
      data: {
        referrerId: referrer.id,
        amount: payload.amount.toFixed(2),
        currency: 'MWK',
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
        currency: 'MWK',
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
    include: { user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ success: true, data: referrers });
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
