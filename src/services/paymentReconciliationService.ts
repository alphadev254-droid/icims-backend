import axios from 'axios';
import prisma from '../lib/prisma';
import { recordPaymentEvent } from '../middleware/metrics';
import { logger } from '../utils/logger';
import { completePaystackPayment } from './paystackCompletionService';

type ReconcileMode = 'auto' | 'manual';

type ReconcileResultStatus = 'completed' | 'already_completed' | 'still_pending' | 'failed' | 'abandoned' | 'skipped';

export type PendingPaymentReconcileResult = {
  id: string;
  reference: string | null;
  gateway: string;
  type: string;
  status: ReconcileResultStatus;
  message: string;
};

function parseMetadata(value: string | null): any {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function resolveGateway(pendingTx: { currency: string; metadata: string | null }) {
  const metadata = parseMetadata(pendingTx.metadata);
  const gateway = String(metadata.gateway || '').trim().toLowerCase();
  if (gateway === 'paystack' || gateway === 'paychangu') return gateway;
  return String(pendingTx.currency || '').toUpperCase() === 'MWK' ? 'paychangu' : 'paystack';
}

function isTerminalFailure(status: string) {
  return ['failed', 'failure', 'cancelled', 'canceled', 'abandoned', 'reversed'].includes(status.toLowerCase());
}

async function alreadyCompleted(reference: string) {
  const [payment, transaction] = await Promise.all([
    prisma.payment.findFirst({ where: { reference }, select: { id: true } }),
    prisma.transaction.findFirst({ where: { reference }, select: { id: true } }),
  ]);
  return Boolean(payment || transaction);
}

async function markPendingFailed(id: string, gateway: string, type: string, reference: string, traceId: string, reason: string) {
  await prisma.pendingTransaction.updateMany({
    where: { id, status: 'pending' },
    data: { status: 'failed' },
  });
  recordPaymentEvent(gateway, type, 'failed', {
    traceId,
    reference,
    pendingTransactionId: id,
    errorMessage: reason,
  });
}

async function reconcilePaystack(pendingTx: any, traceId: string, mode: ReconcileMode): Promise<PendingPaymentReconcileResult> {
  const reference = String(pendingTx.reference);
  const response = await axios.get(
    `${process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co'}/transaction/verify/${reference}`,
    { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } },
  );
  const txData = response.data.data;
  const gatewayStatus = String(txData?.status || '').toLowerCase();

  if (gatewayStatus === 'success') {
    const result = await completePaystackPayment(txData, traceId);
    return {
      id: pendingTx.id,
      reference,
      gateway: 'paystack',
      type: result.type || pendingTx.type,
      status: result.status === 'failed' ? 'failed' : 'completed',
      message: `Paystack ${mode} reconciliation completed with result: ${result.status}`,
    };
  }

  if (isTerminalFailure(gatewayStatus)) {
    await markPendingFailed(pendingTx.id, 'paystack', pendingTx.type, reference, traceId, `Gateway status: ${gatewayStatus}`);
    return {
      id: pendingTx.id,
      reference,
      gateway: 'paystack',
      type: pendingTx.type,
      status: 'failed',
      message: `Paystack reports terminal status: ${gatewayStatus}`,
    };
  }

  return {
    id: pendingTx.id,
    reference,
    gateway: 'paystack',
    type: pendingTx.type,
    status: 'still_pending',
    message: `Paystack status is still ${gatewayStatus || 'unknown'}`,
  };
}

async function reconcilePaychangu(pendingTx: any, traceId: string, mode: ReconcileMode): Promise<PendingPaymentReconcileResult> {
  const reference = String(pendingTx.reference);
  const response = await axios.get(
    `https://api.paychangu.com/verify-payment/${reference}`,
    { headers: { Authorization: `Bearer ${process.env.PAYCHANGU_SECRET_KEY}` } },
  );
  const gatewayStatus = String(response.data.data?.status || '').toLowerCase();

  if (gatewayStatus === 'success') {
    const { processPaychanguPayment } = await import('../controllers/paychanguWebhookController');
    await processPaychanguPayment({ tx_ref: reference, status: 'success', type: pendingTx.type }, traceId);
    return {
      id: pendingTx.id,
      reference,
      gateway: 'paychangu',
      type: pendingTx.type,
      status: 'completed',
      message: `PayChangu ${mode} reconciliation completed`,
    };
  }

  if (isTerminalFailure(gatewayStatus)) {
    await markPendingFailed(pendingTx.id, 'paychangu', pendingTx.type, reference, traceId, `Gateway status: ${gatewayStatus}`);
    return {
      id: pendingTx.id,
      reference,
      gateway: 'paychangu',
      type: pendingTx.type,
      status: 'failed',
      message: `PayChangu reports terminal status: ${gatewayStatus}`,
    };
  }

  return {
    id: pendingTx.id,
    reference,
    gateway: 'paychangu',
    type: pendingTx.type,
    status: 'still_pending',
    message: `PayChangu status is still ${gatewayStatus || 'unknown'}`,
  };
}

