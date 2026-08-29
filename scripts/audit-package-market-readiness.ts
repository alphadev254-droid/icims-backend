import prisma from '../src/lib/prisma';

type PackageRow = {
  id: string;
  name: string;
  displayName: string;
  priceMonthly: number;
  priceYearly: number;
  currencyCode?: string | null;
  isPrivate: number | boolean;
  isActive: number | boolean;
};

type SubscriptionRow = {
  packageId: string;
  ministryAdminId: string;
  status: string;
  expiresAt: Date;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  ministryName: string | null;
  accountCountry: string | null;
};

async function columnExists(tableName: string, columnName: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint | number }>>(
    `
      SELECT COUNT(*) AS count
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
    `,
    tableName,
    columnName,
  );
  return Number(rows[0]?.count || 0) > 0;
}

function boolLabel(value: number | boolean) {
  return value === true || value === 1 ? 'yes' : 'no';
}

function ministryLabel(row: SubscriptionRow) {
  return row.ministryName || `${row.firstName || ''} ${row.lastName || ''}`.trim() || row.email || row.ministryAdminId;
}

async function main() {
  const hasPackageCurrency = await columnExists('packages', 'currencyCode');
  const packages = await prisma.$queryRawUnsafe<PackageRow[]>(`
    SELECT
      id,
      name,
      displayName,
      priceMonthly,
      priceYearly,
      ${hasPackageCurrency ? 'currencyCode' : "'USD' AS currencyCode"},
      isPrivate,
      isActive
    FROM packages
    ORDER BY sortOrder ASC, displayName ASC
  `);

  const subscriptions = await prisma.$queryRawUnsafe<SubscriptionRow[]>(`
    SELECT
      s.packageId,
      s.ministryAdminId,
      s.status,
      s.expiresAt,
      u.firstName,
      u.lastName,
      u.email,
      u.ministryName,
      u.accountCountry
    FROM subscriptions s
    LEFT JOIN users u ON u.id = s.ministryAdminId
    WHERE s.status = 'active'
    ORDER BY u.ministryName ASC, u.firstName ASC, u.lastName ASC
  `);

  console.log('Package market readiness audit');
  console.log(`Package currency column present: ${hasPackageCurrency ? 'yes' : 'no'}`);
  console.log(`Packages found: ${packages.length}`);
  console.log(`Active subscriptions found: ${subscriptions.length}`);

  for (const pkg of packages) {
    const linked = subscriptions.filter((sub) => sub.packageId === pkg.id);
    console.log(`\nPACKAGE: ${pkg.displayName} (${pkg.name})`);
    console.log(`  id: ${pkg.id}`);
    console.log(`  active: ${boolLabel(pkg.isActive)} | private/custom: ${boolLabel(pkg.isPrivate)}`);
    console.log(`  package price: ${pkg.currencyCode || 'USD'} ${Number(pkg.priceMonthly).toLocaleString()}/mo, ${Number(pkg.priceYearly).toLocaleString()}/yr`);
    if (boolLabel(pkg.isPrivate) === 'yes') {
      console.log('  new model: private package keeps this package-table price; no market prices should be created.');
    } else {
      console.log('  new model: public package gets rows in package_market_prices per pricing market.');
    }

    if (linked.length === 0) {
      console.log('  active ministries: none');
      continue;
    }

    console.log('  active ministries:');
    for (const sub of linked) {
      console.log(`  - ${ministryLabel(sub)} | country=${sub.accountCountry || 'not set'} | admin=${sub.ministryAdminId} | expires=${new Date(sub.expiresAt).toISOString()}`);
    }
  }
}

main()
  .catch((error) => {
    console.error('Package market readiness audit failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
