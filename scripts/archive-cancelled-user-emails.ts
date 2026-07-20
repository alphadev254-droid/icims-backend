import { PrismaClient } from '@prisma/client';
import { cancelUserAccount, buildArchivedUserEmail } from '../src/lib/userCancellation';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');

async function main() {
  const users = await prisma.user.findMany({
    where: {
      status: 'cancelled',
      email: { not: { startsWith: 'old_' } },
    },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      church: { select: { name: true } },
      role: { select: { displayName: true, name: true } },
    },
    orderBy: { updatedAt: 'desc' },
  });

  console.log(`Found ${users.length} cancelled user(s) with active-looking emails.`);

  for (const user of users) {
    const previewEmail = buildArchivedUserEmail(user.email);
    const name = `${user.firstName} ${user.lastName}`.trim();
    console.log(`- ${user.id} | ${name} | ${user.email} -> ${previewEmail} | ${user.church?.name ?? 'No church'} | ${user.role?.displayName ?? user.role?.name ?? 'No role'}`);
  }

  if (!apply) {
    console.log('\nDry run only. No database changes made.');
    console.log('Run with --apply to archive these cancelled user emails.');
    return;
  }

  for (const user of users) {
    await prisma.$transaction(async (tx) => {
      await cancelUserAccount(tx, user.id);
    });
  }

  console.log(`\nArchived ${users.length} cancelled user email(s).`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
