import prisma from '../lib/prisma';

type WithdrawalWalletDebit = {
  walletId: string;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
};

function toCents(amount: number): number {
  return Math.round(amount * 100);
}

function fromCents(amount: number): number {
  return Math.round(amount) / 100;
}

export async function creditChurchWallet(
  churchId: string,
  amount: number,
  source: string,
  sourceId: string,
  description: string
) {
  let wallet = await prisma.wallet.findUnique({
    where: { churchId }
  });

  if (!wallet) {
    const church = await prisma.church.findUnique({
      where: { id: churchId },
      select: { ministryAdminId: true }
    });

    wallet = await prisma.wallet.create({
      data: {
        churchId,
        ministryAdminId: church!.ministryAdminId!,
        balance: 0,
        currency: 'MWK'
      }
    });
  }

  const balanceBefore = wallet.balance;
  const balanceAfter = balanceBefore + amount;

  await prisma.wallet.update({
    where: { id: wallet.id },
    data: { balance: balanceAfter }
  });

  await prisma.walletTransaction.create({
    data: {
      walletId: wallet.id,
      type: 'credit',
      amount,
      balanceBefore,
      balanceAfter,
      source,
      sourceId,
      description
    }
  });

  return { balanceBefore, balanceAfter };
}

export async function debitChurchWallet(
  walletId: string,
  amount: number,
  source: string,
  sourceId: string,
  description: string
) {
  const wallet = await prisma.wallet.findUnique({
    where: { id: walletId }
  });

  if (!wallet) {
    throw new Error('Wallet not found');
  }

  if (wallet.balance < amount) {
    throw new Error('Insufficient balance');
  }

  const balanceBefore = wallet.balance;
  const balanceAfter = balanceBefore - amount;

  await prisma.wallet.update({
    where: { id: walletId },
    data: { balance: balanceAfter }
  });

  await prisma.walletTransaction.create({
    data: {
      walletId,
      type: 'debit',
      amount,
      balanceBefore,
      balanceAfter,
      source,
      sourceId,
      description
    }
  });

  return { balanceBefore, balanceAfter };
}

export async function debitWalletsForWithdrawal(
  walletIds: string[],
  amount: number,
  withdrawalId: string,
  description: string
): Promise<WithdrawalWalletDebit[]> {
  if (amount <= 0) {
    throw new Error('Debit amount must be greater than zero');
  }

  if (walletIds.length === 0) {
    throw new Error('No wallets available for withdrawal');
  }

  const lockName = `debitWithdrawal:${withdrawalId}`;
  const lockRows = await prisma.$queryRawUnsafe<Array<{ acquired: number | bigint }>>(
    'SELECT GET_LOCK(?, 10) AS acquired',
    lockName
  );
  const acquired = Number(lockRows?.[0]?.acquired ?? 0);

  if (acquired !== 1) {
    throw new Error('Could not lock withdrawal debit. Please retry.');
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const placeholders = walletIds.map(() => '?').join(',');
      const wallets = await tx.$queryRawUnsafe<Array<{ id: string; balance: number }>>(
        `SELECT id, balance FROM wallets WHERE id IN (${placeholders}) FOR UPDATE`,
        ...walletIds
      );

      if (wallets.length === 0) {
        throw new Error('No wallets available for withdrawal');
      }

      const requiredCents = toCents(amount);
      const sortedWallets = wallets
        .map(wallet => ({ ...wallet, balanceCents: toCents(Number(wallet.balance)) }))
        .sort((a, b) => b.balanceCents - a.balanceCents);

      const singleWallet = sortedWallets.find(wallet => wallet.balanceCents >= requiredCents);
      const plan: Array<{ id: string; amountCents: number; balanceCents: number }> = [];

      if (singleWallet) {
        plan.push({
          id: singleWallet.id,
          amountCents: requiredCents,
          balanceCents: singleWallet.balanceCents,
        });
      } else {
        let remainingCents = requiredCents;

        for (const wallet of sortedWallets) {
          if (remainingCents <= 0) break;
          if (wallet.balanceCents <= 0) continue;

          const debitCents = Math.min(wallet.balanceCents, remainingCents);
          plan.push({
            id: wallet.id,
            amountCents: debitCents,
            balanceCents: wallet.balanceCents,
          });
          remainingCents -= debitCents;
        }

        if (remainingCents > 0) {
          throw new Error('Insufficient balance');
        }
      }

      const debits: WithdrawalWalletDebit[] = [];

      for (const item of plan) {
        const debitAmount = fromCents(item.amountCents);
        const balanceBefore = fromCents(item.balanceCents);
        const balanceAfter = fromCents(item.balanceCents - item.amountCents);

        await tx.wallet.update({
          where: { id: item.id },
          data: { balance: balanceAfter },
        });

        await tx.walletTransaction.create({
          data: {
            walletId: item.id,
            type: 'debit',
            amount: debitAmount,
            balanceBefore,
            balanceAfter,
            source: 'withdrawal',
            sourceId: withdrawalId,
            description,
          },
        });

        debits.push({
          walletId: item.id,
          amount: debitAmount,
          balanceBefore,
          balanceAfter,
        });
      }

      return debits;
    });
  } finally {
    await prisma.$queryRawUnsafe('SELECT RELEASE_LOCK(?)', lockName).catch(() => null);
  }
}

