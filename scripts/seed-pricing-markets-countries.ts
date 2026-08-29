import prisma from '../src/lib/prisma';

const APPLY = process.argv.includes('--apply');
const UPDATE_PRIVATE_CURRENCY = process.argv.includes('--update-private-currency');

const MARKET_SEEDS = [
  { code: 'malawi', name: 'Malawi', currencyCode: 'MWK', packageGateway: 'paychangu', isDefault: false, sortOrder: 1 },
  { code: 'kenya', name: 'Kenya', currencyCode: 'KES', packageGateway: 'paystack', isDefault: false, sortOrder: 2 },
  { code: 'general', name: 'General', currencyCode: 'KES', packageGateway: 'paystack', isDefault: true, sortOrder: 99 },
];

const COUNTRY_META: Record<string, { iso3?: string; phoneCode?: string; currencyCode?: string }> = {
  MW: { iso3: 'MWI', phoneCode: '+265', currencyCode: 'MWK' },
  KE: { iso3: 'KEN', phoneCode: '+254', currencyCode: 'KES' },
  GH: { iso3: 'GHA', phoneCode: '+233', currencyCode: 'GHS' },
  NG: { iso3: 'NGA', phoneCode: '+234', currencyCode: 'NGN' },
  ZA: { iso3: 'ZAF', phoneCode: '+27', currencyCode: 'ZAR' },
  TZ: { iso3: 'TZA', phoneCode: '+255', currencyCode: 'TZS' },
  UG: { iso3: 'UGA', phoneCode: '+256', currencyCode: 'UGX' },
  RW: { iso3: 'RWA', phoneCode: '+250', currencyCode: 'RWF' },
  ZM: { iso3: 'ZMB', phoneCode: '+260', currencyCode: 'ZMW' },
  ZW: { iso3: 'ZWE', phoneCode: '+263', currencyCode: 'USD' },
  US: { iso3: 'USA', phoneCode: '+1', currencyCode: 'USD' },
  GB: { iso3: 'GBR', phoneCode: '+44', currencyCode: 'GBP' },
};

