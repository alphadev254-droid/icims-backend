import { Request, Response } from 'express';
import { reconcilePaystackSettlements } from '../services/settlementReconciliationService';
import prisma from '../lib/prisma';
import { dateRangeInTimeZone, resolveTimeZone } from '../lib/timezone';
import { reconcileAdminWithdrawal } from './adminTreasuryController';
import { syncLegacyMinistryWithdrawal } from '../services/legacyPayoutService';
import { logger } from '../utils/logger';
import { buildPersonSearchWhere } from '../lib/personSearch';

function decimal(value: unknown): number {
  return Number(value || 0);
}

export async function getAdminPayouts(req: Request, res: Response): Promise<void> {
  const page = Math.max(1, parseInt(String(req.query.page || '1')) || 1);
  const limit = Math.min(100, Math.max(10, parseInt(String(req.query.limit || '70')) || 70));
  const search = String(req.query.search || '').trim();
  const status = String(req.query.status || '').trim();
  const method = String(req.query.method || '').trim();
  const currency = String(req.query.currency || '').trim().toUpperCase();
  const ministryAdminId = String(req.query.ministry || '').trim();
  const gateway = String(req.query.gateway || '').trim().toLowerCase();
  const dateFrom = String(req.query.dateFrom || '').trim();
  const dateTo = String(req.query.dateTo || '').trim();

  const where: any = { scope: 'ministry' };
  if (status) where.status = status;
  if (method) where.method = method;
  if (currency) where.currency = currency;
  if (ministryAdminId) where.ministryAdminId = ministryAdminId;
  if (gateway) where.gateway = gateway;
  if (dateFrom || dateTo) {
    const timezone = await resolveTimeZone({ req, ministryAdminId: ministryAdminId || undefined });
    where.createdAt = dateRangeInTimeZone(dateFrom, dateTo, timezone);
  }
  if (search) {
    const users = await prisma.user.findMany({
      where: { OR: [
        buildPersonSearchWhere(search, ['firstName', 'lastName', 'email']),
        { ministryName: { contains: search } },
      ] },
      select: { id: true },
    });
    const userIds = users.map(item => item.id);
    where.OR = [
      { id: { contains: search } },
      { externalPayoutId: { contains: search } },
      { externalReference: { contains: search } },
      { destinationAccountName: { contains: search } },
      { destinationAccount: { contains: search } },
      { church: { name: { contains: search } } },
      { initiatedBy: { in: userIds } },
      { ministryAdminId: { in: userIds } },
    ];
  }

  const completedWhere = { ...where, status: 'completed' };
  const [payouts, total, statusGroups, reconciliationGroups, methodGroups, gatewayGroups] = await Promise.all([
    prisma.payout.findMany({
      where,
      include: {
        church: {
          select: {
            id: true,
            name: true,
            ministryAdminId: true,
            ministryAdmin: { select: { id: true, firstName: true, lastName: true, email: true, ministryName: true, accountCountry: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.payout.count({ where }),
    prisma.payout.groupBy({ by: ['status'], where, _count: { _all: true } }),
    prisma.payout.groupBy({
      by: ['reconciliationStatus'], where,
      _count: { _all: true },
      _sum: { payoutAmount: true },
    }),
    prisma.payout.groupBy({ by: ['method'], where, _count: { _all: true } }),
    prisma.payout.groupBy({
      by: ['currency', 'gateway', 'type'],
      where: completedWhere,
      _count: { _all: true },
      _sum: {
        grossAmount: true, deductionAmount: true, gatewayFeeAmount: true,
        fixedFeeAmount: true, systemFeeAmount: true, payoutAmount: true,
      },
    }),
  ]);

  const userIds = [...new Set(payouts.flatMap(item => [item.initiatedBy, item.ministryAdminId]).filter(Boolean))] as string[];
  const users = userIds.length ? await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, firstName: true, lastName: true, email: true, phone: true, ministryName: true, accountCountry: true },
  }) : [];
  const userMap = new Map(users.map(item => [item.id, item]));
  const completedByCurrency = new Map<string, {
    count: number; grossProcessed: number; paidToAccounts: number;
    providerDeductions: number; gatewayFee: number; bankFixedFee: number; icimsRevenue: number;
  }>();
  for (const item of gatewayGroups) {
    const current = completedByCurrency.get(item.currency) || {
      count: 0, grossProcessed: 0, paidToAccounts: 0, providerDeductions: 0,
      gatewayFee: 0, bankFixedFee: 0, icimsRevenue: 0,
    };
    const gatewayFee = decimal(item._sum.gatewayFeeAmount);
    current.count += item._count._all;
    current.grossProcessed += decimal(item._sum.grossAmount);
    current.paidToAccounts += decimal(item._sum.payoutAmount);
    current.providerDeductions += item.gateway === 'paystack' ? decimal(item._sum.deductionAmount) : gatewayFee;
    current.gatewayFee += gatewayFee;
    current.bankFixedFee += decimal(item._sum.fixedFeeAmount);
    current.icimsRevenue += decimal(item._sum.systemFeeAmount);
    completedByCurrency.set(item.currency, current);
  }
  res.json({
    success: true,
    data: payouts.map(payout => ({
      id: payout.id,
      walletId: payout.walletId,
      ministryAdminId: payout.ministryAdminId,
      initiatedBy: payout.initiatedBy,
      amount: decimal(payout.requestedAmount) || decimal(payout.grossAmount),
      requestedAmount: decimal(payout.requestedAmount) || decimal(payout.grossAmount),
      fee: decimal(payout.feeAmount),
      gatewayFeeAmount: decimal(payout.gatewayFeeAmount),
      providerDeductionAmount: payout.gateway === 'paystack'
        ? decimal(payout.deductionAmount)
        : decimal(payout.gatewayFeeAmount),
      gatewayFeeRate: payout.gatewayFeeRate == null ? null : decimal(payout.gatewayFeeRate),
      bankFixedFeeAmount: decimal(payout.fixedFeeAmount),
      systemFeeAmount: decimal(payout.systemFeeAmount),
      systemFeeRate: payout.systemFeeRate == null ? null : decimal(payout.systemFeeRate),
      netAmount: decimal(payout.totalDebitAmount) || decimal(payout.grossAmount),
      totalDebitAmount: decimal(payout.totalDebitAmount) || decimal(payout.grossAmount),
      payoutAmount: decimal(payout.payoutAmount) || decimal(payout.netAmount),
      method: payout.method || 'gateway_settlement',
      status: payout.status,
      gateway: payout.gateway,
      payoutType: payout.type,
      legacyWithdrawalId: payout.legacyWithdrawalId,
      reconciliationStatus: payout.reconciliationStatus,
      reconciliationDifference: payout.reconciliationDifference == null ? null : decimal(payout.reconciliationDifference),
      chargeId: payout.externalReference || payout.externalPayoutId,
      gatewayPayload: payout.providerPayload ? JSON.stringify(payout.providerPayload) : null,
      gatewayResponse: payout.providerResponse ? JSON.stringify(payout.providerResponse) : null,
      failureReason: payout.failureReason,
      processedAt: payout.processedAt,
      createdAt: payout.createdAt,
      updatedAt: payout.updatedAt,
      currency: payout.currency,
      church: payout.church ? { id: payout.church.id, name: payout.church.name, ministryAdminId: payout.church.ministryAdminId } : null,
      ministryAdmin: payout.ministryAdminId ? userMap.get(payout.ministryAdminId) || payout.church?.ministryAdmin || null : payout.church?.ministryAdmin || null,
      initiatedByUser: payout.initiatedBy ? userMap.get(payout.initiatedBy) || null : null,
    })),
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    summary: {
      total,
      byStatus: Object.fromEntries(statusGroups.map(item => [item.status, item._count._all])),
      byReconciliation: Object.fromEntries(reconciliationGroups.map(item => [item.reconciliationStatus, item._count._all])),
      reconciliation: reconciliationGroups.map(item => ({
        status: item.reconciliationStatus,
        count: item._count._all,
        payoutAmount: decimal(item._sum.payoutAmount),
      })),
      byMethod: Object.fromEntries(methodGroups.map(item => [item.method || 'unknown', item._count._all])),
      byCurrencyCount: Object.fromEntries([...completedByCurrency].map(([currencyCode, item]) => [currencyCode, item.count])),
      byCurrency: [...completedByCurrency].map(([currencyCode, item]) => ({ currency: currencyCode, ...item })),
      byGateway: gatewayGroups.map(item => ({
        currency: item.currency,
        gateway: item.gateway,
        payoutType: item.type,
        count: item._count._all,
        grossProcessed: decimal(item._sum.grossAmount),
        paidToAccounts: decimal(item._sum.payoutAmount),
        providerDeductions: item.gateway === 'paystack'
          ? decimal(item._sum.deductionAmount)
          : decimal(item._sum.gatewayFeeAmount),
        icimsRevenue: decimal(item._sum.systemFeeAmount),
      })),
    },
  });
}

export async function reconcilePaystackPayouts(req: Request, res: Response): Promise<void> {
  const parsedFrom = req.body?.from ? new Date(String(req.body.from)) : undefined;
  const parsedTo = req.body?.to ? new Date(String(req.body.to)) : undefined;
  if ((parsedFrom && Number.isNaN(parsedFrom.getTime())) || (parsedTo && Number.isNaN(parsedTo.getTime()))) {
    res.status(400).json({ success: false, message: 'from and to must be valid dates' });
    return;
  }
  const result = await reconcilePaystackSettlements({ from: parsedFrom, to: parsedTo });
  res.json({ success: true, data: result });
}

function gatewayForCountry(country?: string | null): 'paystack' | 'paychangu' {
  return String(country || '').trim().toLowerCase() === 'malawi' ? 'paychangu' : 'paystack';
}

export async function reconcileMinistryPayouts(req: Request, res: Response): Promise<void> {
  const ministryAdminId = String(req.body?.ministryAdminId || '').trim();
  const requestId = (req as any).requestId;
  logger.info('ministry_payout_reconciliation_requested', {
    requestId,
    ministryAdminId: ministryAdminId || undefined,
    requestedFrom: req.body?.from,
    requestedTo: req.body?.to,
    requestedBy: req.user?.userId,
  });
  if (!ministryAdminId) {
    res.status(400).json({ success: false, message: 'ministryAdminId is required' });
    return;
  }

  const ministry = await prisma.user.findUnique({
    where: { id: ministryAdminId },
    select: { id: true, ministryName: true, accountCountry: true },
  });
  if (!ministry) {
    res.status(404).json({ success: false, message: 'Ministry not found' });
    return;
  }

  const gateway = gatewayForCountry(ministry.accountCountry);
  logger.info('ministry_payout_reconciliation_routed', {
    requestId,
    ministryAdminId,
    accountCountry: ministry.accountCountry,
    gateway,
  });
  if (gateway === 'paystack') {
    const parsedFrom = req.body?.from ? new Date(String(req.body.from)) : undefined;
    const parsedTo = req.body?.to ? new Date(String(req.body.to)) : undefined;
    if ((parsedFrom && Number.isNaN(parsedFrom.getTime())) || (parsedTo && Number.isNaN(parsedTo.getTime()))) {
      res.status(400).json({ success: false, message: 'from and to must be valid dates' });
      return;
    }
    const result = await reconcilePaystackSettlements({
      from: parsedFrom,
      to: parsedTo,
      ministryAdminId,
    });
    logger.info('ministry_payout_reconciliation_finished', {
      requestId,
      ministryAdminId,
      gateway,
      ...result,
    });
    res.json({
      success: result.failed === 0,
      message: `Paystack reconciliation checked ${result.processed} settlement(s)${result.failed ? ` with ${result.failed} failure(s)` : ''}.`,
      data: { gateway, ministryAdminId, ...result },
    });
    return;
  }

  const withdrawals = await prisma.withdrawal.findMany({
    where: {
      ministryAdminId,
      status: { in: ['pending', 'processing', 'review_required'] },
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  logger.info('paychangu_ministry_withdrawals_found', {
    requestId,
    ministryAdminId,
    count: withdrawals.length,
  });
  let completed = 0;
  let failed = 0;
  let stillPending = 0;

  for (const withdrawal of withdrawals) {
    let responseStatus = 200;
    let responseBody: any;
    const internalResponse = {
      status(code: number) { responseStatus = code; return this; },
      json(body: any) { responseBody = body; return this; },
    } as unknown as Response;
    const internalRequest = Object.create(req) as Request;
    internalRequest.params = { kind: 'ministry', id: withdrawal.id };
    await reconcileAdminWithdrawal(internalRequest, internalResponse);
    await syncLegacyMinistryWithdrawal(withdrawal.id);
    logger.info('paychangu_ministry_withdrawal_reconciled', {
      requestId,
      ministryAdminId,
      withdrawalId: withdrawal.id,
      httpStatus: responseStatus,
      success: responseBody?.success,
      payoutStatus: responseBody?.data?.status,
    });
    if (responseStatus >= 400 || responseBody?.success === false) failed += 1;
    else if (responseBody?.data?.status === 'completed' || responseBody?.data?.status === 'failed') completed += 1;
    else stillPending += 1;
  }

  res.json({
    success: failed === 0,
    message: `PayChangu reconciliation checked ${withdrawals.length} withdrawal(s): ${completed} final, ${stillPending} still processing${failed ? `, ${failed} failed to check` : ''}.`,
    data: { gateway, ministryAdminId, processed: withdrawals.length, completed, stillPending, failed },
  });
  logger.info('ministry_payout_reconciliation_finished', {
    requestId,
    ministryAdminId,
    gateway,
    processed: withdrawals.length,
    completed,
    stillPending,
    failed,
  });
}
