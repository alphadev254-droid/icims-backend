import prisma from './prisma';

interface PackageFeatures {
  [featureName: string]: number | null;
}

export async function getUserPackageFeatures(userId: string): Promise<PackageFeatures> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { 
      id: true,
      nationalAdminId: true,
      role: { select: { name: true } },
      church: { select: { nationalAdminId: true } },
    },
  });

  if (!user) return {};

  // Determine which nationalAdminId to use
  let nationalAdminId: string | null = null;
  const roleName = user.role?.name;

  if (roleName === 'national_admin') {
    nationalAdminId = userId;
  } else if (roleName === 'member' && user.church?.nationalAdminId) {
    nationalAdminId = user.church.nationalAdminId;
  } else if (user.nationalAdminId) {
    nationalAdminId = user.nationalAdminId;
  }

  if (!nationalAdminId) return {};

  // Get active subscription
  const subscription = await prisma.subscription.findFirst({
    where: { 
      nationalAdminId,
      status: 'active',
    },
    include: {
      package: {
        include: {
          features: {
            include: {
              feature: true,
            },
          },
        },
      },
    },
  });

  if (!subscription?.package) return {};

  const features: PackageFeatures = {};
  for (const link of subscription.package.features) {
    features[link.feature.name] = link.limitValue;
  }

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
