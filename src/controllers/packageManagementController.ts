import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { packageEntitlementInclude } from '../lib/packageEntitlements';

// ─── GET /api/admin/packages ──────────────────────────────────────────────────

export async function getPackages(req: Request, res: Response): Promise<void> {
  const packages = await prisma.package.findMany({
    include: {
      ...packageEntitlementInclude,
      _count: { select: { subscriptions: true } },
    },
    orderBy: { sortOrder: 'asc' },
  });
  res.json({ success: true, data: packages });
}

// ─── GET /api/admin/packages/features ────────────────────────────────────────

export async function getAllFeatures(req: Request, res: Response): Promise<void> {
  const features = await prisma.packageFeature.findMany({
    orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }],
  });
  res.json({ success: true, data: features });
}

// ─── GET /api/admin/packages/module-bundles ───────────────────────────────────

export async function getModuleBundles(_req: Request, res: Response): Promise<void> {
  const bundles = await prisma.moduleBundle.findMany({
    orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    include: {
      features: {
        include: { feature: true },
        orderBy: { feature: { sortOrder: 'asc' } },
      },
      packages: { select: { packageId: true } },
    },
  });

  res.json({ success: true, data: bundles });
}

export async function getPricingMarkets(_req: Request, res: Response): Promise<void> {
  const markets = await prisma.pricingMarket.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: {
      _count: { select: { countries: true, packagePrices: true } },
    },
  });

  res.json({ success: true, data: markets });
}

export async function getCountries(_req: Request, res: Response): Promise<void> {
  const countries = await prisma.country.findMany({
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: { pricingMarket: true },
  });

  res.json({ success: true, data: countries });
}

const currencySchema = z.enum(['USD', 'KES', 'MWK']);

const pricingMarketSchema = z.object({
  code: z.string().min(2).max(64).regex(/^[a-z0-9_-]+$/i).transform(value => value.trim().toLowerCase()),
  name: z.string().min(2).max(120),
  currencyCode: currencySchema,
  packageGateway: z.enum(['paystack', 'paychangu']).default('paystack'),
  isDefault: z.boolean().default(false),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

export async function createPricingMarket(req: Request, res: Response): Promise<void> {
  const parsed = pricingMarketSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const market = await prisma.$transaction(async (tx) => {
    if (parsed.data.isDefault) {
      await tx.pricingMarket.updateMany({ data: { isDefault: false } });
    }
    return tx.pricingMarket.create({ data: parsed.data });
  });

  res.status(201).json({ success: true, data: market });
}

export async function updatePricingMarket(req: Request, res: Response): Promise<void> {
  const parsed = pricingMarketSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const id = String(req.params.id);
  const existing = await prisma.pricingMarket.findUnique({ where: { id } });
  if (!existing) {
    res.status(404).json({ success: false, message: 'Pricing market not found' });
    return;
  }

  const market = await prisma.$transaction(async (tx) => {
    if (parsed.data.isDefault) {
      await tx.pricingMarket.updateMany({ where: { id: { not: id } }, data: { isDefault: false } });
    }
    const updated = await tx.pricingMarket.update({ where: { id }, data: parsed.data });

    if (parsed.data.currencyCode && parsed.data.currencyCode !== existing.currencyCode) {
      await tx.packageMarketPrice.updateMany({
        where: { pricingMarketId: id },
        data: { currencyCode: parsed.data.currencyCode },
      });
    }

    return updated;
  });

  res.json({ success: true, data: market });
}

export async function deletePricingMarket(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id);
  const market = await prisma.pricingMarket.findUnique({ where: { id } });
  if (!market) {
    res.status(404).json({ success: false, message: 'Pricing market not found' });
    return;
  }
  if (market.isDefault) {
    res.status(400).json({ success: false, message: 'Default pricing market cannot be removed' });
    return;
  }

  await prisma.pricingMarket.update({ where: { id }, data: { isActive: false } });
  res.json({ success: true, message: 'Pricing market disabled' });
}

const countryMarketSchema = z.object({
  pricingMarketId: z.string().nullable().optional(),
});

export async function updateCountryPricingMarket(req: Request, res: Response): Promise<void> {
  const parsed = countryMarketSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  if (parsed.data.pricingMarketId) {
    const market = await prisma.pricingMarket.findFirst({
      where: { id: parsed.data.pricingMarketId, isActive: true },
    });
    if (!market) {
      res.status(400).json({ success: false, message: 'Selected pricing market is not available' });
      return;
    }
  }

  const country = await prisma.country.update({
    where: { id: String(req.params.id) },
    data: { pricingMarketId: parsed.data.pricingMarketId ?? null },
    include: { pricingMarket: true },
  });

  res.json({ success: true, data: country });
}

// ─── POST /api/admin/packages ─────────────────────────────────────────────────

const packageSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().optional(),
  priceMonthly: z.number().min(0).default(0),
  priceYearly: z.number().min(0).default(0),
  currencyCode: currencySchema.default('USD'),
  isActive: z.boolean().default(true),
  isPrivate: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
  maxChurches: z.number().int().positive().optional().nullable(),
  maxMembers: z.number().int().positive().optional().nullable(),
  maxEvents: z.number().int().positive().optional().nullable(),
  maxGivings: z.number().int().positive().optional().nullable(),
  maxCells: z.number().int().positive().optional().nullable(),
  features: z.array(z.object({
    featureId: z.string(),
    limitValue: z.number().int().optional().nullable(),
  })).optional().default([]),
  moduleBundles: z.array(z.object({
    bundleId: z.string(),
    limitValue: z.number().int().optional().nullable(),
  })).optional(),
  bundleFeatureOverrides: z.array(z.object({
    bundleId: z.string(),
    featureId: z.string(),
    enabled: z.boolean(),
    limitValue: z.number().int().optional().nullable(),
    reason: z.string().optional().nullable(),
  })).optional(),
  marketFeatureOverrides: z.array(z.object({
    pricingMarketId: z.string(),
    featureId: z.string(),
    enabled: z.boolean(),
    limitValue: z.number().int().optional().nullable(),
    reason: z.string().optional().nullable(),
  })).optional(),
  marketPrices: z.array(z.object({
    pricingMarketId: z.string(),
    priceMonthly: z.number().min(0),
    priceYearly: z.number().min(0),
    currencyCode: currencySchema,
  })).optional(),
});

