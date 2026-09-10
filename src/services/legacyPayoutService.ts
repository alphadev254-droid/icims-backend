import prisma from '../lib/prisma';

function parseProviderJson(value: string | null) {
  if (!value) return undefined;
  try { return JSON.parse(value); } catch { return { raw: value }; }
}

export async function syncLegacyMinistryWithdrawal(withdrawalId: string) {
  const withdrawal = await prisma.withdrawal.findUnique({
    where: { id: withdrawalId },
    include: { wallet: { select: { id: true, churchId: true, currency: true } } },
  });
  if (!withdrawal) return null;

  const data = {
    walletId: withdrawal.walletId,
    churchId: withdrawal.wallet.churchId,
    ministryAdminId: withdrawal.ministryAdminId,
    initiatedBy: withdrawal.initiatedBy,
    scope: 'ministry',
    type: 'manual_withdrawal',
    gateway: 'paychangu',
    status: withdrawal.status,
    method: withdrawal.method,
    externalPayoutId: withdrawal.chargeId,
    externalReference: withdrawal.chargeId,
    providerAccountId: 'paychangu-main',
    currency: withdrawal.wallet.currency,
    grossAmount: withdrawal.amount,
    feeAmount: withdrawal.fee,
    requestedAmount: withdrawal.amount,
    gatewayFeeAmount: withdrawal.gatewayFeeAmount,
    gatewayFeeRate: withdrawal.gatewayFeeRate,
    fixedFeeAmount: withdrawal.bankFixedFeeAmount,
    systemFeeAmount: withdrawal.systemFeeAmount,
    systemFeeRate: withdrawal.systemFeeRate,
    totalDebitAmount: withdrawal.netAmount,
    payoutAmount: withdrawal.payoutAmount,
    deductionAmount: withdrawal.gatewayFeeAmount,
    netAmount: withdrawal.payoutAmount,
    destinationType: withdrawal.method === 'mobile_money' ? 'mobile_money' : 'bank',
    destinationBank: withdrawal.bankCode || withdrawal.mobileOperator,
    destinationAccount: withdrawal.accountNumber || withdrawal.mobileNumber,
    destinationAccountName: withdrawal.accountName,
    reconciliationStatus: withdrawal.status === 'completed' ? 'matched' : 'pending',
    failureReason: withdrawal.failureReason,
    providerPayload: parseProviderJson(withdrawal.gatewayPayload),
    providerResponse: parseProviderJson(withdrawal.gatewayResponse),
    initiatedAt: withdrawal.createdAt,
    processedAt: withdrawal.processedAt,
  };

  return prisma.payout.upsert({
    where: { legacyWithdrawalId: withdrawal.id },
    create: { ...data, legacyWithdrawalId: withdrawal.id },
    update: data,
  });
}

export async function syncLegacyPlatformWithdrawal(withdrawalId: string) {
  const withdrawal = await prisma.platformWithdrawal.findUnique({ where: { id: withdrawalId } });
  if (!withdrawal) return null;
  const data = {
    initiatedBy: withdrawal.initiatedBy,
    scope: 'platform',
    type: 'manual_withdrawal',
    gateway: 'paychangu',
    status: withdrawal.status,
    method: withdrawal.method,
    externalPayoutId: withdrawal.chargeId,
    externalReference: withdrawal.chargeId,
    providerAccountId: 'paychangu-platform',
    currency: 'MWK',
    grossAmount: withdrawal.amount,
    feeAmount: withdrawal.fee,
    requestedAmount: withdrawal.amount,
    gatewayFeeAmount: withdrawal.gatewayFeeAmount,
    gatewayFeeRate: withdrawal.gatewayFeeRate,
    fixedFeeAmount: withdrawal.bankFixedFeeAmount,
    systemFeeAmount: 0,
    totalDebitAmount: withdrawal.netAmount,
    payoutAmount: withdrawal.payoutAmount,
    deductionAmount: withdrawal.gatewayFeeAmount,
    netAmount: withdrawal.payoutAmount,
    destinationType: withdrawal.method === 'mobile_money' ? 'mobile_money' : 'bank',
    destinationBank: withdrawal.bankCode || withdrawal.mobileOperator,
    destinationAccount: withdrawal.accountNumber || withdrawal.mobileNumber,
    destinationAccountName: withdrawal.accountName,
    reconciliationStatus: withdrawal.status === 'completed' ? 'matched' : 'pending',
    failureReason: withdrawal.failureReason,
    providerPayload: parseProviderJson(withdrawal.gatewayPayload),
    providerResponse: parseProviderJson(withdrawal.gatewayResponse),
    initiatedAt: withdrawal.createdAt,
    processedAt: withdrawal.processedAt,
  };
  return prisma.payout.upsert({
    where: { legacyPlatformWithdrawalId: withdrawal.id },
    create: { ...data, legacyPlatformWithdrawalId: withdrawal.id },
    update: data,
  });
}
