export const packageEntitlementInclude = {
  features: {
    include: { feature: true },
  },
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
  marketFeatureOverrides: {
    include: { feature: true, pricingMarket: true },
  },
  marketPrices: {
    include: { pricingMarket: true },
  },
} as const;

export function buildPackageFeatureLinks<TPackage extends Record<string, any>>(
  pkg: TPackage,
  options: { preserveBundleRelations?: boolean; pricingMarketId?: string | null; fallbackPricingMarketId?: string | null } = {},
): TPackage {
  const featureLinks = new Map<string, any>();

  for (const packageBundle of pkg.moduleBundles ?? []) {
    if (packageBundle.bundle?.isActive === false) continue;

    for (const link of packageBundle.bundle?.features ?? []) {
      if (!link.enabled || !link.feature) continue;

      featureLinks.set(link.feature.id, {
        packageId: pkg.id,
        featureId: link.feature.id,
        limitValue: link.limitValue ?? packageBundle.limitValue ?? null,
        feature: link.feature,
      });
    }
  }

  for (const link of pkg.features ?? []) {
    if (!link.feature) continue;

    featureLinks.set(link.feature.id, {
      packageId: pkg.id,
      featureId: link.feature.id,
      limitValue: link.limitValue ?? null,
      feature: link.feature,
    });
  }

  for (const override of pkg.bundleFeatureOverrides ?? []) {
    if (!override.feature) continue;

    if (override.enabled) {
      featureLinks.set(override.feature.id, {
        packageId: pkg.id,
        featureId: override.feature.id,
        limitValue: override.limitValue ?? null,
        feature: override.feature,
      });
    } else {
      featureLinks.delete(override.feature.id);
    }
  }

  const hasSpecificMarketPrice = !!options.pricingMarketId
    && (pkg.marketPrices ?? []).some((price: any) => price.pricingMarketId === options.pricingMarketId);
  const effectiveMarketId = hasSpecificMarketPrice
    ? options.pricingMarketId
    : options.fallbackPricingMarketId ?? options.pricingMarketId ?? null;

  if (effectiveMarketId) {
    for (const override of pkg.marketFeatureOverrides ?? []) {
      if (!override.feature || override.pricingMarketId !== effectiveMarketId) continue;

      if (override.enabled) {
        featureLinks.set(override.feature.id, {
          packageId: pkg.id,
          featureId: override.feature.id,
          limitValue: override.limitValue ?? null,
          feature: override.feature,
        });
      } else {
        featureLinks.delete(override.feature.id);
      }
    }
  }

  const cleanPackage = options.preserveBundleRelations
    ? pkg
    : (() => {
        const {
          moduleBundles: _moduleBundles,
          bundleFeatureOverrides: _bundleFeatureOverrides,
          marketFeatureOverrides: _marketFeatureOverrides,
          ...rest
        } = pkg;
        return rest;
      })();

  return {
    ...cleanPackage,
    features: Array.from(featureLinks.values()).sort((a, b) => (a.feature.sortOrder ?? 0) - (b.feature.sortOrder ?? 0)),
  } as unknown as TPackage;
}

export function buildSafePackageEntitlement<TPackage extends Record<string, any>>(
  pkg: TPackage | null | undefined,
  options: { pricingMarketId?: string | null; fallbackPricingMarketId?: string | null } = {},
) {
  if (!pkg) return null;

  const effectivePackage = buildPackageFeatureLinks(pkg, options);

  return {
    id: effectivePackage.id,
    name: effectivePackage.name,
    displayName: effectivePackage.displayName,
    features: (effectivePackage.features ?? []).map((link: any) => ({
      featureId: link.featureId,
      limitValue: link.limitValue ?? null,
      feature: {
        id: link.feature?.id,
        name: link.feature?.name,
        displayName: link.feature?.displayName,
        description: link.feature?.description ?? null,
        category: link.feature?.category,
        sortOrder: link.feature?.sortOrder ?? 0,
      },
    })),
  };
}
