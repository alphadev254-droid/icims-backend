import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';

// ─── GET /api/admin/packages ──────────────────────────────────────────────────

export async function getPackages(req: Request, res: Response): Promise<void> {
  const packages = await prisma.package.findMany({
    include: {
      features: {
        include: { feature: true },
        orderBy: { feature: { sortOrder: 'asc' } },
      },
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

// ─── POST /api/admin/packages ─────────────────────────────────────────────────

const packageSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().optional(),
  priceMonthly: z.number().min(0).default(0),
  priceYearly: z.number().min(0).default(0),
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
});

export async function createPackage(req: Request, res: Response): Promise<void> {
  const parsed = packageSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const { features, ...data } = parsed.data;

  const pkg = await prisma.package.create({
    data: {
      ...data,
      features: {
        create: features.map(f => ({
          featureId: f.featureId,
          limitValue: f.limitValue ?? null,
        })),
      },
    },
    include: { features: { include: { feature: true } } },
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

  const { features, ...data } = parsed.data;

  // Update package fields
  const pkg = await prisma.package.update({
    where: { id },
    data,
  });

  // If features provided, replace all feature links
  if (features !== undefined) {
    await prisma.packageFeatureLink.deleteMany({ where: { packageId: id } });
    if (features.length > 0) {
      await prisma.packageFeatureLink.createMany({
        data: features.map(f => ({
          packageId: id,
          featureId: f.featureId,
          limitValue: f.limitValue ?? null,
        })),
      });
    }
  }

  const updated = await prisma.package.findUnique({
    where: { id },
    include: { features: { include: { feature: true } } },
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
  res.json({ success: true, data: { mwkRate, kesRate, malawiDiscount, kenyaDiscount } });
}
