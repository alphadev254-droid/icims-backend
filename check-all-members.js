const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function checkAllMembers() {
  console.log('🔍 Finding all member users...\n');
  
  const memberRole = await prisma.role.findUnique({
    where: { name: 'member' },
  });

  if (!memberRole) {
    console.log('❌ Member role not found');
    return;
  }

  const members = await prisma.user.findMany({
    where: { roleId: memberRole.id },
    include: {
      role: true,
      church: { select: { name: true } },
      rolePermissions: {
        include: {
          permission: true,
        },
      },
    },
  });

  console.log(`Found ${members.length} member(s)\n`);

  if (members.length === 0) {
    console.log('No members found in database');
    return;
  }

  members.forEach((user, index) => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Member #${index + 1}`);
    console.log(`${'='.repeat(60)}`);
    console.log('ID:', user.id);
    console.log('Name:', user.firstName, user.lastName);
    console.log('Email:', user.email);
    console.log('Church:', user.church?.name || 'Not assigned');
    console.log('Role:', user.role?.name);
    
    console.log('\n🔐 Permissions:');
    if (user.rolePermissions.length === 0) {
      console.log('  ❌ No permissions assigned');
    } else {
      user.rolePermissions.forEach((rp, i) => {
        console.log(`  ${i + 1}. ${rp.permission.name}`);
      });
    }
    console.log('\nTotal permissions:', user.rolePermissions.length);
  });
}

checkAllMembers()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
