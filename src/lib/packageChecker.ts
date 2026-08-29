import prisma from './prisma';

interface PackageFeatures {
  [featureName: string]: number | null;
}

type FeatureMap = PackageFeatures;

function setFeature(features: FeatureMap, featureName: string, limitValue?: number | null) {
  features[featureName] = limitValue ?? null;
}

export async function getUserPackageFeatures(userId: string): Promise<PackageFeatures> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { 
      id: true,
      ministryAdminId: true,
      role: { select: { name: true } },
      church: { select: { ministryAdminId: true } },
    },
  });

  if (!user) return {};

  let ministryAdminId: string | null = null;
  const roleName = user.role?.name;

  if (roleName === 'ministry_admin') {
    ministryAdminId = userId;
  } else if (roleName === 'member' && user.church?.ministryAdminId) {
    ministryAdminId = user.church.ministryAdminId;
  } else if (user.ministryAdminId) {
    ministryAdminId = user.ministryAdminId;
  }

  if (!ministryAdminId) return {};

  const subscription = await prisma.subscription.findFirst({
    where: { ministryAdminId, status: 'active' },
    include: {
      package: {
        include: {
          features: { include: { feature: true } },
          moduleBundles: {
            include: {
              bundle: {
                include: {
                  features: {
                    include: { feature: true },
                  },
                },
              },
            },
          },
          bundleFeatureOverrides: {
            include: { feature: true },
          },
        },
      },
    },
  });

  if (!subscription?.package) return {};

  const pkg = subscription.package;
  const features: PackageFeatures = {};

  // Feature flags from package bundles. Bundles are the preferred package
  // structure; direct PackageFeatureLink remains supported during migration.
  for (const packageBundle of pkg.moduleBundles) {
    for (const link of packageBundle.bundle.features) {
      if (!link.enabled) continue;
      setFeature(features, link.feature.name, link.limitValue ?? packageBundle.limitValue);
    }
  }

  // Legacy direct feature flags from PackageFeatureLink.
  for (const link of pkg.features) {
    setFeature(features, link.feature.name, link.limitValue);
  }

  // Package-specific bundle overrides are applied last. A disabled override
  // removes the feature for this package even if the bundle or legacy direct
  // link includes it. An enabled override can add/force the feature.
  for (const override of pkg.bundleFeatureOverrides) {
    if (override.enabled) {
      setFeature(features, override.feature.name, override.limitValue);
    } else {
      delete features[override.feature.name];
    }
  }

  // Override/supplement with direct Package limit fields (take the more specific value)
  // These are the authoritative limits for resource creation
  if (pkg.maxChurches != null) features['max_churches'] = pkg.maxChurches;
  if (pkg.maxMembers != null) features['max_members'] = pkg.maxMembers;
  if (pkg.maxEvents != null) features['max_events_per_month'] = pkg.maxEvents;
  if (pkg.maxGivings != null) features['max_givings'] = pkg.maxGivings;
  if (pkg.maxCells != null) features['max_cells'] = pkg.maxCells;

  return features;
}

export async function hasFeature(userId: string, featureName: string): Promise<boolean> {
  const features = await getUserPackageFeatures(userId);
  return featureName in features;
}

export async function getFeatureLimit(userId: string, featureName: string): Promise<number | null> {
  const features = await getUserPackageFeatures(userId);
  return features[featureName] ?? null;
}

export async function checkLimit(
  userId: string,
  featureName: string,
  currentCount: number
): Promise<{ allowed: boolean; limit: number | null; message?: string }> {
  const limit = await getFeatureLimit(userId, featureName);

  if (limit === null) {
    return { allowed: true, limit: null };
  }

  if (currentCount >= limit) {
    return {
      allowed: false,
      limit,
      message: `You have reached the maximum limit of ${limit} for this feature. Please upgrade your package.`,
    };
  }

  return { allowed: true, limit };
}

// ─── Convenience helpers for resource creation checks ─────────────────────────

export async function checkChurchLimit(ministryAdminId: string): Promise<{ allowed: boolean; message?: string }> {
  const currentCount = await prisma.church.count({ where: { ministryAdminId, status: 'active' } });
  const result = await checkLimit(ministryAdminId, 'max_churches', currentCount);
  return { allowed: result.allowed, message: result.message };
}

export async function checkMemberLimit(ministryAdminId: string, churchId?: string): Promise<{ allowed: boolean; message?: string }> {
  const where: any = churchId ? { churchId } : { ministryAdminId };
  const currentCount = await prisma.user.count({ where: { ...where, role: { name: 'member' }, memberType: { not: 'child' } } });
  const result = await checkLimit(ministryAdminId, 'max_members', currentCount);
  return { allowed: result.allowed, message: result.message };
}

export async function checkEventLimit(ministryAdminId: string): Promise<{ allowed: boolean; message?: string }> {
  // Count events created this month
  const startOfMonth = new Date(); startOfMonth.setDate(1); startOfMonth.setHours(0,0,0,0);
  const churches = await prisma.church.findMany({ where: { ministryAdminId, status: 'active' }, select: { id: true } });
  const churchIds = churches.map(c => c.id);
  const currentCount = await prisma.event.count({ where: { churchId: { in: churchIds }, createdAt: { gte: startOfMonth } } });
  const result = await checkLimit(ministryAdminId, 'max_events_per_month', currentCount);
  return { allowed: result.allowed, message: result.message };
}

export async function checkCellLimit(ministryAdminId: string): Promise<{ allowed: boolean; message?: string }> {
  const churches = await prisma.church.findMany({ where: { ministryAdminId, status: 'active' }, select: { id: true } });
  const churchIds = churches.map(c => c.id);
  const currentCount = await prisma.cell.count({ where: { churchId: { in: churchIds } } });
  const result = await checkLimit(ministryAdminId, 'max_cells', currentCount);
  return { allowed: result.allowed, message: result.message };
}
