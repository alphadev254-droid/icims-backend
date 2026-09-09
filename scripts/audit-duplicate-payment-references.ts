import prisma from '../src/lib/prisma';

async function main() {
  const duplicateReferences = await prisma.$queryRaw<Array<{
    reference: string;
    records: bigint;
  }>>`
    SELECT reference, COUNT(*) AS records
    FROM payments
    WHERE reference IS NOT NULL AND reference <> ''
    GROUP BY reference
    HAVING COUNT(*) > 1
    ORDER BY records DESC, reference ASC
  `;

  if (duplicateReferences.length === 0) {
    console.log('No duplicate package payment references found.');
    return;
  }

  console.log(`Duplicate package payment references found: ${duplicateReferences.length}`);
  for (const row of duplicateReferences) {
    console.log(`- ${row.reference}: ${Number(row.records)} records`);
  }

  const references = duplicateReferences.map(row => row.reference);
  const payments = await prisma.payment.findMany({
    where: { reference: { in: references } },
    select: {
      id: true,
      reference: true,
      ministryAdminId: true,
      packageId: true,
      invoiceId: true,
      amount: true,
      currency: true,
      status: true,
      gateway: true,
      paidAt: true,
      createdAt: true,
    },
    orderBy: [{ reference: 'asc' }, { createdAt: 'asc' }],
  });

  console.table(payments);
  process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error('Duplicate payment reference audit failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
