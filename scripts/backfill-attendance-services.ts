import prisma from '../src/lib/prisma';

async function main() {
  const apply = process.argv.includes('--apply');
  const where = { serviceId: null, eventId: null };
  const total = await prisma.attendance.count({ where });
  console.log(
    `${total} attendance records need service links${apply ? '' : ' (dry run)'}.`,
  );
  if (!apply) return;

  let linked = 0;
  while (true) {
    const records = await prisma.attendance.findMany({
      where,
      select: { id: true, churchId: true, date: true, serviceType: true },
      orderBy: { id: 'asc' },
      take: 100,
    });
    if (!records.length) break;
    for (const record of records) {
      await prisma.$transaction(async (tx) => {
        const current = await tx.attendance.findUnique({
          where: { id: record.id },
          select: { serviceId: true },
        });
        if (!current || current.serviceId) return;
        const service = await tx.service.create({
          data: {
            churchId: record.churchId,
            title: record.serviceType || 'Service',
            type: record.serviceType || null,
            startsAt: record.date,
            status: 'completed',
          },
        });
        await tx.attendance.update({
          where: { id: record.id },
          data: { serviceId: service.id },
        });
        linked += 1;
      });
    }
  }
  console.log(`Linked ${linked} attendance records to services. ${await prisma.attendance.count({ where })} remain.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
