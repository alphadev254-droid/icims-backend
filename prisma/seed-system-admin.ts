/**
 * Seed System Admin
 * Usage: npx ts-node prisma/seed-system-admin.ts
 *
 * Creates the system_admin role (if not exists) and a system admin user.
 * Edit the credentials below before running.
 */

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const SYSTEM_ADMIN_EMAIL = 'sysadmin@icims.app';
const SYSTEM_ADMIN_PASSWORD = 'SysAdmin@2024!';
const SYSTEM_ADMIN_FIRST = 'System';
const SYSTEM_ADMIN_LAST = 'Administrator';

async function main() {
  // 1. Ensure system_admin role exists
  let role = await prisma.role.findUnique({ where: { name: 'system_admin' } });
  if (!role) {
    role = await prisma.role.create({
      data: {
        name: 'system_admin',
        displayName: 'System Administrator',
      },
    });
    console.log('✅ Created system_admin role');
  } else {
    console.log('ℹ️  system_admin role already exists');
  }

  // 2. Check if user already exists
  const existing = await prisma.user.findUnique({ where: { email: SYSTEM_ADMIN_EMAIL } });
  if (existing) {
    console.log(`ℹ️  System admin user already exists: ${SYSTEM_ADMIN_EMAIL}`);
    await prisma.$disconnect();
    return;
  }

  // 3. Create the system admin user
  const hashed = await bcrypt.hash(SYSTEM_ADMIN_PASSWORD, 12);
  const user = await prisma.user.create({
    data: {
      email: SYSTEM_ADMIN_EMAIL,
      password: hashed,
      firstName: SYSTEM_ADMIN_FIRST,
      lastName: SYSTEM_ADMIN_LAST,
      roleId: role.id,
      status: 'active',
    },
  });

  console.log(`✅ System admin created:`);
  console.log(`   Email:    ${user.email}`);
  console.log(`   Password: ${SYSTEM_ADMIN_PASSWORD}`);
  console.log(`   ID:       ${user.id}`);
  console.log('\n⚠️  Change the password after first login!');

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  prisma.$disconnect();
  process.exit(1);
});
