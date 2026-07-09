import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const CHILDREN_PERMISSION_NAMES = [
  'children:read',
  'children:create',
  'children:update',
  'children:delete',
];

async function main() {
  console.log('Assigning children permissions to member role...');

  const memberRole = await prisma.role.findUnique({
    where: { name: 'member' },
  });

  if (!memberRole) {
    console.log('member role not found. No permissions assigned.');
    return;
  }

  const permissions = await prisma.permission.findMany({
    where: { name: { in: CHILDREN_PERMISSION_NAMES } },
  });

  const foundNames = new Set(permissions.map(permission => permission.name));
  const missingNames = CHILDREN_PERMISSION_NAMES.filter(name => !foundNames.has(name));

  if (missingNames.length > 0) {
    console.log(`Missing permissions: ${missingNames.join(', ')}`);
    console.log('Run the children permissions migration/seed first, then run this script again.');
    return;
  }

  for (const permission of permissions) {
    await prisma.rolePermission.upsert({
      where: {
        ministryAdminId_roleId_permissionId: {
          ministryAdminId: 'GLOBAL',
          roleId: memberRole.id,
          permissionId: permission.id,
        },
      },
      update: {},
      create: {
        ministryAdminId: 'GLOBAL',
        roleId: memberRole.id,
        permissionId: permission.id,
      },
    });
  }

  console.log('Children permissions assigned to member role.');
}

main()
  .catch((error) => {
    console.error('Failed to assign children permissions to member role:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
