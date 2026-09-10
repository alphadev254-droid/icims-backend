import prisma from '../src/lib/prisma';

async function main() {
  const wallets = await prisma.wallet.findMany({ select: { id: true, churchId: true, currency: true, balance: true } });
  let mismatches = 0;
  let missingEntries = 0;

  for (const wallet of wallets) {
    const [ledger, legacyCount] = await Promise.all([
      prisma.ledgerEntry.groupBy({
        by: ['direction'],
        where: { walletId: wallet.id },
        _sum: { amount: true },
      }),
      prisma.walletTransaction.count({ where: { walletId: wallet.id } }),
    ]);
    const credits = Number(ledger.find(item => item.direction === 'credit')?._sum.amount || 0);
    const debits = Number(ledger.find(item => item.direction === 'debit')?._sum.amount || 0);
    const derived = Math.round((credits - debits) * 100) / 100;
    const cached = Math.round(wallet.balance * 100) / 100;
    const entryCount = await prisma.ledgerEntry.count({ where: { walletId: wallet.id } });
    if (entryCount !== legacyCount) missingEntries += 1;
    if (derived !== cached || entryCount !== legacyCount) {
      mismatches += 1;
      console.log(JSON.stringify({ walletId: wallet.id, churchId: wallet.churchId, currency: wallet.currency, cached, derived, legacyCount, entryCount }));
    }
  }

  console.log(JSON.stringify({ wallets: wallets.length, mismatches, walletsWithEntryCountMismatch: missingEntries }));
  if (mismatches) process.exitCode = 1;
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