export async function createPackage(req: Request, res: Response): Promise<void> {
  const parsed = packageSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const { features, moduleBundles, bundleFeatureOverrides, marketFeatureOverrides, marketPrices, ...data } = parsed.data;
  const effectiveMarketPrices = data.isPrivate ? [] : (marketPrices ?? []);
  const effectiveMarketFeatureOverrides = data.isPrivate ? [] : (marketFeatureOverrides ?? []);

  const pkg = await prisma.$transaction(async (tx) => {
    const now = new Date();
    const created = await tx.package.create({
      data: {
        ...data,
        features: {
          create: features.map(f => ({
            featureId: f.featureId,
            limitValue: f.limitValue ?? null,
          })),
        },
        moduleBundles: moduleBundles ? {
          create: moduleBundles.map(bundle => ({
            bundleId: bundle.bundleId,
            limitValue: bundle.limitValue ?? null,
            createdAt: now,
            updatedAt: now,
          })),
        } : undefined,
        bundleFeatureOverrides: bundleFeatureOverrides ? {
          create: bundleFeatureOverrides.map(override => ({
            bundleId: override.bundleId,
            featureId: override.featureId,
            enabled: override.enabled,
            limitValue: override.limitValue ?? null,
            reason: override.reason ?? null,
            createdAt: now,
            updatedAt: now,
          })),
        } : undefined,
        marketFeatureOverrides: effectiveMarketFeatureOverrides.length > 0 ? {
          create: effectiveMarketFeatureOverrides.map(override => ({
            pricingMarketId: override.pricingMarketId,
            featureId: override.featureId,
            enabled: override.enabled,
            limitValue: override.limitValue ?? null,
            reason: override.reason ?? null,
            createdAt: now,
            updatedAt: now,
          })),
        } : undefined,
        marketPrices: effectiveMarketPrices.length > 0 ? {
          create: effectiveMarketPrices.map(price => ({
            pricingMarketId: price.pricingMarketId,
            priceMonthly: price.priceMonthly,
            priceYearly: price.priceYearly,
            currencyCode: price.currencyCode,
            createdAt: now,
            updatedAt: now,
          })),
        } : undefined,
      },
    });

    return tx.package.findUnique({
      where: { id: created.id },
      include: packageEntitlementInclude,
    });
  });

  res.status(201).json({ success: true, data: pkg });
}

// ─── PUT /api/admin/packages/:id ─────────────────────────────────────────────

