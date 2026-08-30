import prisma from '../lib/prisma';

export type PaymentGateway = 'paystack' | 'paychangu';

export interface ResolvedPricingMarket {
  id: string | null;
  code: string;
  name: string;
  country: string | null;
  currencyCode: string;
  packageGateway: PaymentGateway;
  isFallback: boolean;
}

const FALLBACK_GENERAL_MARKET: ResolvedPricingMarket = {
  id: null,
  code: 'general',
  name: 'General',
  country: null,
  currencyCode: 'KES',
  packageGateway: 'paystack',
  isFallback: true,
};

const COUNTRY_ALIASES: Record<string, string> = {
  mw: 'Malawi',
  malawi: 'Malawi',
  ke: 'Kenya',
  kenya: 'Kenya',
  general: 'General',
};

export function normalizeAccountCountry(country?: string | null): string | null {
  const value = String(country || '').trim();
  if (!value) return null;
  return COUNTRY_ALIASES[value.toLowerCase()] || value;
}

export function isMalawiCountry(country?: string | null): boolean {
  return normalizeAccountCountry(country)?.toLowerCase() === 'malawi';
}

export function gatewayForCountry(country?: string | null): PaymentGateway {
  return isMalawiCountry(country) ? 'paychangu' : 'paystack';
}

export function currencyForGateway(gateway: PaymentGateway): string {
  return gateway === 'paychangu' ? 'MWK' : 'KES';
}

export function gatewayForPackageCurrency(currency?: string | null): PaymentGateway {
  return String(currency || '').toUpperCase() === 'MWK' ? 'paychangu' : 'paystack';
}

export function paystackChannelsForCurrency(currency?: string | null): string[] | undefined {
  return String(currency || '').toUpperCase() === 'USD' ? ['card'] : undefined;
}

export function gatewayMarketLabel(gateway: PaymentGateway): string {
  return gateway === 'paychangu' ? 'Malawi' : 'General';
}

export function gatewayUsesPaystack(countryOrMarket?: string | null): boolean {
  const value = String(countryOrMarket || '').trim().toLowerCase();
  return value !== 'malawi' && value !== 'mw' && value !== 'paychangu';
}

export function packageRateKeyForMarket(marketCode?: string | null): string {
  return marketCode === 'malawi' ? 'USD_TO_MWK_RATE' : 'USD_TO_KSH_RATE';
}

export function packageDiscountKeyForMarket(marketCode?: string | null): string {
  if (marketCode === 'malawi') return 'MALAWI_PACKAGE_DISCOUNT';
  if (marketCode === 'kenya') return 'KENYA_PACKAGE_DISCOUNT';
  return 'GENERAL_PACKAGE_DISCOUNT';
}

export function packageDiscountFallbackForMarket(marketCode?: string | null): string {
  return marketCode === 'malawi' ? '0.5' : '1';
}

export function packageHasMarketPrices(pkg: { marketPrices?: unknown[] | null }): boolean {
  return (pkg.marketPrices?.length ?? 0) > 0;
}

export function findPackageMarketPrice(pkg: { marketPrices?: any[] | null }, marketId?: string | null) {
  if (!marketId) return null;
  return (pkg.marketPrices ?? []).find((price) => price.pricingMarketId === marketId) ?? null;
}

export function packageAvailableInMarket(pkg: { isPrivate?: boolean; marketPrices?: any[] | null }, marketId?: string | null): boolean {
  if (pkg.isPrivate) return true;
  if (!packageHasMarketPrices(pkg)) return true;
  return !!findPackageMarketPrice(pkg, marketId);
}

export function isPackageCurrencyLocal(currency?: string | null): boolean {
  const value = String(currency || '').toUpperCase();
  return value === 'MWK' || value === 'KES';
}

export async function resolvePricingMarket(accountCountry?: string | null): Promise<ResolvedPricingMarket> {
  const normalizedCountry = normalizeAccountCountry(accountCountry);

  if (normalizedCountry && normalizedCountry.toLowerCase() !== 'general') {
    const country = await prisma.country.findFirst({
      where: {
        isActive: true,
        OR: [
          { name: { equals: normalizedCountry } },
          { iso2: { equals: normalizedCountry.toUpperCase() } },
        ],
      },
      include: { pricingMarket: true },
    });

    if (country?.pricingMarket?.isActive) {
      return {
        id: country.pricingMarket.id,
        code: country.pricingMarket.code,
        name: country.pricingMarket.name,
        country: country.name,
        currencyCode: country.pricingMarket.currencyCode,
        packageGateway: country.pricingMarket.packageGateway as PaymentGateway,
        isFallback: false,
      };
    }

    if (country) {
      const defaultMarket = await prisma.pricingMarket.findFirst({
        where: { isActive: true, isDefault: true },
        orderBy: [{ sortOrder: 'asc' }],
      });

      if (defaultMarket) {
        return {
          id: defaultMarket.id,
          code: defaultMarket.code,
          name: defaultMarket.name,
          country: country.name,
          currencyCode: defaultMarket.currencyCode,
          packageGateway: defaultMarket.packageGateway as PaymentGateway,
          isFallback: false,
        };
      }
    }
  }

  const marketCode = normalizedCountry?.toLowerCase() === 'malawi'
    ? 'malawi'
    : normalizedCountry?.toLowerCase() === 'kenya'
      ? 'kenya'
      : 'general';

  const market = await prisma.pricingMarket.findFirst({
    where: {
      isActive: true,
      OR: [
        { code: marketCode },
        ...(marketCode === 'general' ? [{ isDefault: true }] : []),
      ],
    },
    orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }],
  });

  if (!market) return FALLBACK_GENERAL_MARKET;

  return {
    id: market.id,
    code: market.code,
    name: market.name,
    country: normalizedCountry && normalizedCountry.toLowerCase() !== 'general' ? normalizedCountry : null,
    currencyCode: market.currencyCode,
    packageGateway: market.packageGateway as PaymentGateway,
    isFallback: false,
  };
}

export function countryFromRequestHeaders(headers: Record<string, string | string[] | undefined>): string | null {
  const cfCountry = headers['cf-ipcountry'];
  const value = Array.isArray(cfCountry) ? cfCountry[0] : cfCountry;
  if (!value || value === 'XX' || value === 'T1') return null;
  return normalizeAccountCountry(value);
}
