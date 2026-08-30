import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { buildPackageFeatureLinks, packageEntitlementInclude } from '../lib/packageEntitlements';
import {
  countryFromRequestHeaders,
  findPackageMarketPriceWithFallback,
  gatewayForPackageCurrency,
  gatewayMarketLabel,
  packageAvailableInMarket,
  resolvePricingMarket,
} from '../utils/pricingMarkets';

// ─── Packages (tiers) ─────────────────────────────────────────────────────────

/** GET /api/packages — list all packages with their features */
export async function getPackages(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const role = req.user?.role;

  const packages = await prisma.package.findMany({
    where: { isActive: true, isPrivate: false },
    orderBy: { sortOrder: 'asc' },
    include: packageEntitlementInclude,
  });

  let accountCountry = typeof req.query.country === 'string'
    ? req.query.country
    : countryFromRequestHeaders(req.headers);

  if (!accountCountry && userId) {
    // For ministry_admin: read their own accountCountry directly
    if (role === 'ministry_admin') {
      const admin = await prisma.user.findUnique({
        where: { id: userId },
        select: { accountCountry: true },
      });
      if (admin?.accountCountry) accountCountry = admin.accountCountry;
    } else {
      // For other roles: find their ministryAdminId, then read that admin's country
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { accountCountry: true, ministryAdminId: true, church: { select: { ministryAdminId: true } } },
      });
      if (user?.accountCountry) {
        accountCountry = user.accountCountry;
      } else {
        const adminId = user?.ministryAdminId ?? user?.church?.ministryAdminId ?? null;
        if (adminId) {
          const admin = await prisma.user.findUnique({
            where: { id: adminId },
            select: { accountCountry: true },
          });
          if (admin?.accountCountry) accountCountry = admin.accountCountry;
        }
      }
    }
  }

  const market = await resolvePricingMarket(accountCountry);
  const generalMarket = market.code === 'general' ? market : await resolvePricingMarket('General');
  const currency = market.currencyCode;

  const convertedPackages = packages
  .map(rawPackage => {
    const pkg = buildPackageFeatureLinks(rawPackage);
    if (!packageAvailableInMarket(pkg, market.id, generalMarket.id)) return null;
    const marketPrice = findPackageMarketPriceWithFallback(pkg, market.id, generalMarket.id);
    if (!marketPrice) return null;
    const priceMonthly = marketPrice.priceMonthly;
    const priceYearly = marketPrice.priceYearly;
    const packageCurrency = marketPrice.currencyCode ?? currency;
    const packageGateway = gatewayForPackageCurrency(packageCurrency);
    return {
    ...pkg,
    priceMonthly,
    priceYearly,
    currency: packageCurrency,
    pricingMarket: {
      code: market.code,
      name: market.name,
      country: market.country,
      gateway: packageGateway,
    },
    // Only return non-limit features (no limitValue exposed)
    features: pkg.features
      .filter(f => f.feature.category !== 'limit')
      .map(({ feature }) => ({ name: feature.name, displayName: feature.displayName, category: feature.category })),
    // Keep direct limit fields for display — these are the authoritative limits
    // maxChurches, maxMembers, maxEvents, maxGivings, maxCells stay in response
    };
  })
  .filter(Boolean);

  res.json({
    success: true,
    data: convertedPackages,
    pricing: {
      market: market.code,
      marketName: market.name,
      country: market.country,
      currency,
      gateway: market.packageGateway,
    },
  });
}

/** GET /api/packages/countries — countries available during public registration */
export async function getCountries(_req: Request, res: Response): Promise<void> {
  const countries = await prisma.country.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: {
      id: true,
      name: true,
      iso2: true,
      iso3: true,
      phoneCode: true,
      currencyCode: true,
      pricingMarket: {
        select: { code: true, name: true, currencyCode: true, packageGateway: true },
      },
    },
  });

  res.json({ success: true, data: countries });
}

/** GET /api/packages/current — current user's package with feature access */
export async function getCurrentPackage(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const role = req.user?.role;
  if (!userId) { res.status(401).json({ success: false, message: 'Not authenticated' }); return; }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      ministryAdminId: true,
      church: { select: { ministryAdminId: true } },
      ownedChurches: true,
    },
  });
  
  if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }

  // Determine ministryAdminId
  let ministryAdminId: string | null = null;
  if (role === 'ministry_admin') {
    ministryAdminId = userId;
  } else if (role === 'member' && user.church?.ministryAdminId) {
    ministryAdminId = user.church.ministryAdminId;
  } else if (user.ministryAdminId) {
    ministryAdminId = user.ministryAdminId;
  }

  let subscription = null;
  if (ministryAdminId) {
    subscription = await prisma.subscription.findFirst({
      where: { ministryAdminId, status: 'active' },
      include: {
        package: {
          include: packageEntitlementInclude,
        },
      },
    });
  }

  res.json({ 
    success: true, 
    data: { 
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
      },
      package: subscription?.package ? buildPackageFeatureLinks(subscription.package) : null,
      subscription: subscription ? {
        status: subscription.status,
        startsAt: subscription.startsAt,
        expiresAt: subscription.expiresAt,
      } : null,
      churchCount: user.ownedChurches.length,
    } 
  });
}