function getWorldCountries() {
  const intlWithRegions = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  const regionCodes = intlWithRegions.supportedValuesOf?.('region') ?? ['MW', 'KE', 'GH', 'NG', 'ZA', 'TZ', 'UG', 'RW', 'ZM', 'ZW', 'US', 'GB'];
  const displayNames = new Intl.DisplayNames(['en'], { type: 'region' });

  return regionCodes
    .map((iso2) => ({
      iso2,
      name: displayNames.of(iso2) || iso2,
      ...(COUNTRY_META[iso2] ?? {}),
    }))
    .filter((country) => /^[A-Z]{2}$/.test(country.iso2))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function marketCodeForCountry(country: { iso2: string; name: string }) {
  if (country.iso2 === 'MW' || country.name === 'Malawi') return 'malawi';
  if (country.iso2 === 'KE' || country.name === 'Kenya') return 'kenya';
  return null;
}

function convertedPackagePrice(pkg: { priceMonthly: number; priceYearly: number }, market: typeof MARKET_SEEDS[number]) {
  const isMalawi = market.code === 'malawi';
  const rate = parseFloat(process.env[isMalawi ? 'USD_TO_MWK_RATE' : 'USD_TO_KSH_RATE'] || (isMalawi ? '1730' : '129'));
  const discount = parseFloat(process.env[isMalawi ? 'MALAWI_PACKAGE_DISCOUNT' : market.code === 'kenya' ? 'KENYA_PACKAGE_DISCOUNT' : 'GENERAL_PACKAGE_DISCOUNT'] || (isMalawi ? '0.5' : '1'));

  return {
    priceMonthly: Math.round(pkg.priceMonthly * rate * discount),
    priceYearly: Math.round(pkg.priceYearly * rate * discount),
  };
}

async function main() {
  const countries = getWorldCountries();
  const packages = await prisma.package.findMany({ orderBy: { sortOrder: 'asc' } });
  const activeSubscriptions = await prisma.subscription.findMany({
    where: { status: 'active' },
    select: { packageId: true, ministryAdminId: true, expiresAt: true },
  });
  const ministryAdmins = await prisma.user.findMany({
    where: { id: { in: [...new Set(activeSubscriptions.map((sub) => sub.ministryAdminId))] } },
    select: { id: true, firstName: true, lastName: true, email: true, ministryName: true, accountCountry: true },
  });
  const adminById = new Map(ministryAdmins.map((admin) => [admin.id, admin]));

  console.log(APPLY ? 'Applying pricing market and country seed...' : 'Dry run only. No database changes will be made.');
  console.log(`Pricing markets: ${MARKET_SEEDS.map((market) => market.name).join(', ')}`);
  console.log(`Countries discovered: ${countries.length}`);
  console.log(`Packages found for market pricing: ${packages.length}`);
  console.log(`Active subscriptions found: ${activeSubscriptions.length}`);

  if (!APPLY) {
    console.log('\nCountry market sample:');
    for (const country of countries.filter((item) => ['MW', 'KE', 'GH', 'NG', 'ZA', 'US'].includes(item.iso2))) {
      console.log(`- ${country.name} (${country.iso2}) -> ${marketCodeForCountry(country) ?? 'default general market'}`);
    }
    console.log('\nPackage migration plan:');
    for (const pkg of packages) {
      const subscriptions = activeSubscriptions.filter((sub) => sub.packageId === pkg.id);
      console.log(`\nPACKAGE: ${pkg.displayName} (${pkg.name}) | ${pkg.isPrivate ? 'private/custom' : 'public'} | current=${(pkg as any).currencyCode || 'USD'} ${pkg.priceMonthly}/mo, ${pkg.priceYearly}/yr`);
      if (subscriptions.length > 0) {
        console.log('  Active ministries using this package:');
        for (const sub of subscriptions) {
          const admin = adminById.get(sub.ministryAdminId);
          const label = admin?.ministryName || `${admin?.firstName || ''} ${admin?.lastName || ''}`.trim() || admin?.email || sub.ministryAdminId;
          console.log(`  - ${label} | country=${admin?.accountCountry || 'not set'} | expires=${sub.expiresAt.toISOString()}`);
        }
      } else {
        console.log('  Active ministries using this package: none');
      }

      if (pkg.isPrivate) {
        console.log('  Private package rule: no package_market_prices rows will be created; package table price is kept as the negotiated price.');
        if (UPDATE_PRIVATE_CURRENCY) {
          const firstAdmin = subscriptions.map((sub) => adminById.get(sub.ministryAdminId)).find(Boolean);
          const inferredMarket = MARKET_SEEDS.find((market) => market.code === (firstAdmin?.accountCountry?.toLowerCase() === 'malawi' ? 'malawi' : firstAdmin?.accountCountry?.toLowerCase() === 'kenya' ? 'kenya' : 'general'));
          console.log(`  With --update-private-currency, currencyCode would be set to ${inferredMarket?.currencyCode || 'KES'} without changing numeric price values.`);
        }
      } else {
        console.log('  Public package market prices to upsert:');
        for (const market of MARKET_SEEDS) {
          const price = convertedPackagePrice(pkg, market);
          console.log(`  - ${market.name}: ${market.currencyCode} ${price.priceMonthly.toLocaleString()}/mo, ${price.priceYearly.toLocaleString()}/yr`);
        }
      }
    }
    console.log('\nRun with --apply to write pricing markets, countries, and public package market prices.');
    console.log('Optional: add --update-private-currency with --apply to set private package currency from the first active ministry market while keeping the current numeric package price.');
    return;
  }

  await prisma.$transaction(async (tx) => {
    const markets = new Map<string, string>();
    for (const market of MARKET_SEEDS) {
      const saved = await tx.pricingMarket.upsert({
        where: { code: market.code },
        update: {
          name: market.name,
          currencyCode: market.currencyCode,
          packageGateway: market.packageGateway,
          isDefault: market.isDefault,
          isActive: true,
          sortOrder: market.sortOrder,
        },
        create: {
          code: market.code,
          name: market.name,
          currencyCode: market.currencyCode,
          packageGateway: market.packageGateway,
          isDefault: market.isDefault,
          isActive: true,
          sortOrder: market.sortOrder,
        },
      });
      markets.set(market.code, saved.id);
    }

    for (const country of countries) {
      const marketCode = marketCodeForCountry(country);
      const marketId = marketCode ? markets.get(marketCode) : null;

      await tx.country.upsert({
        where: { iso2: country.iso2 },
        update: {
          name: country.name,
          iso3: country.iso3 ?? null,
          phoneCode: country.phoneCode ?? null,
          currencyCode: country.currencyCode ?? null,
          pricingMarketId: marketId,
          isActive: true,
          sortOrder: country.iso2 === 'MW' ? 1 : country.iso2 === 'KE' ? 2 : 100,
        },
        create: {
          name: country.name,
          iso2: country.iso2,
          iso3: country.iso3 ?? null,
          phoneCode: country.phoneCode ?? null,
          currencyCode: country.currencyCode ?? null,
          pricingMarketId: marketId,
          isActive: true,
          sortOrder: country.iso2 === 'MW' ? 1 : country.iso2 === 'KE' ? 2 : 100,
        },
      });
    }

    for (const pkg of packages.filter((item) => item.isPrivate && UPDATE_PRIVATE_CURRENCY)) {
      const subscriptions = activeSubscriptions.filter((sub) => sub.packageId === pkg.id);
      const firstAdmin = subscriptions.map((sub) => adminById.get(sub.ministryAdminId)).find(Boolean);
      const marketCode = firstAdmin?.accountCountry?.toLowerCase() === 'malawi'
        ? 'malawi'
        : firstAdmin?.accountCountry?.toLowerCase() === 'kenya'
          ? 'kenya'
          : 'general';
      const inferredMarket = MARKET_SEEDS.find((market) => market.code === marketCode) ?? MARKET_SEEDS[2];
      await tx.package.update({
        where: { id: pkg.id },
        data: { currencyCode: inferredMarket.currencyCode },
      });
    }

    for (const pkg of packages.filter((item) => !item.isPrivate)) {
      for (const market of MARKET_SEEDS) {
        const marketId = markets.get(market.code);
        if (!marketId) continue;
        const price = convertedPackagePrice(pkg, market);
        await tx.packageMarketPrice.upsert({
          where: { packageId_pricingMarketId: { packageId: pkg.id, pricingMarketId: marketId } },
          update: {
            priceMonthly: price.priceMonthly,
            priceYearly: price.priceYearly,
            currencyCode: market.currencyCode,
          },
          create: {
            packageId: pkg.id,
            pricingMarketId: marketId,
            priceMonthly: price.priceMonthly,
            priceYearly: price.priceYearly,
            currencyCode: market.currencyCode,
          },
        });
      }
    }
  });

  console.log('Pricing markets, countries, and public package market prices seeded successfully.');
}

main()
  .catch((error) => {
    console.error('Pricing market country seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
