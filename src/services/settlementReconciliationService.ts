import prisma from '../lib/prisma';
import { logger } from '../utils/logger';
import { recordGatewayEvent } from './gatewayEventService';
import { paystackPayoutProvider } from './payoutProviders/paystack';
import { ProviderPayout, ProviderPayoutTransaction } from './payoutProviders/types';

const RECONCILIATION_TOLERANCE = Number(process.env.PAYOUT_RECONCILIATION_TOLERANCE || '0.01');

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

async function ensurePaystackProviderAccount(subaccount: any) {
  if (subaccount.providerSubaccountId) {
    logger.info('paystack_subaccount_provider_id_available', {
      subaccountId: subaccount.id,
      ministryAdminId: subaccount.ministryAdminId,
      churchId: subaccount.churchId,
      providerSubaccountId: subaccount.providerSubaccountId,
    });
    return subaccount;
  }
  logger.info('paystack_subaccount_provider_id_lookup_started', {
    subaccountId: subaccount.id,
    ministryAdminId: subaccount.ministryAdminId,
    churchId: subaccount.churchId,
  });
  const provider = await paystackPayoutProvider.fetchAccount(subaccount.subaccountCode);
  if (!provider?.id) throw new Error(`Paystack subaccount ${subaccount.subaccountCode} has no provider ID`);
  return prisma.subaccount.update({
    where: { id: subaccount.id },
    data: {
      providerSubaccountId: String(provider.id),
      providerPayload: provider,
    },
  });
}

async function postCompletedPayoutToWallet(payoutId: string, walletId: string, amount: number) {
  return prisma.$transaction(async tx => {
    const payoutRows = await tx.$queryRawUnsafe<Array<{ id: string; ledgerPostedAt: Date | null; externalPayoutId: string | null }>>(
      'SELECT id, ledgerPostedAt, externalPayoutId FROM payouts WHERE id = ? FOR UPDATE', payoutId,
    );
    const payout = payoutRows[0];
    if (!payout || payout.ledgerPostedAt) return { posted: false, reason: 'already_posted' };

    const rows = await tx.$queryRawUnsafe<Array<{ id: string; balance: number; currency: string }>>(
      'SELECT id, balance, currency FROM wallets WHERE id = ? FOR UPDATE', walletId,
    );
    const wallet = rows[0];
    if (!wallet) throw new Error('Wallet not found');

    const balanceBefore = Number(wallet.balance);
    if (balanceBefore + RECONCILIATION_TOLERANCE < amount) {
      await tx.payout.update({
        where: { id: payoutId },
        data: {
          reconciliationStatus: 'needs_review',
          failureReason: `Wallet balance ${balanceBefore} is below reconciled payout ${amount}`,
        },
      });
      return { posted: false, reason: 'insufficient_wallet_balance' };
    }

    const balanceAfter = roundMoney(balanceBefore - amount);
    await tx.wallet.update({ where: { id: walletId }, data: { balance: balanceAfter } });
    await tx.walletTransaction.create({
      data: {
        walletId,
        type: 'debit',
        amount,
        balanceBefore,
        balanceAfter,
        source: 'automatic_payout',
        sourceId: payoutId,
        description: `Automatic Paystack settlement - ${payout.externalPayoutId}`,
      },
    });
    await tx.payout.update({ where: { id: payoutId }, data: { ledgerPostedAt: new Date() } });
    return { posted: true };
  });
}

