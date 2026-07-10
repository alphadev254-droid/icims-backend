import prisma from '../src/lib/prisma';
import { hashPassword } from '../src/lib/password';

function childIdentityEmail(childId: string) {
  return `child.${childId}@children.icims.local`;
}

async function main() {
  const memberRole = await prisma.role.findUnique({ where: { name: 'member' }, select: { id: true } });
  if (!memberRole) throw new Error('Member role not found');

  const children = await prisma.child.findMany({
    where: { userId: null },
    select: {
      id: true,
      churchId: true,
      firstName: true,
      lastName: true,
      phone: true,
      gender: true,
      dateOfBirth: true,
      status: true,
    },
  });

  let created = 0;
  for (const child of children) {
    const password = await hashPassword(`child-${child.id}-${Date.now()}-${Math.random()}`);
    const user = await prisma.user.upsert({
      where: { email: childIdentityEmail(child.id) },
      create: {
        email: childIdentityEmail(child.id),
        password,
        firstName: child.firstName,
        lastName: child.lastName,
        phone: child.phone || null,
        gender: child.gender || null,
        dateOfBirth: child.dateOfBirth || null,
        churchId: child.churchId,
        roleId: memberRole.id,
        membershipType: 'member',
        memberType: 'child',
        loginEnabled: false,
        status: child.status || 'active',
      },
      update: {
        firstName: child.firstName,
        lastName: child.lastName,
        phone: child.phone || null,
        gender: child.gender || null,
        dateOfBirth: child.dateOfBirth || null,
        churchId: child.churchId,
        roleId: memberRole.id,
        membershipType: 'member',
        memberType: 'child',
        loginEnabled: false,
        status: child.status || 'active',
      },
      select: { id: true },
    });

    await prisma.child.update({
      where: { id: child.id },
      data: { userId: user.id },
    });
    created += 1;
  }

  console.log(`Linked ${created} child record(s) to child user identities.`);
}

main()
  .catch(error => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
