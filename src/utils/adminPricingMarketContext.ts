import prisma from '../lib/prisma';

export type PricingMarketLite = {
  id: string;
  code: string;
  name: string;
  currencyCode: string;
  isDefault: boolean;
};

export type PricingMarketContext = Awaited<ReturnType<typeof getPricingMarketContext>>;

export async function getPricingMarketContext() {
  const [markets, countries] = await Promise.all([
    prisma.pricingMarket.findMany({
      where: { isActive: true },
      select: { id: true, code: true, name: true, currencyCode: true, isDefault: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
    prisma.country.findMany({
      where: { isActive: true },
      select: { name: true, pricingMarketId: true },
    }),
  ]);

  const defaultMarket = markets.find((market: PricingMarketLite) => market.isDefault)
    ?? markets.find((market: PricingMarketLite) => market.code === 'general')
    ?? markets[0]
    ?? null;
  const marketById = new Map(markets.map((market: PricingMarketLite) => [market.id, market]));
  const marketByCountry = new Map<string, PricingMarketLite>();
  const countryNamesByMarket = new Map<string, string[]>();
  const countriesAssignedToNonDefaultMarkets = new Set<string>();

  for (const country of countries) {
    const normalizedName = country.name.trim();
    if (!normalizedName) continue;

    const market = country.pricingMarketId ? marketById.get(country.pricingMarketId) ?? defaultMarket : defaultMarket;
    if (!market) continue;

    marketByCountry.set(normalizedName.toLowerCase(), market);
    countryNamesByMarket.set(market.id, [...(countryNamesByMarket.get(market.id) ?? []), normalizedName]);

    if (!market.isDefault) {
      countriesAssignedToNonDefaultMarkets.add(normalizedName);
    }
  }

  const resolveMarket = (country?: string | null) => {
    if (!country) return defaultMarket;
    return marketByCountry.get(country.trim().toLowerCase()) ?? defaultMarket;
  };

  return {
    defaultMarket,
    marketById,
    countryNamesByMarket,
    countriesAssignedToNonDefaultMarkets,
    resolveMarket,
  };
}

export function buildUserCountryWhereForMarket(marketId: string, context: PricingMarketContext) {
  const market = context.marketById.get(marketId);
  if (!market) return { accountCountry: '__no_market_match__' };

  if (market.isDefault) {
    return {
      OR: [
        { accountCountry: null },
        { accountCountry: { notIn: [...context.countriesAssignedToNonDefaultMarkets] } },
      ],
    };
  }

  return { accountCountry: { in: context.countryNamesByMarket.get(market.id) ?? ['__no_market_country_match__'] } };
}

export function serializePricingMarket(market?: PricingMarketLite | null) {
  return market ? {
    id: market.id,
    code: market.code,
    name: market.name,
    currencyCode: market.currencyCode,
  } : null;
}
