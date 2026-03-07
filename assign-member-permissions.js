const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const MEMBER_PERMISSIONS = [
  'dashboard:read',
  'events:read',
  'giving:read',
  'giving:create',
  'communication:read',
  'resources:read',
  'transactions:read',
];

async function assignMemberPermissions() {
  console.log('🔧 Assigning permissions to existing member users...\n');
  
  const memberRole = await prisma.role.findUnique({
    where: { name: 'member' },
  });

  if (!memberRole) {
    console.log('❌ Member role not found');
    return;
  }

  const members = await prisma.user.findMany({
    where: { roleId: memberRole.id },
  });

  console.log(`Found ${members.length} member(s)\n`);

  if (members.length === 0) {
    console.log('No members to update');
    return;
  }

  const memberPermissions = MEMBER_PERMISSIONS;
  console.log('Member permissions to assign:', memberPermissions);

  const permissions = await prisma.permission.findMany({
    where: { name: { in: memberPermissions } },
  });

  console.log(`\nFound ${permissions.length} permissions in database\n`);

  for (const member of members) {
    console.log(`Processing: ${member.firstName} ${member.lastName} (${member.email})`);
    
    // Get the national admin for this member
    const nationalAdminId = member.nationalAdminId || member.id;
    
    let assigned = 0;
    for (const permission of permissions) {
      // Check if already exists
      const existing = await prisma.rolePermission.findUnique({
        where: {
          nationalAdminId_roleId_permissionId: {
            nationalAdminId,
            roleId: memberRole.id,
            permissionId: permission.id,
          },
        },
      });

      if (!existing) {
        await prisma.rolePermission.create({
          data: {
            nationalAdminId,
            roleId: memberRole.id,
            permissionId: permission.id,
          },
        });
        assigned++;
      }
    }
    
    console.log(`  ✅ Assigned ${assigned} permissions\n`);
  }

  console.log('✅ Done!');
}

assignMemberPermissions()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
