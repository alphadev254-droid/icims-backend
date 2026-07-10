import prisma from '../src/lib/prisma';

function calculateAge(value: Date): number | null {
  const today = new Date();
  let age = today.getFullYear() - value.getFullYear();
  const hasBirthdayPassed =
    today.getMonth() > value.getMonth() ||
    (today.getMonth() === value.getMonth() && today.getDate() >= value.getDate());
  if (!hasBirthdayPassed) age -= 1;
  return age >= 0 ? age : null;
}

async function main() {
  const children = await prisma.child.findMany({
    where: { dateOfBirth: { not: null } },
    select: { id: true, dateOfBirth: true, age: true },
  });

  let updated = 0;
  for (const child of children) {
    if (!child.dateOfBirth) continue;
    const age = calculateAge(child.dateOfBirth);
    if (age === null || age === child.age) continue;
    await prisma.child.update({
      where: { id: child.id },
      data: { age },
    });
    updated += 1;
  }

  console.log(`Backfilled age for ${updated} child record(s).`);
}

main()
  .catch(error => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
