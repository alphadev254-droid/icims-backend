import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/lib/password';

const prisma = new PrismaClient();

const PERMISSIONS = [
  { name: 'dashboard:read', resource: 'dashboard', action: 'read' },
  { name: 'members:read', resource: 'members', action: 'read' },
  { name: 'members:create', resource: 'members', action: 'create' },
  { name: 'members:update', resource: 'members', action: 'update' },
  { name: 'members:delete', resource: 'members', action: 'delete' },
  { name: 'events:read', resource: 'events', action: 'read' },
  { name: 'events:create', resource: 'events', action: 'create' },
  { name: 'events:update', resource: 'events', action: 'update' },
  { name: 'events:delete', resource: 'events', action: 'delete' },
  { name: 'giving:read', resource: 'giving', action: 'read' },
  { name: 'giving:create', resource: 'giving', action: 'create' },
  { name: 'giving:update', resource: 'giving', action: 'update' },
  { name: 'giving:delete', resource: 'giving', action: 'delete' },
  { name: 'attendance:read', resource: 'attendance', action: 'read' },
  { name: 'attendance:create', resource: 'attendance', action: 'create' },
  { name: 'attendance:update', resource: 'attendance', action: 'update' },
  { name: 'attendance:delete', resource: 'attendance', action: 'delete' },
  { name: 'churches:read', resource: 'churches', action: 'read' },
  { name: 'churches:create', resource: 'churches', action: 'create' },
  { name: 'churches:update', resource: 'churches', action: 'update' },
  { name: 'churches:delete', resource: 'churches', action: 'delete' },
  { name: 'communication:read', resource: 'communication', action: 'read' },
  { name: 'communication:create', resource: 'communication', action: 'create' },
  { name: 'communication:update', resource: 'communication', action: 'update' },
  { name: 'communication:delete', resource: 'communication', action: 'delete' },
  { name: 'resources:read', resource: 'resources', action: 'read' },
  { name: 'resources:create', resource: 'resources', action: 'create' },
  { name: 'reports:read', resource: 'reports', action: 'read' },
  { name: 'performance:read', resource: 'performance', action: 'read' },
  { name: 'settings:read', resource: 'settings', action: 'read' },
  { name: 'settings:update', resource: 'settings', action: 'update' },
  { name: 'users:read', resource: 'users', action: 'read' },
  { name: 'users:create', resource: 'users', action: 'create' },
  { name: 'users:update', resource: 'users', action: 'update' },
  { name: 'users:delete', resource: 'users', action: 'delete' },
  { name: 'roles:read', resource: 'roles', action: 'read' },
  { name: 'roles:assign', resource: 'roles', action: 'assign' },
  { name: 'roles:manage', resource: 'roles', action: 'manage' },
  { name: 'packages:read', resource: 'packages', action: 'read' },
  { name: 'packages:manage', resource: 'packages', action: 'manage' },
  { name: 'payments:read', resource: 'payments', action: 'read' },
  { name: 'payments:create', resource: 'payments', action: 'create' },
];

const ROLES = [
  { name: 'national_admin', displayName: 'National Administrator' },
  { name: 'regional_leader', displayName: 'Regional Leader' },
  { name: 'district_overseer', displayName: 'District Overseer' },
  { name: 'local_admin', displayName: 'Local Administrator' },
  { name: 'member', displayName: 'Member' },
];

async function main() {
  console.log('🌱 Starting database seed...\n');

  // 1. Create Permissions
  console.log('📋 Creating permissions...');
  for (const perm of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { name: perm.name },
      update: {},
      create: perm,
    });
  }
  console.log(`✅ Created ${PERMISSIONS.length} permissions\n`);

  // 2. Create Roles
  console.log('👥 Creating roles...');
  for (const role of ROLES) {
    await prisma.role.upsert({
      where: { name: role.name },
      update: {},
      create: role,
    });
  }
  console.log(`✅ Created ${ROLES.length} roles\n`);

  // 3. Create admin user if not exists
  console.log('👤 Creating admin user...');
  const nationalAdminRole = await prisma.role.findUnique({
    where: { name: 'national_admin' },
  });

  if (!nationalAdminRole) {
    throw new Error('National admin role not found');
  }

  let adminUser = await prisma.user.findUnique({
    where: { email: 'admin@icims.org' },
  });

  if (!adminUser) {
    const hashedPassword = await hashPassword('Admin@1234');
    adminUser = await prisma.user.create({
      data: {
        email: 'admin@icims.org',
        password: hashedPassword,
        firstName: 'Admin',
        lastName: 'User',
        roleId: nationalAdminRole.id,
      },
    });
    console.log('✅ Created admin user: admin@icims.org\n');
  } else {
    console.log('✅ Admin user already exists: admin@icims.org\n');
  }

  // 4. Link ALL permissions to admin user's national_admin role
  console.log('🔗 Linking all permissions to admin user...');
  const allPermissions = await prisma.permission.findMany();
  
  let linked = 0;
  for (const permission of allPermissions) {
    const existing = await prisma.rolePermission.findUnique({
      where: {
        nationalAdminId_roleId_permissionId: {
          nationalAdminId: adminUser.id,
          roleId: nationalAdminRole.id,
          permissionId: permission.id,
        },
      },
    });

    if (!existing) {
      await prisma.rolePermission.create({
        data: {
          nationalAdminId: adminUser.id,
          roleId: nationalAdminRole.id,
          permissionId: permission.id,
        },
      });
      linked++;
    }
  }

  console.log(`✅ Linked ${linked} new permissions (${allPermissions.length} total)\n`);

  console.log('🎉 Database seeded successfully!\n');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📝 Login Credentials:');
  console.log('   Email:    admin@icims.org');
  console.log('   Password: Admin@1234');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main()
  .catch((e) => {
    console.error('❌ Error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
