import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const ministryAdminRole = await prisma.role.findUnique({
    where: { name: 'ministry_admin' },
    select: { id: true },
  });

  if (!ministryAdminRole) {
    throw new Error('ministry_admin role not found');
  }

  const result = await prisma.user.updateMany({
    where: {
      roleId: ministryAdminRole.id,
      emailVerified: false,
    },
    data: {
      emailVerified: true,
      emailVerifiedAt: new Date(),
    },
  });

  console.log(`Marked ${result.count} existing ministry admin account(s) as email verified.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
