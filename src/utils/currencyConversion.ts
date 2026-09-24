// Exchange rates (USD to local currency)
// These should ideally be fetched from an API or stored in database
// For now, using approximate rates as of 2024
const EXCHANGE_RATES = {
  MWK: parseFloat(process.env.USD_TO_MWK_RATE || '1730'), // 1 USD = 1730 MWK
  KES: parseFloat(process.env.USD_TO_KES_RATE || process.env.USD_TO_KSH_RATE || '129'),  // 1 USD = 129 KES
};

function normalizeCurrency(currency: string): string {
  return String(currency || 'USD').trim().toUpperCase();
}

function getUsdExchangeRate(currency: string): number {
  const normalized = normalizeCurrency(currency);
  if (normalized === 'USD') return 1;

  const configuredRate = (EXCHANGE_RATES as Record<string, number>)[normalized];
  if (Number.isFinite(configuredRate) && configuredRate > 0) return configuredRate;

  const envRate = parseFloat(process.env[`USD_TO_${normalized}_RATE`] || '');
  if (Number.isFinite(envRate) && envRate > 0) return envRate;

  throw new Error(`Missing USD exchange rate for ${normalized}. Configure USD_TO_${normalized}_RATE.`);
}

/**
 * Convert USD amount to local currency
 * @param usdAmount Amount in USD
 * @param currency Target currency
 * @returns Converted amount in local currency
 */
export function convertUSDToLocal(usdAmount: number, currency: string): number {
  const normalized = normalizeCurrency(currency);
  const rate = getUsdExchangeRate(normalized);
  const converted = usdAmount * rate;

  if (normalized === 'USD') return parseFloat(converted.toFixed(2));

  // Round to nearest whole number for local currencies
  return Math.round(converted);
}

/**
 * Convert local currency to USD
 * @param localAmount Amount in local currency
 * @param currency Source currency
 * @returns Converted amount in USD
 */
export function convertLocalToUSD(localAmount: number, currency: string): number {
  const rate = getUsdExchangeRate(currency);
  return parseFloat((localAmount / rate).toFixed(2));
}

/**
 * Get exchange rate for a currency
 * @param currency Currency code
 * @returns Exchange rate (1 USD = X local currency)
 */
export function getExchangeRate(currency: string): number {
  return getUsdExchangeRate(currency);
}
