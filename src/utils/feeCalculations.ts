interface PaymentFees {
  baseAmount: number;
  convenienceFee: number;
  taxAmount: number;
  totalAmount: number;
}

export function calculatePaymentFees(baseAmount: number, country?: string): PaymentFees {
  // Paystack (Kenya) uses 2.9% fee, Paychangu (Malawi) uses 2% fee
  const PAYSTACK_FEE_RATE = parseFloat(process.env.PAYSTACK_FEE_RATE || '0.029');
  const PAYCHANGU_FEE_RATE = parseFloat(process.env.PAYMENT_CONVENIENCE_FEE_PERCENTAGE || '2') / 100;
  
  const feeRate = country === 'Kenya' ? PAYSTACK_FEE_RATE : PAYCHANGU_FEE_RATE;
  const convenienceFee = baseAmount * feeRate;
  
  // Tax rates
  const KENYA_TAX_RATE = parseFloat(process.env.PAYMENT_TAX_RATE_KENYA || '0') / 100;
  const MALAWI_TAX_RATE = parseFloat(process.env.PAYMENT_TAX_RATE || '17.5') / 100;
  const taxRate = country === 'Kenya' ? KENYA_TAX_RATE : MALAWI_TAX_RATE;
  const taxAmount = convenienceFee * taxRate;
  
  const totalAmount = baseAmount + convenienceFee + taxAmount;

  return {
    baseAmount: parseFloat(baseAmount.toFixed(2)),
    convenienceFee: parseFloat(convenienceFee.toFixed(2)),
    taxAmount: parseFloat(taxAmount.toFixed(2)),
    totalAmount: parseFloat(totalAmount.toFixed(2))
  };
}

interface WithdrawalFees {
  amount: number;
  fee: number;
  netAmount: number;
}

export function calculateWithdrawalFee(
  amount: number, 
  method: 'mobile_money' | 'bank_transfer'
): WithdrawalFees {
  let fee: number;

  if (method === 'mobile_money') {
    const MOBILE_FEE_RATE = parseFloat(process.env.WITHDRAWAL_MOBILE_MONEY_FEE_RATE || '0.03');
    fee = amount * MOBILE_FEE_RATE;
  } else {
    const BANK_FEE_RATE = parseFloat(process.env.WITHDRAWAL_BANK_FEE_RATE || '0.01');
    const BANK_FIXED_FEE = parseFloat(process.env.WITHDRAWAL_BANK_FIXED_FEE || '700');
    fee = (amount * BANK_FEE_RATE) + BANK_FIXED_FEE;
  }

  const netAmount = amount - fee;

  return {
    amount: parseFloat(amount.toFixed(2)),
    fee: parseFloat(fee.toFixed(2)),
    netAmount: parseFloat(netAmount.toFixed(2))
  };
}
