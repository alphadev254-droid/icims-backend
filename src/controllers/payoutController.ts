import { Request, Response } from 'express';
import { reconcilePaystackSettlements } from '../services/settlementReconciliationService';
import prisma from '../lib/prisma';
import { reconcileAdminWithdrawal } from './adminTreasuryController';
import { syncLegacyMinistryWithdrawal } from '../services/legacyPayoutService';
import { logger } from '../utils/logger';

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