// ─── Package Features ─────────────────────────────────────────────────────────

/** GET /api/packages/features — list all available features */
export async function getFeatures(_req: Request, res: Response): Promise<void> {
  const features = await prisma.packageFeature.findMany({
    orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }],
    include: {
      packages: { select: { packageId: true } },
    },
  });
  res.json({ success: true, data: features });
}

const featureSchema = z.object({
  name: z.string().min(2, 'Name required'),
  displayName: z.string().min(2, 'Display name required'),
  description: z.string().optional(),
  category: z.enum(['core', 'communication', 'reporting', 'management']).default('core'),
  sortOrder: z.number().int().default(0),
});

/** POST /api/packages/features — create a new feature */
export async function createFeature(req: Request, res: Response): Promise<void> {
  const parsed = featureSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const feature = await prisma.packageFeature.create({ data: parsed.data });
  res.status(201).json({ success: true, data: feature });
}

/** DELETE /api/packages/features/:id — remove a feature */
export async function deleteFeature(req: Request, res: Response): Promise<void> {
  const feature = await prisma.packageFeature.findUnique({ where: { id: String(req.params.id) } });
  if (!feature) { res.status(404).json({ success: false, message: 'Feature not found' }); return; }
  await prisma.packageFeature.delete({ where: { id: String(req.params.id) } });
  res.json({ success: true, message: 'Feature deleted' });
}

// ─── Package ↔ Feature links ──────────────────────────────────────────────────

/** PUT /api/packages/:id/features — set which features belong to this package */
export async function setPackageFeatures(req: Request, res: Response): Promise<void> {
  const packageId = String(req.params.id);
  const rawPkg = await prisma.package.findUnique({
    where: { id: packageId },
    include: { marketPrices: true },
  });
  const pkg = rawPkg ? buildPackageFeatureLinks(rawPkg) : null;
  if (!pkg) { res.status(404).json({ success: false, message: 'Package not found' }); return; }

  const { featureIds } = z.object({ featureIds: z.array(z.string()) }).parse(req.body);

  // Replace all links atomically
  await prisma.packageFeatureLink.deleteMany({ where: { packageId } });
  if (featureIds.length > 0) {
    await prisma.packageFeatureLink.createMany({
      data: featureIds.map(featureId => ({ packageId, featureId })),
      skipDuplicates: true,
    });
  }

  const updated = await prisma.package.findUnique({
    where: { id: packageId },
    include: { features: { include: { feature: true } } },
  });
  res.json({ success: true, data: updated });
}

// ─── Fee Calculator ───────────────────────────────────────────────────────────

/** GET /api/packages/calculate-fees?packageId=&billingCycle= */
export async function calculateFees(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const role = req.user?.role;
  if (!userId) { res.status(401).json({ success: false, message: 'Not authenticated' }); return; }

  const { packageId, billingCycle } = req.query as { packageId: string; billingCycle: string };
  if (!packageId || !billingCycle) {
    res.status(400).json({ success: false, message: 'packageId and billingCycle required' });
    return;
  }

  const pkg = await prisma.package.findUnique({
    where: { id: packageId },
    include: { marketPrices: true },
  });
  if (!pkg) { res.status(404).json({ success: false, message: 'Package not found' }); return; }

  // Resolve ministryAdminId to get accountCountry
  let ministryAdminId = role === 'ministry_admin' ? userId : null;
  if (!ministryAdminId) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { ministryAdminId: true } });
    ministryAdminId = user?.ministryAdminId ?? null;
  }
  const admin = ministryAdminId
    ? await prisma.user.findUnique({ where: { id: ministryAdminId }, select: { accountCountry: true } })
    : null;
  if (pkg.isPrivate) {
    if (!ministryAdminId) {
      res.status(403).json({ success: false, message: 'This private package is not available for this account.' });
      return;
    }
    const assignedPrivatePackage = await prisma.subscription.findFirst({
      where: { ministryAdminId, packageId: pkg.id },
      select: { id: true },
    });
    if (!assignedPrivatePackage) {
      res.status(403).json({ success: false, message: 'This private package is not assigned to your ministry account.' });
      return;
    }
  }
  const market = await resolvePricingMarket(admin?.accountCountry);
  const generalMarket = market.code === 'general' ? market : await resolvePricingMarket('General');
  const currency = pkg.isPrivate ? (pkg.currencyCode || market.currencyCode) : market.currencyCode;

  const marketPrice = pkg.isPrivate ? null : findPackageMarketPriceWithFallback(pkg, market.id, generalMarket.id);
  if (!pkg.isPrivate && !packageAvailableInMarket(pkg, market.id, generalMarket.id)) {
    res.status(400).json({ success: false, message: 'This package is not available for your country or market.' });
    return;
  }
  const { calculatePaymentFees } = await import('../utils/feeCalculations');
  const baseAmount = pkg.isPrivate
    ? Number(billingCycle === 'monthly' ? pkg.priceMonthly : pkg.priceYearly)
    : Number(billingCycle === 'monthly' ? marketPrice?.priceMonthly : marketPrice?.priceYearly);
  if (!pkg.isPrivate && (!marketPrice || !Number.isFinite(baseAmount) || baseAmount <= 0)) {
    res.status(400).json({ success: false, message: 'Package pricing is not configured for your country or the General market.' });
    return;
  }
  const paymentCurrency = pkg.isPrivate ? currency : (marketPrice?.currencyCode ?? currency);
  const gateway = gatewayForPackageCurrency(paymentCurrency);
  const fees = calculatePaymentFees(baseAmount, gatewayMarketLabel(gateway));

  res.json({
    success: true,
    data: {
      currency: paymentCurrency,
      pricingMarket: {
        code: market.code,
        name: market.name,
        gateway,
      },
      baseAmount: fees.baseAmount,
      convenienceFee: fees.convenienceFee,
      systemFeeAmount: fees.systemFeeAmount,
      transactionCost: fees.totalAmount - fees.baseAmount,
      totalAmount: fees.totalAmount,
    },
  });
}

