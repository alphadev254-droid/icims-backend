import prisma from '../lib/prisma';

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

      const existingRefund = await tx.walletTransaction.findFirst({
        where: {
          walletId: withdrawal.walletId,
          source: 'refund',
          sourceId: withdrawalId,
        },
      });

      if (existingRefund) {
        return {
          refunded: false,
          alreadyRefunded: true,
          walletTransactionId: existingRefund.id,
          balanceBefore: existingRefund.balanceBefore,
          balanceAfter: existingRefund.balanceAfter,
        };
      }

      const wallet = await tx.wallet.findUnique({
        where: { id: withdrawal.walletId },
      });

      if (!wallet) {
        throw new Error('Wallet not found');
      }

      const balanceBefore = wallet.balance;
      const balanceAfter = balanceBefore + withdrawal.netAmount;

      await tx.wallet.update({
        where: { id: wallet.id },
        data: { balance: balanceAfter },
      });

      const transaction = await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: 'credit',
          amount: withdrawal.netAmount,
          balanceBefore,
          balanceAfter,
          source: 'refund',
          sourceId: withdrawalId,
          description: `Refund for failed withdrawal - ${withdrawalId}`,
        },
      });

      return {
        refunded: true,
        alreadyRefunded: false,
        walletTransactionId: transaction.id,
        balanceBefore,
        balanceAfter,
      };
    });
  } finally {
    await prisma.$queryRawUnsafe('SELECT RELEASE_LOCK(?)', lockName).catch(() => null);
  }
}
