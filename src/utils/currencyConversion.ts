// Exchange rates (USD to local currency)
// These should ideally be fetched from an API or stored in database
// For now, using approximate rates as of 2024
const EXCHANGE_RATES = {
  MWK: parseFloat(process.env.USD_TO_MWK_RATE || '1730'), // 1 USD = 1730 MWK
  KSH: parseFloat(process.env.USD_TO_KSH_RATE || '129'),  // 1 USD = 129 KSH
};

/**
 * Convert USD amount to local currency
 * @param usdAmount Amount in USD
 * @param currency Target currency (MWK or KSH)
 * @returns Converted amount in local currency
 */
export function convertUSDToLocal(usdAmount: number, currency: 'MWK' | 'KSH'): number {
  const rate = EXCHANGE_RATES[currency];
  const converted = usdAmount * rate;
  
  // Round to nearest whole number for local currencies
  return Math.round(converted);
}

/**
 * Convert local currency to USD
 * @param localAmount Amount in local currency
 * @param currency Source currency (MWK or KSH)
 * @returns Converted amount in USD
 */
export function convertLocalToUSD(localAmount: number, currency: 'MWK' | 'KSH'): number {
  const rate = EXCHANGE_RATES[currency];
  return parseFloat((localAmount / rate).toFixed(2));
}

/**
 * Get exchange rate for a currency
 * @param currency Currency code (MWK or KSH)
 * @returns Exchange rate (1 USD = X local currency)
 */
export function getExchangeRate(currency: 'MWK' | 'KSH'): number {
  return EXCHANGE_RATES[currency];
}
