import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const CHILDREN_PERMISSIONS = [
  { name: 'children:read', resource: 'children', action: 'read' },
  { name: 'children:create', resource: 'children', action: 'create' },
  { name: 'children:update', resource: 'children', action: 'update' },
  { name: 'children:delete', resource: 'children', action: 'delete' },
];

async function main() {
  console.log('Seeding children/dependents permissions...');

  for (const permission of CHILDREN_PERMISSIONS) {
    await prisma.permission.upsert({
      where: { name: permission.name },
      update: {
        resource: permission.resource,
        action: permission.action,
      },
      create: permission,
    });
  }

  const ministryAdminRole = await prisma.role.findUnique({
    where: { name: 'ministry_admin' },
  });

  if (!ministryAdminRole) {
    console.log('ministry_admin role not found. Permissions were created but not assigned.');
    return;
  }

  const permissions = await prisma.permission.findMany({
    where: { name: { in: CHILDREN_PERMISSIONS.map(permission => permission.name) } },
  });

  for (const permission of permissions) {
    await prisma.rolePermission.upsert({
      where: {
        ministryAdminId_roleId_permissionId: {
          ministryAdminId: 'GLOBAL',
          roleId: ministryAdminRole.id,
          permissionId: permission.id,
        },
      },
      update: {},
      create: {
        ministryAdminId: 'GLOBAL',
        roleId: ministryAdminRole.id,
        permissionId: permission.id,
      },
    });
  }

  console.log('Children permissions seeded and assigned to ministry_admin.');
  console.log('Regional, district, and branch admins can be granted these from Roles.');
}

main()
  .catch((error) => {
    console.error('Failed to seed children permissions:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
