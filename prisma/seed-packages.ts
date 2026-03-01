import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const FEATURES = [
  { name: 'members_management', displayName: 'Members Management', category: 'core', sortOrder: 1 },
  { name: 'events_management', displayName: 'Events Management', category: 'core', sortOrder: 2 },
  { name: 'giving_tracking', displayName: 'Giving & Donations', category: 'core', sortOrder: 3 },
  { name: 'attendance_tracking', displayName: 'Attendance Tracking', category: 'core', sortOrder: 4 },
  { name: 'churches_management', displayName: 'Churches Management', category: 'management', sortOrder: 5 },
  { name: 'communication', displayName: 'Communication & Announcements', category: 'communication', sortOrder: 6 },
  { name: 'resources_library', displayName: 'Resources Library', category: 'core', sortOrder: 7 },
  { name: 'reports_analytics', displayName: 'Reports & Analytics', category: 'reporting', sortOrder: 8 },
  { name: 'performance_dashboard', displayName: 'Performance Dashboard', category: 'reporting', sortOrder: 9 },
  { name: 'users_management', displayName: 'Users Management', category: 'management', sortOrder: 10 },
  { name: 'roles_permissions', displayName: 'Roles & Permissions', category: 'management', sortOrder: 11 },
];

const PACKAGES = [
  {
    name: 'basic',
    displayName: 'Basic',
    description: 'Essential features for small churches',
    priceMonthly: 0,
    priceYearly: 0,
    maxChurches: 1,
    sortOrder: 1,
    features: ['members_management', 'events_management', 'giving_tracking', 'attendance_tracking']
  },
  {
    name: 'standard',
    displayName: 'Standard',
    description: 'Advanced features for growing churches',
    priceMonthly: 50000,
    priceYearly: 500000,
    maxChurches: 5,
    sortOrder: 2,
    features: ['members_management', 'events_management', 'giving_tracking', 'attendance_tracking', 'churches_management', 'communication', 'resources_library', 'reports_analytics']
  },
  {
    name: 'premium',
    displayName: 'Premium',
    description: 'Complete solution for large church networks',
    priceMonthly: 100000,
    priceYearly: 1000000,
    maxChurches: 999,
    sortOrder: 3,
    features: ['members_management', 'events_management', 'giving_tracking', 'attendance_tracking', 'churches_management', 'communication', 'resources_library', 'reports_analytics', 'performance_dashboard', 'users_management', 'roles_permissions']
  }
];

async function main() {
  console.log('🌱 Seeding packages and features...\n');

  // 1. Create Features
  console.log('📦 Creating package features...');
  for (const feature of FEATURES) {
    await prisma.packageFeature.upsert({
      where: { name: feature.name },
      update: {},
      create: feature,
    });
  }
  console.log(`✅ Created ${FEATURES.length} features\n`);

  // 2. Create Packages
  console.log('📦 Creating packages...');
  for (const pkg of PACKAGES) {
    const { features, ...packageData } = pkg;
    
    const createdPackage = await prisma.package.upsert({
      where: { name: pkg.name },
      update: packageData,
      create: packageData,
    });

    // Link features to package
    for (const featureName of features) {
      const feature = await prisma.packageFeature.findUnique({
        where: { name: featureName },
      });

      if (feature) {
        await prisma.packageFeatureLink.upsert({
          where: {
            packageId_featureId: {
              packageId: createdPackage.id,
              featureId: feature.id,
            },
          },
          update: {},
          create: {
            packageId: createdPackage.id,
            featureId: feature.id,
          },
        });
      }
    }
  }
  console.log(`✅ Created ${PACKAGES.length} packages\n`);

  // 3. Assign premium package to admin user
  console.log('👤 Assigning package to admin user...');
  const adminUser = await prisma.user.findUnique({
    where: { email: 'admin@icims.org' },
  });

  if (adminUser) {
    const premiumPackage = await prisma.package.findUnique({
      where: { name: 'premium' },
    });

    if (premiumPackage) {
      await prisma.user.update({
        where: { id: adminUser.id },
        data: { packageId: premiumPackage.id },
      });
      console.log('✅ Assigned Premium package to admin@icims.org\n');
    }
  } else {
    console.log('⚠️  Admin user not found\n');
  }

  console.log('🎉 Packages seeded successfully!\n');
}

main()
  .catch((e) => {
    console.error('❌ Error seeding packages:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