export async function updatePackage(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id);

  const parsed = packageSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const { features, moduleBundles, bundleFeatureOverrides, marketFeatureOverrides, marketPrices, ...data } = parsed.data;
  const effectiveMarketPrices = data.isPrivate ? [] : marketPrices;
  const effectiveMarketFeatureOverrides = data.isPrivate ? [] : marketFeatureOverrides;

  const updated = await prisma.$transaction(async (tx) => {
    await tx.package.update({
      where: { id },
      data,
    });

    // If features provided, replace all legacy direct feature links.
    if (features !== undefined) {
      await tx.packageFeatureLink.deleteMany({ where: { packageId: id } });
      if (features.length > 0) {
        await tx.packageFeatureLink.createMany({
          data: features.map(f => ({
            packageId: id,
            featureId: f.featureId,
            limitValue: f.limitValue ?? null,
          })),
        });
      }
    }

    if (moduleBundles !== undefined) {
      await tx.packageModuleBundle.deleteMany({ where: { packageId: id } });
      if (moduleBundles.length > 0) {
        const now = new Date();
        await tx.packageModuleBundle.createMany({
          data: moduleBundles.map(bundle => ({
            packageId: id,
            bundleId: bundle.bundleId,
            limitValue: bundle.limitValue ?? null,
            createdAt: now,
            updatedAt: now,
          })),
        });
      }
    }

    if (bundleFeatureOverrides !== undefined) {
      await tx.packageBundleFeatureOverride.deleteMany({ where: { packageId: id } });
      if (bundleFeatureOverrides.length > 0) {
        const now = new Date();
        await tx.packageBundleFeatureOverride.createMany({
          data: bundleFeatureOverrides.map(override => ({
            packageId: id,
            bundleId: override.bundleId,
            featureId: override.featureId,
            enabled: override.enabled,
            limitValue: override.limitValue ?? null,
            reason: override.reason ?? null,
            createdAt: now,
            updatedAt: now,
          })),
        });
      }
    }

    if (effectiveMarketPrices !== undefined) {
      await tx.packageMarketPrice.deleteMany({ where: { packageId: id } });
      if (effectiveMarketPrices.length > 0) {
        const now = new Date();
        await tx.packageMarketPrice.createMany({
          data: effectiveMarketPrices.map(price => ({
            packageId: id,
            pricingMarketId: price.pricingMarketId,
            priceMonthly: price.priceMonthly,
            priceYearly: price.priceYearly,
            currencyCode: price.currencyCode,
            createdAt: now,
            updatedAt: now,
          })),
        });
      }
    }

    if (effectiveMarketFeatureOverrides !== undefined) {
      await tx.packageMarketFeatureOverride.deleteMany({ where: { packageId: id } });
      if (effectiveMarketFeatureOverrides.length > 0) {
        const now = new Date();
        await tx.packageMarketFeatureOverride.createMany({
          data: effectiveMarketFeatureOverrides.map(override => ({
            packageId: id,
            pricingMarketId: override.pricingMarketId,
            featureId: override.featureId,
            enabled: override.enabled,
            limitValue: override.limitValue ?? null,
            reason: override.reason ?? null,
            createdAt: now,
            updatedAt: now,
          })),
        });
      }
    }

    return tx.package.findUnique({
      where: { id },
      include: packageEntitlementInclude,
    });
  });

  res.json({ success: true, data: updated });
}

// ─── DELETE /api/admin/packages/:id ──────────────────────────────────────────

export async function deletePackage(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id);

  const activeSubscriptions = await prisma.subscription.count({
    where: { packageId: id, status: 'active' },
  });

  if (activeSubscriptions > 0) {
    res.status(400).json({
      success: false,
      message: `Cannot delete — ${activeSubscriptions} active subscription(s) use this package.`,
    });
    return;
  }

  await prisma.package.delete({ where: { id } });
  res.json({ success: true, message: 'Package deleted' });
}

// ─── POST /api/admin/packages/features ───────────────────────────────────────

const featureSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().optional(),
  category: z.string().default('core'),
  sortOrder: z.number().int().default(0),
});

export async function createFeature(req: Request, res: Response): Promise<void> {
  const parsed = featureSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const feature = await prisma.packageFeature.create({ data: parsed.data });
  res.status(201).json({ success: true, data: feature });
}

// ─── PUT /api/admin/packages/features/:id ────────────────────────────────────

export async function updateFeature(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id);
  const parsed = featureSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }
  const feature = await prisma.packageFeature.update({ where: { id }, data: parsed.data });
  res.json({ success: true, data: feature });
}

// ─── GET /api/admin/packages/rates ───────────────────────────────────────────

export async function getConversionRates(_req: Request, res: Response): Promise<void> {
  const mwkRate = parseFloat(process.env.USD_TO_MWK_RATE || '1730');
  const kesRate = parseFloat(process.env.USD_TO_KSH_RATE || '129');
  const malawiDiscount = parseFloat(process.env.MALAWI_PACKAGE_DISCOUNT || '0.5');
  const kenyaDiscount = parseFloat(process.env.KENYA_PACKAGE_DISCOUNT || '1');
  const generalDiscount = parseFloat(process.env.GENERAL_PACKAGE_DISCOUNT || '1');
  res.json({ success: true, data: { mwkRate, kesRate, malawiDiscount, kenyaDiscount, generalDiscount } });
}
