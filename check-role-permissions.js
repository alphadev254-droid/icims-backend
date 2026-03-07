const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function checkMemberRolePermissions() {
  const roleId = 'cmma6fomy001am301qcew5lua';
  
  console.log('🔍 Checking permissions for role ID:', roleId);
  
  const role = await prisma.role.findUnique({
    where: { id: roleId },
  });

  if (!role) {
    console.log('❌ Role not found');
    return;
  }

  console.log('\n📋 Role Info:');
  console.log('Name:', role.name);
  console.log('Display Name:', role.displayName);
  
  // Get all role-permission mappings for this role
  const rolePermissions = await prisma.rolePermission.findMany({
    where: { roleId: roleId },
    include: {
      permission: true,
    },
  });

  console.log('\n🔐 Permissions assigned to this role:');
  if (rolePermissions.length === 0) {
    console.log('❌ No permissions assigned to this role');
  } else {
    rolePermissions.forEach((rp, index) => {
      console.log(`${index + 1}. ${rp.permission.name}`);
    });
  }
  
  console.log('\n✅ Total permissions:', rolePermissions.length);
}

checkMemberRolePermissions()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
