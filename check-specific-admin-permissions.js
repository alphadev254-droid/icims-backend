const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function checkPermissions() {
  const nationalAdminId = 'cmma6fouy001cm301l6owln0j';
  const memberRole = await prisma.role.findUnique({ where: { name: 'member' } });
  
  if (!memberRole) {
    console.log('❌ Member role not found');
    return;
  }

  const permissions = await prisma.rolePermission.findMany({
    where: {
      nationalAdminId,
      roleId: memberRole.id,
    },
    include: {
      permission: true,
    },
  });

  console.log(`\n📋 Permissions for nationalAdminId: ${nationalAdminId}`);
  console.log(`   Role: ${memberRole.displayName}`);
  console.log(`   Total: ${permissions.length}\n`);

  permissions.forEach((rp, i) => {
    console.log(`${i + 1}. ${rp.permission.name}`);
  });

  console.log('\n');
}

checkPermissions()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
