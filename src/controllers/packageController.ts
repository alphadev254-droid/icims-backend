import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';

// ─── Packages (tiers) ─────────────────────────────────────────────────────────

/** GET /api/packages — list all packages with their features */
export async function getPackages(_req: Request, res: Response): Promise<void> {
  const packages = await prisma.package.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: 'asc' },
    include: {
      features: {
        include: { feature: true },
        orderBy: { feature: { sortOrder: 'asc' } },
      },
    },
  });
  res.json({ success: true, data: packages });
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
      nationalAdminId: true,
      church: { select: { nationalAdminId: true } },
      ownedChurches: true,
    },
  });
  
  if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }

  // Determine nationalAdminId
  let nationalAdminId: string | null = null;
  if (role === 'national_admin') {
    nationalAdminId = userId;
  } else if (role === 'member' && user.church?.nationalAdminId) {
    nationalAdminId = user.church.nationalAdminId;
  } else if (user.nationalAdminId) {
    nationalAdminId = user.nationalAdminId;
  }

  let subscription = null;
  if (nationalAdminId) {
    subscription = await prisma.subscription.findFirst({
      where: { nationalAdminId, status: 'active' },
      include: {
        package: {
          include: {
            features: {
              include: { feature: true },
              orderBy: { feature: { sortOrder: 'asc' } },
            },
          },
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
      package: subscription?.package || null,
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
  const pkg = await prisma.package.findUnique({ where: { id: packageId } });
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

// ─── Payments ─────────────────────────────────────────────────────────────────

/** GET /api/packages/payments — payment history for current user */
export async function getPayments(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const role = req.user?.role;
  if (!userId) { res.status(401).json({ success: false, message: 'Not authenticated' }); return; }

  // Determine national admin ID
  let nationalAdminId: string;
  if (role === 'national_admin') {
    nationalAdminId = userId;
  } else {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { nationalAdminId: true } });
    if (!user?.nationalAdminId) {
      res.status(400).json({ success: false, message: 'No national admin assigned' });
      return;
    }
    nationalAdminId = user.nationalAdminId;
  }

  const payments = await prisma.payment.findMany({
    where: { nationalAdminId },
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
      taxAmount: true,
      totalAmount: true,
      currency: true,
      reference: true,
      status: true,
      gateway: true,
      billingCycle: true,
      expiresAt: true,
      paymentMethod: true,
      package: { select: { displayName: true } },
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
  const churchId = req.user?.churchId;
  if (!userId || !churchId) { res.status(401).json({ success: false, message: 'Not authenticated' }); return; }

  const parsed = paymentSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const { amount, currency, type, packageName, reference, notes, status } = parsed.data;

  // Find corresponding Package row
  const pkg = await prisma.package.findUnique({ where: { name: packageName } });
  if (!pkg) { res.status(400).json({ success: false, message: 'Package not found' }); return; }

  const payment = await prisma.payment.create({
    data: {
      churchId, amount, currency, type, status,
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
