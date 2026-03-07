const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function checkMemberPermissions() {
  const memberId = 'cmma6fomy001am301qcew5lua';
  
  console.log('🔍 Checking permissions for member:', memberId);
  
  const user = await prisma.user.findUnique({
    where: { id: memberId },
    include: {
      role: true,
      rolePermissions: {
        include: {
          permission: true,
        },
      },
    },
  });

  if (!user) {
    console.log('❌ User not found');
    return;
  }

  console.log('\n👤 User Info:');
  console.log('Name:', user.firstName, user.lastName);
  console.log('Email:', user.email);
  console.log('Role:', user.role?.name);
  
  console.log('\n🔐 Permissions:');
  if (user.rolePermissions.length === 0) {
    console.log('❌ No permissions assigned');
  } else {
    user.rolePermissions.forEach((rp, index) => {
      console.log(`${index + 1}. ${rp.permission.name}`);
    });
  }
  
  console.log('\n✅ Total permissions:', user.rolePermissions.length);
}

checkMemberPermissions()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