async function reconcilePaystackSettlement(subaccount: any, settlement: ProviderPayout) {
  logger.info('paystack_settlement_reconciliation_started', {
    subaccountId: subaccount.id,
    ministryAdminId: subaccount.ministryAdminId,
    churchId: subaccount.churchId,
    externalPayoutId: settlement.externalId,
    providerStatus: settlement.status,
    currency: settlement.currency,
  });
  const providerTransactions = await paystackPayoutProvider.listPayoutTransactions(settlement.externalId);
  const references = providerTransactions.map(item => item.reference).filter(Boolean);
  const localTransactions = references.length ? await prisma.transaction.findMany({
    where: {
      reference: { in: references },
      churchId: subaccount.churchId,
      gateway: 'paystack',
      status: 'completed',
    },
  }) : [];
  const localByReference = new Map(localTransactions.map(item => [item.reference, item]));
  const matched = providerTransactions.filter(item => localByReference.has(item.reference));
  const expectedAmount = roundMoney(matched.reduce((sum, item) => {
    const transaction = localByReference.get(item.reference)!;
    return sum + Number(transaction.baseAmount ?? transaction.amount);
  }, 0));
  const difference = roundMoney(expectedAmount - settlement.netAmount);
  const allMatched = providerTransactions.length > 0 && matched.length === providerTransactions.length;
  const currencyMatches = providerTransactions.every(item => item.currency === settlement.currency)
    && localTransactions.every(item => item.currency.toUpperCase() === settlement.currency);
  const totalsMatch = Math.abs(difference) <= RECONCILIATION_TOLERANCE;
  const reconciliationStatus = allMatched && currencyMatches && totalsMatch ? 'matched' : 'needs_review';
  logger.info('paystack_settlement_matching_calculated', {
    subaccountId: subaccount.id,
    ministryAdminId: subaccount.ministryAdminId,
    externalPayoutId: settlement.externalId,
    providerTransactionCount: providerTransactions.length,
    matchedTransactionCount: matched.length,
    expectedAmount,
    providerNetAmount: settlement.netAmount,
    difference,
    allMatched,
    currencyMatches,
    totalsMatch,
    reconciliationStatus,
  });

  const payout = await prisma.payout.upsert({
    where: {
      gateway_providerAccountId_externalPayoutId: {
        gateway: 'paystack',
        providerAccountId: subaccount.providerSubaccountId,
        externalPayoutId: settlement.externalId,
      },
    },
    create: {
      walletId: subaccount.church.wallet?.id,
      churchId: subaccount.churchId,
      ministryAdminId: subaccount.ministryAdminId,
      scope: 'ministry',
      type: 'automatic_settlement',
      gateway: 'paystack',
      status: settlement.status,
      method: 'gateway_settlement',
      externalPayoutId: settlement.externalId,
      externalReference: settlement.externalId,
      providerAccountId: subaccount.providerSubaccountId,
      currency: settlement.currency,
      grossAmount: settlement.grossAmount,
      feeAmount: settlement.feeAmount,
      requestedAmount: settlement.grossAmount,
      gatewayFeeAmount: settlement.feeAmount,
      fixedFeeAmount: 0,
      systemFeeAmount: 0,
      totalDebitAmount: settlement.grossAmount,
      payoutAmount: settlement.netAmount,
      deductionAmount: settlement.deductionAmount,
      netAmount: settlement.netAmount,
      destinationType: 'bank',
      destinationBank: subaccount.settlementBank,
      destinationAccount: subaccount.accountNumber,
      destinationAccountName: subaccount.businessName,
      reconciliationStatus,
      reconciliationDifference: difference,
      providerPayload: settlement.raw as any,
      settlementDate: settlement.settlementDate,
      processedAt: settlement.processedAt,
    },
    update: {
      status: settlement.status,
      grossAmount: settlement.grossAmount,
      feeAmount: settlement.feeAmount,
      requestedAmount: settlement.grossAmount,
      gatewayFeeAmount: settlement.feeAmount,
      fixedFeeAmount: 0,
      systemFeeAmount: 0,
      totalDebitAmount: settlement.grossAmount,
      payoutAmount: settlement.netAmount,
      deductionAmount: settlement.deductionAmount,
      netAmount: settlement.netAmount,
      reconciliationStatus,
      reconciliationDifference: difference,
      providerPayload: settlement.raw as any,
      settlementDate: settlement.settlementDate,
      processedAt: settlement.processedAt,
    },
  });

  await recordGatewayEvent({
    payoutId: payout.id,
    gateway: 'paystack',
    resourceType: 'payout',
    eventType: 'settlement.polled',
    externalId: settlement.externalId,
    payload: settlement.raw,
  });

  for (const providerTransaction of providerTransactions) {
    const transaction = localByReference.get(providerTransaction.reference);
    await recordGatewayEvent({
      payoutId: payout.id,
      gateway: 'paystack',
      resourceType: 'payout_transaction',
      eventType: 'settlement.transaction.polled',
      externalId: providerTransaction.externalId,
      externalReference: providerTransaction.reference,
      payload: providerTransaction.raw,
      processingError: transaction ? undefined : 'No matching completed ICIMS transaction',
    });
    if (!transaction) continue;
    const expected = Number(transaction.baseAmount ?? transaction.amount);
    await prisma.payoutAllocation.upsert({
      where: { payoutId_transactionId: { payoutId: payout.id, transactionId: transaction.id } },
      create: {
        payoutId: payout.id,
        transactionId: transaction.id,
        providerTransactionId: providerTransaction.externalId,
        providerGrossAmount: providerTransaction.grossAmount,
        expectedAmount: expected,
        settledAmount: expected,
        reconciliationStatus: reconciliationStatus === 'matched' ? 'matched' : 'needs_review',
        providerPayload: providerTransaction.raw as any,
      },
      update: {
        providerTransactionId: providerTransaction.externalId,
        providerGrossAmount: providerTransaction.grossAmount,
        expectedAmount: expected,
        settledAmount: expected,
        reconciliationStatus: reconciliationStatus === 'matched' ? 'matched' : 'needs_review',
        providerPayload: providerTransaction.raw as any,
      },
    });
  }

  if (settlement.status === 'completed' && reconciliationStatus === 'matched' && subaccount.church.wallet?.id) {
    // This wallet currently tracks donation funds only. A Paystack settlement can
    // also contain ticket revenue, so debit exactly what was previously credited
    // to this wallet instead of debiting the settlement's full bank payout.
    const credited = await prisma.walletTransaction.aggregate({
      where: {
        walletId: subaccount.church.wallet.id,
        type: 'credit',
        sourceId: { in: localTransactions.map(item => item.id) },
      },
      _sum: { amount: true },
    });
    const walletAmount = roundMoney(Number(credited._sum.amount || 0));
    if (walletAmount > 0) {
      const ledgerResult = await postCompletedPayoutToWallet(payout.id, subaccount.church.wallet.id, walletAmount);
      logger.info('paystack_settlement_wallet_posting_finished', {
        payoutId: payout.id,
        externalPayoutId: settlement.externalId,
        walletId: subaccount.church.wallet.id,
        walletAmount,
        ...ledgerResult,
      });
    }
  }

  logger.info('paystack_settlement_reconciliation_finished', {
    payoutId: payout.id,
    subaccountId: subaccount.id,
    ministryAdminId: subaccount.ministryAdminId,
    externalPayoutId: settlement.externalId,
    payoutStatus: payout.status,
    reconciliationStatus,
  });

  return payout;
}

