import prisma from './prisma';
import { logger } from '../utils/logger';

function normalizeCurrency(currency?: string | null) {
  return String(currency || '').trim().toUpperCase();
}

function amountFromPaystackMinorUnits(amount: unknown) {
  return Math.round(Number(amount || 0)) / 100;
}

function amountsMatch(a: number, b: number) {
  return Math.abs(a - b) < 0.01;
}

export async function clearStalePaystackPending(reference: string, pendingTxId?: string | null, traceId?: string) {
  if (pendingTxId) {
    await prisma.pendingTransaction.delete({ where: { id: pendingTxId } }).catch(() => {});
  }
  await prisma.pendingTransaction.deleteMany({ where: { reference } }).catch(() => {});
  logger.info('paystack_pending_cleared', {
    auditKind: 'money_api',
    gateway: 'paystack',
    traceId,
    reference,
    pendingTransactionId: pendingTxId || undefined,
  });
}

export function assertPaystackMatchesPendingTransaction(args: {
  paystackData: any;
  pendingTx: any;
  traceId: string;
  paymentType: string;
}) {
  const { paystackData, pendingTx, traceId, paymentType } = args;
  const reference = String(paystackData.reference || '');
  const gatewayAmount = amountFromPaystackMinorUnits(paystackData.amount);
  const expectedAmount = Number(pendingTx.amount);
  const gatewayCurrency = normalizeCurrency(paystackData.currency);
  const expectedCurrency = normalizeCurrency(pendingTx.currency);

  const referenceMatches = !pendingTx.reference || pendingTx.reference === reference;
  const amountMatches = amountsMatch(gatewayAmount, expectedAmount);
  const currencyMatches = gatewayCurrency === expectedCurrency;

  if (referenceMatches && amountMatches && currencyMatches) return;

  logger.error('paystack_verified_payment_mismatch', {
    auditKind: 'money_api',
    gateway: 'paystack',
    traceId,
    paymentType,
    reference,
    pendingTransactionId: pendingTx.id,
    pendingReference: pendingTx.reference,
    gatewayAmount,
    expectedAmount,
    gatewayCurrency,
    expectedCurrency,
    referenceMatches,
    amountMatches,
    currencyMatches,
  });

  throw new Error('Verified Paystack payment does not match the pending transaction.');
}

export async function withPaystackReferenceLock<T>(
  reference: string,
  traceId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockName = `paystack:${reference}`.slice(0, 64);
  const lockRows = await prisma.$queryRawUnsafe<Array<{ acquired: number | bigint }>>(
    'SELECT GET_LOCK(?, 10) AS acquired',
    lockName,
  );
  const acquired = Number(lockRows[0]?.acquired ?? 0);
  if (acquired !== 1) {
    logger.error('paystack_reference_lock_failed', {
      auditKind: 'money_api',
      gateway: 'paystack',
      traceId,
      reference,
      lockName,
    });
    throw new Error('Could not acquire Paystack payment lock.');
  }

  try {
    return await fn();
  } finally {
    await prisma.$queryRawUnsafe('SELECT RELEASE_LOCK(?)', lockName).catch(() => {});
  }
}