export async function refundWithdrawal(withdrawalId: string) {
  const lockName = `refundWithdrawal:${withdrawalId}`;
  const lockRows = await prisma.$queryRawUnsafe<Array<{ acquired: number | bigint }>>(
    'SELECT GET_LOCK(?, 10) AS acquired',
    lockName
  );
  const acquired = Number(lockRows?.[0]?.acquired ?? 0);

  if (acquired !== 1) {
    throw new Error('Could not lock withdrawal refund. Please retry reconciliation.');
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const withdrawal = await tx.withdrawal.findUnique({
        where: { id: withdrawalId },
        include: { wallet: true }
      });

      if (!withdrawal) {
        throw new Error('Withdrawal not found');
      }

      if (withdrawal.status === 'completed') {
        throw new Error('Cannot refund a completed withdrawal');
      }

      const debitTransactions = await tx.walletTransaction.findMany({
        where: {
          type: 'debit',
          source: 'withdrawal',
          sourceId: withdrawalId,
        },
        orderBy: { createdAt: 'asc' },
      });

      if (debitTransactions.length === 0) {
        return {
          refunded: false,
          alreadyRefunded: false,
          walletTransactionIds: [],
          totalRefunded: 0,
        };
      }

      const refundedTransactionIds: string[] = [];
      let totalRefunded = 0;
      let alreadyRefundedCount = 0;

      for (const debit of debitTransactions) {
        const existingRefund = await tx.walletTransaction.findFirst({
          where: {
            walletId: debit.walletId,
            source: 'refund',
            sourceId: withdrawalId,
            amount: debit.amount,
          },
        });

        if (existingRefund) {
          alreadyRefundedCount += 1;
          continue;
        }

        const wallet = await tx.wallet.findUnique({
          where: { id: debit.walletId },
        });

        if (!wallet) {
          throw new Error('Wallet not found');
        }

        const balanceBefore = wallet.balance;
        const balanceAfter = balanceBefore + debit.amount;

        await tx.wallet.update({
          where: { id: wallet.id },
          data: { balance: balanceAfter },
        });

        const transaction = await tx.walletTransaction.create({
          data: {
            walletId: wallet.id,
            type: 'credit',
            amount: debit.amount,
            balanceBefore,
            balanceAfter,
            source: 'refund',
            sourceId: withdrawalId,
            description: `Refund for failed withdrawal - ${withdrawalId}`,
          },
        });

        refundedTransactionIds.push(transaction.id);
        totalRefunded += debit.amount;
      }

      return {
        refunded: refundedTransactionIds.length > 0,
        alreadyRefunded: alreadyRefundedCount === debitTransactions.length,
        walletTransactionIds: refundedTransactionIds,
        totalRefunded,
      };
    });
  } finally {
    await prisma.$queryRawUnsafe('SELECT RELEASE_LOCK(?)', lockName).catch(() => null);
  }
}
