import 'dotenv/config';
import prisma from '../src/lib/prisma';
import { syncLegacyMinistryWithdrawal, syncLegacyPlatformWithdrawal } from '../src/services/legacyPayoutService';

type Kind = 'ministry' | 'platform';
type Summary = { scanned: number; migrated: number; failed: number };

const apply = process.argv.includes('--apply');
const verifyOnly = process.argv.includes('--verify-only');
const batchArg = process.argv.find(arg => arg.startsWith('--batch-size='));
const batchSize = Math.min(1000, Math.max(1, Number(batchArg?.split('=')[1] || 100)));

async function tableExists(tableName: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ present: number | bigint }>>(
    'SELECT COUNT(*) AS present FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?',
    tableName,
  );
  return Number(rows[0]?.present || 0) > 0;
}

async function counts() {
  const [ministryLegacy, platformLegacy, ministryMigrated, platformMigrated] = await Promise.all([
    prisma.withdrawal.count(),
    prisma.platformWithdrawal.count(),
    prisma.payout.count({ where: { legacyWithdrawalId: { not: null } } }),
    prisma.payout.count({ where: { legacyPlatformWithdrawalId: { not: null } } }),
  ]);
  return {
    ministry: { legacy: ministryLegacy, migrated: ministryMigrated, missing: Math.max(0, ministryLegacy - ministryMigrated) },
    platform: { legacy: platformLegacy, migrated: platformMigrated, missing: Math.max(0, platformLegacy - platformMigrated) },
  };
}

async function migrateKind(kind: Kind): Promise<Summary> {
  const summary: Summary = { scanned: 0, migrated: 0, failed: 0 };
  let cursor: string | undefined;
  while (true) {
    const rows = kind === 'ministry'
      ? await prisma.withdrawal.findMany({
          select: { id: true }, orderBy: { id: 'asc' }, take: batchSize,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        })
      : await prisma.platformWithdrawal.findMany({
          select: { id: true }, orderBy: { id: 'asc' }, take: batchSize,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
    if (rows.length === 0) break;
    for (const row of rows) {
      summary.scanned += 1;
      try {
        if (kind === 'ministry') await syncLegacyMinistryWithdrawal(row.id);
        else await syncLegacyPlatformWithdrawal(row.id);
        summary.migrated += 1;
      } catch (error: any) {
        summary.failed += 1;
        console.error(`[${kind}] ${row.id}: ${error.message}`);
      }
    }
    cursor = rows[rows.length - 1].id;
    console.log(`[${kind}] scanned=${summary.scanned} migrated=${summary.migrated} failed=${summary.failed}`);
  }
  return summary;
}

async function main() {
  if (!(await tableExists('payouts'))) {
    throw new Error('The payouts table does not exist. Run the generic payouts database migration first.');
  }
  const before = await counts();
  console.log('Before:', JSON.stringify(before));
  if (!apply || verifyOnly) {
    console.log(verifyOnly ? 'Verification only; no rows changed.' : 'Dry run only. Re-run with --apply to backfill payout mirrors.');
    return;
  }
  const ministry = await migrateKind('ministry');
  const platform = await migrateKind('platform');
  const after = await counts();
  console.log('After:', JSON.stringify(after));
  console.log('Result:', JSON.stringify({ ministry, platform }));
  const failed = ministry.failed + platform.failed;
  if (failed > 0 || after.ministry.missing > 0 || after.platform.missing > 0) {
    throw new Error(`Backfill verification failed: errors=${failed}, ministryMissing=${after.ministry.missing}, platformMissing=${after.platform.missing}`);
  }
  console.log('Payout backfill and verification completed successfully.');
}

main().catch(error => {
  console.error(error.message || error);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