// ─── Payments ─────────────────────────────────────────────────────────────────

/** GET /api/packages/payments — payment history for current user */
export async function getPayments(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const role = req.user?.role;
  if (!userId) { res.status(401).json({ success: false, message: 'Not authenticated' }); return; }

  // Determine national admin ID
  let ministryAdminId: string;
  if (role === 'ministry_admin') {
    ministryAdminId = userId;
  } else {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { ministryAdminId: true } });
    if (!user?.ministryAdminId) {
      res.status(400).json({ success: false, message: 'No national admin assigned' });
      return;
    }
    ministryAdminId = user.ministryAdminId;
  }

  const payments = await prisma.payment.findMany({
    where: { ministryAdminId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      createdAt: true,
      paidAt: true,
      type: true,
      packageName: true,
      amount: true,
      baseAmount: true,
      convenienceFee: true,
      systemFeeAmount: true,
      totalAmount: true,
      currency: true,
      reference: true,
      status: true,
      gateway: true,
      billingCycle: true,
      expiresAt: true,
      paymentMethod: true,
      package: { select: { displayName: true } },
      invoice: {
        select: {
          id: true,
          invoiceNumber: true,
          status: true,
          balanceDue: true,
          amountPaid: true,
        },
      },
    },
  });
  res.json({ success: true, data: payments });
}

const paymentSchema = z.object({
  amount: z.number().positive('Amount must be positive'),
  currency: z.string().default('MWK'),
  type: z.enum(['subscription', 'upgrade', 'downgrade', 'renewal']).default('subscription'),
  packageName: z.string().min(1, 'Package required'),
  reference: z.string().optional(),
  notes: z.string().optional(),
  status: z.enum(['pending', 'completed', 'failed']).default('pending'),
});

/** POST /api/packages/payments — record a payment and update user package */
export async function createPayment(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const role = req.user?.role;
  if (!userId) { res.status(401).json({ success: false, message: 'Not authenticated' }); return; }

  const parsed = paymentSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const { amount, currency, type, packageName, reference, notes, status } = parsed.data;

  // Find corresponding Package row
  const pkg = await prisma.package.findUnique({ where: { name: packageName } });
  if (!pkg) { res.status(400).json({ success: false, message: 'Package not found' }); return; }

  // Determine ministryAdminId
  let ministryAdminId: string;
  if (role === 'ministry_admin') {
    ministryAdminId = userId;
  } else {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { ministryAdminId: true } });
    if (!user?.ministryAdminId) {
      res.status(400).json({ success: false, message: 'No national admin assigned' });
      return;
    }
    ministryAdminId = user.ministryAdminId;
  }

  const payment = await prisma.payment.create({
    data: {
      ministryAdminId,
      amount, currency, type, status,
      packageName, packageId: pkg.id,
      reference, notes, createdById: userId,
    },
    include: { package: { select: { name: true, displayName: true } } },
  });

  res.status(201).json({ success: true, data: payment });
}

/** PUT /api/packages/payments/:id — update payment status and user package */
export async function updatePayment(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  if (!userId) { res.status(401).json({ success: false, message: 'Not authenticated' }); return; }

  const payment = await prisma.payment.findUnique({ where: { id: String(req.params.id) } });
  if (!payment) { res.status(404).json({ success: false, message: 'Payment not found' }); return; }
  if (payment.createdById !== userId) { res.status(403).json({ success: false, message: 'Access denied' }); return; }

  const { status } = z.object({ status: z.enum(['pending', 'completed', 'failed']) }).parse(req.body);

  const updated = await prisma.payment.update({
    where: { id: String(req.params.id) },
    data: { status },
    include: { package: { select: { name: true, displayName: true } } },
  });

  res.json({ success: true, data: updated });
}
