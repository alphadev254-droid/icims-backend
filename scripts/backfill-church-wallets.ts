import prisma from '../src/lib/prisma';
import { resolvePricingMarketForMinistryAdmin } from '../src/utils/pricingMarkets';

const APPLY = process.argv.includes('--apply');

function currency(value?: string | null) {
  return String(value || '').trim().toUpperCase();
}

async function main() {
  console.log(APPLY ? 'Applying church wallet market backfill...' : 'Dry run only. No database changes will be made.');

  const churches = await prisma.church.findMany({
    where: { status: 'active', ministryAdminId: { not: null } },
    include: {
      ministryAdmin: { select: { id: true, email: true, accountCountry: true } },
      wallet: true,
    },
    orderBy: [{ name: 'asc' }],
  });

  let missingWallets = 0;
  let repairedWallets = 0;
  let reviewRequired = 0;
  let alreadyCorrect = 0;

  console.log(`Active churches found: ${churches.length}`);

  for (const church of churches) {
    if (!church.ministryAdminId) continue;

    const market = await resolvePricingMarketForMinistryAdmin(church.ministryAdminId);
    const expectedCurrency = currency(market.currencyCode);
    const walletCurrency = currency(church.wallet?.currency);
    const balance = Number(church.wallet?.balance ?? 0);

    if (!church.wallet) {
      missingWallets += 1;
      console.log(`MISSING wallet: ${church.name} | ministry=${church.ministryAdmin?.email || church.ministryAdminId} | country=${church.ministryAdmin?.accountCountry || 'n/a'} | market=${market.name} | currency=${expectedCurrency}`);

      if (APPLY) {
        await prisma.wallet.create({
          data: {
            churchId: church.id,
            ministryAdminId: church.ministryAdminId,
            balance: 0,
            currency: expectedCurrency,
          },
        });
      }
      continue;
    }

    if (walletCurrency === expectedCurrency) {
      alreadyCorrect += 1;
      continue;
    }

    if (balance === 0) {
      repairedWallets += 1;
      console.log(`REPAIR zero-balance wallet: ${church.name} | wallet=${church.wallet.id} | ${walletCurrency || 'blank'} -> ${expectedCurrency} | market=${market.name}`);

      if (APPLY) {
        await prisma.wallet.update({
          where: { id: church.wallet.id },
          data: { currency: expectedCurrency },
        });
      }
      continue;
    }

    reviewRequired += 1;
    console.log(`REVIEW required: ${church.name} | wallet=${church.wallet.id} | balance=${balance} ${walletCurrency} | market currency=${expectedCurrency} | market=${market.name}`);
  }

  console.log('');
  console.log('Church wallet market backfill summary');
  console.log(`Already correct: ${alreadyCorrect}`);
  console.log(`Missing wallets: ${missingWallets}`);
  console.log(`Zero-balance currency repairs: ${repairedWallets}`);
  console.log(`Non-zero currency mismatches needing review: ${reviewRequired}`);
  console.log(APPLY ? 'Backfill complete.' : 'Dry run complete. Run with --apply to create missing wallets and repair zero-balance currency mismatches.');
}

main()
  .catch((error) => {
    console.error('Church wallet market backfill failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
