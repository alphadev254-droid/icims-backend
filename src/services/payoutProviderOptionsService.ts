import axios from 'axios';

const PAYCHANGU_SECRET_KEY = process.env.PAYCHANGU_SECRET_KEY || '';
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const PAYSTACK_BASE_URL = process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co';
const CACHE_TTL_MS = 5 * 60 * 1000;

let paychanguMobileOperatorsCache: any[] | null = null;
let paychanguMobileOperatorsCacheAt = 0;
let paystackKenyaProvidersCache: any[] | null = null;
let paystackKenyaProvidersCacheAt = 0;

export type PayoutProviderOption = {
  code: string;
  name: string;
  provider: 'paychangu' | 'paystack' | 'manual';
  raw?: any;
};

function normalizePaychanguCode(item: any): string {
  const shortCode = String(item.short_code || item.code || '').toLowerCase();
  const name = String(item.name || '').toLowerCase();
  if (shortCode.includes('airtel') || name.includes('airtel')) return 'airtel';
  if (shortCode.includes('tnm') || name.includes('tnm') || name.includes('mpamba')) return 'tnm';
  return shortCode || name.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || String(item.ref_id || item.id || 'provider');
}

export async function fetchPaychanguMobilePayoutProviders(): Promise<PayoutProviderOption[]> {
  const now = Date.now();
  if (paychanguMobileOperatorsCache && now - paychanguMobileOperatorsCacheAt < CACHE_TTL_MS) {
    return paychanguMobileOperatorsCache.map(toPaychanguProviderOption);
  }

  const response = await axios.get('https://api.paychangu.com/mobile-money/', {
    headers: { Authorization: `Bearer ${PAYCHANGU_SECRET_KEY}`, Accept: 'application/json' },
  });
  const operators = Array.isArray(response.data?.data) ? response.data.data : response.data;
  paychanguMobileOperatorsCache = Array.isArray(operators) ? operators : [];
  paychanguMobileOperatorsCacheAt = now;
  return paychanguMobileOperatorsCache.map(toPaychanguProviderOption);
}

function toPaychanguProviderOption(item: any): PayoutProviderOption {
  return {
    code: normalizePaychanguCode(item),
    name: String(item.name || item.display_name || item.short_code || 'Mobile Money'),
    provider: 'paychangu',
    raw: item,
  };
}

function normalizePaystackCode(item: any): string {
  return String(item.code || item.slug || item.name || 'provider').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export async function fetchPaystackKenyaPayoutProviders(): Promise<PayoutProviderOption[]> {
  const now = Date.now();
  if (paystackKenyaProvidersCache && now - paystackKenyaProvidersCacheAt < CACHE_TTL_MS) {
    return paystackKenyaProvidersCache.map(toPaystackProviderOption);
  }

  const response = await axios.get(`${PAYSTACK_BASE_URL}/bank`, {
    params: { country: 'kenya', currency: 'KES' },
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
  });
  const providers = Array.isArray(response.data?.data) ? response.data.data : [];
  paystackKenyaProvidersCache = providers;
  paystackKenyaProvidersCacheAt = now;
  return providers.map(toPaystackProviderOption);
}

function toPaystackProviderOption(item: any): PayoutProviderOption {
  return {
    code: normalizePaystackCode(item),
    name: String(item.name || item.longcode || item.slug || 'Paystack Provider'),
    provider: 'paystack',
    raw: item,
  };
}

export async function fetchPayoutProvidersForMarket(market?: { code?: string | null; name?: string | null } | null): Promise<PayoutProviderOption[]> {
  const value = String(market?.code || market?.name || '').toLowerCase();
  if (value.includes('malawi')) return fetchPaychanguMobilePayoutProviders();
  if (value.includes('kenya')) return fetchPaystackKenyaPayoutProviders();
  return [];
}