export async function reconcilePaystackSettlements(options: { from?: Date; to?: Date; ministryAdminId?: string } = {}) {
  const to = options.to || new Date();
  const from = options.from || new Date(to.getTime() - 14 * 24 * 60 * 60 * 1000);
  const subaccounts = await prisma.subaccount.findMany({
    where: {
      active: true,
      ...(options.ministryAdminId ? {
        church: { ministryAdminId: options.ministryAdminId },
      } : {}),
    },
    include: { church: { include: { wallet: true } } },
  });
  logger.info('paystack_settlement_batch_started', {
    ministryAdminId: options.ministryAdminId,
    from: from.toISOString(),
    to: to.toISOString(),
    subaccountsFound: subaccounts.length,
    churchSubaccounts: subaccounts.map(item => ({
      churchId: item.churchId,
      subaccountId: item.id,
      churchMinistryAdminId: item.church.ministryAdminId,
    })),
  });
  let processed = 0;
  let failed = 0;
  let subaccountsSucceeded = 0;

  for (const original of subaccounts) {
    try {
      const subaccount = await ensurePaystackProviderAccount(original);
      const hydrated = { ...original, ...subaccount };
      const settlements = await paystackPayoutProvider.listPayouts({
        providerAccountId: hydrated.providerSubaccountId!, from, to,
      });
      logger.info('paystack_subaccount_settlements_fetched', {
        ministryAdminId: original.ministryAdminId,
        subaccountId: original.id,
        churchId: original.churchId,
        providerSubaccountId: hydrated.providerSubaccountId,
        settlementCount: settlements.length,
        from: from.toISOString(),
        to: to.toISOString(),
      });
      for (const settlement of settlements) {
        await reconcilePaystackSettlement(hydrated, settlement);
        processed += 1;
      }
      subaccountsSucceeded += 1;
    } catch (error: any) {
      failed += 1;
      logger.error('paystack_settlement_reconciliation_failed', {
        subaccountId: original.id,
        subaccountCode: original.subaccountCode,
        errorMessage: error.message,
      });
    }
  }
  const result = {
    processed,
    failed,
    subaccountsFound: subaccounts.length,
    subaccountsSucceeded,
    from: from.toISOString(),
    to: to.toISOString(),
  };
  logger.info('paystack_settlement_batch_finished', {
    ministryAdminId: options.ministryAdminId,
    ...result,
  });
  return result;
}
