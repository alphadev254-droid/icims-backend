import prisma from '../src/lib/prisma';

const LEGACY_ROLE_NAMES = ['regional_admin', 'district_admin', 'branch_admin'];

async function main() {
  const apply = process.argv.includes('--apply');

  console.log(`${apply ? 'Applying' : 'Dry run'} legacy role cleanup`);
  console.log(`Roles checked: ${LEGACY_ROLE_NAMES.join(', ')}\n`);

  const roles = await prisma.role.findMany({
    where: { name: { in: LEGACY_ROLE_NAMES } },
    include: {
      users: {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          church: { select: { name: true } },
          ministryAdminId: true,
        },
        take: 10,
      },
      _count: { select: { users: true, permissions: true } },
      scope: true,
    },
    orderBy: { name: 'asc' },
  });

  if (roles.length === 0) {
    console.log('No legacy roles found.');
    return;
  }

  for (const role of roles) {
    console.log(`Role: ${role.name} (${role.displayName})`);
    console.log(`- id: ${role.id}`);
    console.log(`- users assigned: ${role._count.users}`);
    console.log(`- permissions linked: ${role._count.permissions}`);
    console.log(`- has scope: ${role.scope ? 'yes' : 'no'}`);

    if (role._count.users > 0) {
      console.log('- action: skipped because users are still assigned');
      for (const user of role.users) {
        const name = `${user.firstName} ${user.lastName}`.trim();
        console.log(`  - ${name || user.email} | ${user.email} | church=${user.church?.name ?? '-'} | ministryAdminId=${user.ministryAdminId ?? '-'}`);
      }
      if (role._count.users > role.users.length) {
        console.log(`  ...and ${role._count.users - role.users.length} more user(s)`);
      }
      console.log('');
      continue;
    }

    if (!apply) {
      console.log('- action: would delete role permissions, scope, and role\n');
      continue;
    }

    await prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { roleId: role.id } });
      await tx.roleScope.deleteMany({ where: { roleId: role.id } });
      await tx.role.delete({ where: { id: role.id } });
    });

    console.log('- action: deleted\n');
  }

  if (!apply) {
    console.log('Dry run only. Re-run with --apply to delete legacy roles with zero assigned users.');
  }
}

main()
  .catch((error) => {
    console.error('Legacy role cleanup failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