export async function reconcilePendingTransactionById(
  id: string,
  options: { mode?: ReconcileMode; traceId?: string } = {},
): Promise<PendingPaymentReconcileResult> {
  const mode = options.mode || 'manual';
  const traceId = options.traceId || `RECON-${mode.toUpperCase()}-${Date.now()}`;
  const pendingTx = await prisma.pendingTransaction.findUnique({ where: { id } });

  if (!pendingTx) {
    return {
      id,
      reference: null,
      gateway: 'unknown',
      type: 'unknown',
      status: 'skipped',
      message: 'Pending transaction not found',
    };
  }

  if (!pendingTx.reference) {
    return {
      id: pendingTx.id,
      reference: null,
      gateway: 'unknown',
      type: pendingTx.type,
      status: 'skipped',
      message: 'Pending transaction has no reference',
    };
  }

  const gateway = resolveGateway(pendingTx);
  logger.info('payment_reconciliation_started', {
    auditKind: 'money_api',
    traceId,
    mode,
    pendingTransactionId: pendingTx.id,
    reference: pendingTx.reference,
    gateway,
    type: pendingTx.type,
    status: pendingTx.status,
  });

  if (await alreadyCompleted(pendingTx.reference)) {
    await prisma.pendingTransaction.delete({ where: { id: pendingTx.id } }).catch(() => {});
    return {
      id: pendingTx.id,
      reference: pendingTx.reference,
      gateway,
      type: pendingTx.type,
      status: 'already_completed',
      message: 'Payment already completed. Pending row was cleared.',
    };
  }

  try {
    const result = gateway === 'paychangu'
      ? await reconcilePaychangu(pendingTx, traceId, mode)
      : await reconcilePaystack(pendingTx, traceId, mode);

    logger.info('payment_reconciliation_finished', {
      auditKind: 'money_api',
      traceId,
      mode,
      pendingTransactionId: pendingTx.id,
      reference: pendingTx.reference,
      gateway,
      type: pendingTx.type,
      resultStatus: result.status,
      message: result.message,
    });
    return result;
  } catch (error: any) {
    logger.error('payment_reconciliation_failed', {
      auditKind: 'money_api',
      traceId,
      mode,
      pendingTransactionId: pendingTx.id,
      reference: pendingTx.reference,
      gateway,
      type: pendingTx.type,
      error,
    });
    return {
      id: pendingTx.id,
      reference: pendingTx.reference,
      gateway,
      type: pendingTx.type,
      status: 'still_pending',
      message: error.message || 'Gateway reconciliation failed; pending row kept for retry.',
    };
  }
}

export async function reconcilePendingTransactionsBatch(options: {
  olderThanMs?: number;
  limit?: number;
  traceId?: string;
} = {}) {
  const olderThanMs = options.olderThanMs ?? 2 * 60 * 1000;
  const limit = options.limit ?? 50;
  const traceId = options.traceId || `RECON-AUTO-${Date.now()}`;
  const cutoff = new Date(Date.now() - olderThanMs);

  const pendingRows = await prisma.pendingTransaction.findMany({
    where: {
      status: 'pending',
      reference: { not: null },
      createdAt: { lt: cutoff },
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });

  const results: PendingPaymentReconcileResult[] = [];
  for (const pendingTx of pendingRows) {
    results.push(await reconcilePendingTransactionById(pendingTx.id, {
      mode: 'auto',
      traceId: `${traceId}-${results.length + 1}`,
    }));
  }

  logger.info('payment_reconciliation_batch_finished', {
    auditKind: 'money_api',
    traceId,
    checked: results.length,
    completed: results.filter(r => r.status === 'completed' || r.status === 'already_completed').length,
    failed: results.filter(r => r.status === 'failed').length,
    stillPending: results.filter(r => r.status === 'still_pending').length,
  });

  return results;
}

export async function abandonVeryStalePendingTransactions(options: {
  olderThanMs?: number;
  limit?: number;
  traceId?: string;
} = {}) {
  const olderThanMs = options.olderThanMs ?? 24 * 60 * 60 * 1000;
  const limit = options.limit ?? 100;
  const traceId = options.traceId || `RECON-STALE-${Date.now()}`;
  const cutoff = new Date(Date.now() - olderThanMs);

  const staleRows = await prisma.pendingTransaction.findMany({
    where: {
      status: 'pending',
      createdAt: { lt: cutoff },
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });

  const ids = staleRows.map(row => row.id);
  if (ids.length === 0) return 0;

  await prisma.pendingTransaction.updateMany({
    where: { id: { in: ids }, status: 'pending' },
    data: { status: 'abandoned' },
  });

  logger.warn('payment_reconciliation_stale_pending_abandoned', {
    auditKind: 'money_api',
    traceId,
    count: ids.length,
    pendingTransactionIds: ids,
  });

  return ids.length;
}
