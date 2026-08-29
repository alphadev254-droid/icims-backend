import { gatewayUsesPaystack } from './pricingMarkets';

interface PaymentFees {
  baseAmount: number;
  convenienceFee: number;
  systemFeeAmount: number;
  totalAmount: number;
  ceilRoundingAmount: number;  // extra collected due to Math.ceil — goes to ICIMS
  systemGatewayFeeRate: number;
  systemFeeRate: number;
}

function requireEnv(key: string): number {
  const val = process.env[key];
  if (!val) throw new Error('Payment configuration is not available. Please contact support.');
  const num = parseFloat(val);
  if (isNaN(num)) throw new Error('Payment configuration is not available. Please contact support.');
  return num;
}

function optionalEnv(key: string, fallback: number): number {
  const val = process.env[key];
  if (!val) return fallback;
  const num = parseFloat(val);
  return isNaN(num) ? fallback : num;
}

function ceilMoney(value: number): number {
  return Math.ceil(value);
}

export function calculatePaymentFees(baseAmount: number, country?: string): PaymentFees {
  const PAYSTACK_FEE_RATE  = requireEnv('PAYSTACK_FEE_RATE') / 100;
  const PAYCHANGU_FEE_RATE = requireEnv('PAYMENT_CONVENIENCE_FEE_PERCENTAGE') / 100;

  const usePaystack = gatewayUsesPaystack(country);
  const gatewayFeeRate = usePaystack ? PAYSTACK_FEE_RATE : PAYCHANGU_FEE_RATE;
  const exactConvenienceFee = baseAmount * gatewayFeeRate;
  const convenienceFee = ceilMoney(exactConvenienceFee);

  const KENYA_SYSTEM_FEE_RATE  = requireEnv('CONVENIENCE_RATE_KENYA') / 100;
  const MALAWI_SYSTEM_FEE_RATE = requireEnv('CONVENIENCE_RATE_MALAWI') / 100;
  const systemFeeRate   = usePaystack ? KENYA_SYSTEM_FEE_RATE : MALAWI_SYSTEM_FEE_RATE;
  const exactSystemFeeAmount = baseAmount * systemFeeRate;
  const systemFeeAmount = ceilMoney(exactSystemFeeAmount);

  const rawTotal = baseAmount + convenienceFee + systemFeeAmount;
  const totalAmount = Math.ceil(rawTotal);
  const ceilRoundingAmount = parseFloat((totalAmount - rawTotal).toFixed(2));

  return {
    baseAmount:           parseFloat(baseAmount.toFixed(2)),
    convenienceFee,
    systemFeeAmount,
    totalAmount,
    ceilRoundingAmount,
    systemGatewayFeeRate: gatewayFeeRate,
    systemFeeRate,
  };
}

interface WithdrawalFees {
  amount: number;
  fee: number;
  gatewayFeeAmount: number;
  gatewayFeeRate: number;
  bankFixedFeeAmount: number;
  systemFeeAmount: number;
  systemFeeRate: number;
  netAmount: number;
  payoutAmount: number;
}

function normalizeRate(raw: number): number {
  return raw > 1 ? raw / 100 : raw;
}

export function calculateWithdrawalFee(
  amount: number,
  method: 'mobile_money' | 'bank_transfer',
  mobileOperator?: 'airtel' | 'tnm'
): WithdrawalFees {
  let gatewayFeeAmount: number;
  let gatewayFeeRate: number;
  let bankFixedFeeAmount = 0;

  if (method === 'mobile_money') {
    const operatorRate =
      mobileOperator === 'airtel'
        ? optionalEnv('WITHDRAWAL_AIRTEL_MONEY_FEE_RATE', 0.018)
        : mobileOperator === 'tnm'
          ? optionalEnv('WITHDRAWAL_TNM_MPAMBA_FEE_RATE', 0.015)
          : null;
    if (operatorRate == null) {
      throw new Error('Mobile money operator is required for withdrawal fee calculation.');
    }
    gatewayFeeRate = normalizeRate(operatorRate);
    gatewayFeeAmount = ceilMoney(amount * gatewayFeeRate);
  } else {
    gatewayFeeRate = normalizeRate(requireEnv('WITHDRAWAL_BANK_FEE_RATE'));
    bankFixedFeeAmount = ceilMoney(requireEnv('WITHDRAWAL_BANK_FIXED_FEE'));
    gatewayFeeAmount = ceilMoney((amount * gatewayFeeRate) + bankFixedFeeAmount);
  }

  const systemFeeRate = normalizeRate(requireEnv('WITHDRAWAL_SYSTEM_FEE_RATE'));
  const systemFeeAmount = ceilMoney(amount * systemFeeRate);
  const fee = gatewayFeeAmount + systemFeeAmount;
  const payoutAmount = amount;
  const netAmount = amount + fee;

  return {
    amount: parseFloat(amount.toFixed(2)),
    fee: parseFloat(fee.toFixed(2)),
    gatewayFeeAmount: parseFloat(gatewayFeeAmount.toFixed(2)),
    gatewayFeeRate,
    bankFixedFeeAmount: parseFloat(bankFixedFeeAmount.toFixed(2)),
    systemFeeAmount: parseFloat(systemFeeAmount.toFixed(2)),
    systemFeeRate,
    netAmount: parseFloat(netAmount.toFixed(2)),
    payoutAmount: parseFloat(payoutAmount.toFixed(2))
  };
}
