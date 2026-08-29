import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const FEATURES = [
  // Core Features
  { name: 'members_management', displayName: 'Members Management', description: 'This module helps you manage an online membership register of all the brethren in the church.', category: 'core', sortOrder: 1 },
  { name: 'events_management', displayName: 'Events Management', description: 'This module allows you to create church events and share them with all your church members. It also issues tickets for all ticketed events.', category: 'core', sortOrder: 2 },
  { name: 'giving_tracking', displayName: 'Giving & Donations', description: 'Online giving is made easy! You can now manage your church\'s giving online.', category: 'core', sortOrder: 3 },
  { name: 'giving_campaigns', displayName: 'Giving Campaigns', description: 'Create and manage giving campaigns.', category: 'giving', sortOrder: 24 },
  { name: 'giving_manual_records', displayName: 'Manual Giving Records', description: 'Record cash, bank, mobile money, or other manual giving records.', category: 'giving', sortOrder: 25 },
  { name: 'giving_online_payments', displayName: 'Online Giving Payments', description: 'Accept online giving payments through configured payment providers.', category: 'giving', sortOrder: 26 },
  { name: 'giving_public_links', displayName: 'Public Giving Links', description: 'Generate public giving links for campaigns.', category: 'giving', sortOrder: 27 },
  { name: 'giving_qr_codes', displayName: 'Giving QR Codes', description: 'Generate QR codes for public giving links.', category: 'giving', sortOrder: 28 },
  { name: 'giving_wallets', displayName: 'Giving Wallets', description: 'Track ministry and church wallet balances from giving collections.', category: 'giving', sortOrder: 29 },
  { name: 'giving_withdrawals', displayName: 'Giving Withdrawals', description: 'Request withdrawals from giving wallet balances.', category: 'giving', sortOrder: 30 },
  { name: 'giving_cell_offering', displayName: 'Cell/Fellowship Offering', description: 'Track giving connected to cell and fellowship offerings.', category: 'giving', sortOrder: 31 },
  { name: 'attendance_tracking', displayName: 'Attendance Tracking', description: 'Report every church meeting and retrieve the data at any time in the future.', category: 'core', sortOrder: 4 },
  { name: 'resources_library', displayName: 'Resources Library', description: 'This module gives you a platform to keep resource materials that can be accessed by all church members.', category: 'core', sortOrder: 5 },
  { name: 'churches_management', displayName: 'Churches Management', description: 'Create your church and manage how data flows from the churches under you in this module.', category: 'core', sortOrder: 6 },
  { name: 'transactions_view', displayName: 'Transactions View', description: 'View all the giving transactions on your account as they happen.', category: 'core', sortOrder: 7 },
  
  // Management Features
  { name: 'users_management', displayName: 'Users Management', description: 'Manage the users using this module.', category: 'management', sortOrder: 8 },
  { name: 'roles_permissions', displayName: 'Roles & Permissions', description: 'Assign roles and permissions to the users using this module.', category: 'management', sortOrder: 9 },
  
  // Communication Features
  { name: 'communication', displayName: 'Communication & Announcements', description: 'This module helps you manage your communication within the church. You communicate directly with your targeted audience in the church/ministry.', category: 'communication', sortOrder: 10 },
  { name: 'teams_management', displayName: 'Teams Management', description: 'Assign your church members to teams to ensure they are engaged in the ministry\'s work.', category: 'communication', sortOrder: 11 },
  { name: 'reminders_management', displayName: 'Reminders Management', description: 'This module reminds you of special days, including anniversaries, birthdays, and ministry events, so that you do not miss any.', category: 'communication', sortOrder: 12 },
  
  // Reporting Features
  { name: 'reports_analytics', displayName: 'Reports & Analytics', description: 'Access all your giving, attendance, and membership reports using this module.', category: 'reporting', sortOrder: 13 },
  { name: 'performance_dashboard', displayName: 'Performance Dashboard', description: 'Track all your Key Performance Indicators using this module.', category: 'reporting', sortOrder: 14 },
  { name: 'advanced_reports', displayName: 'Advanced Reports', description: 'Export and analyze your data using other analytical softwares.', category: 'reporting', sortOrder: 15 },
  
  // Event Features
  { name: 'event_ticketing', displayName: 'Event Ticketing', description: 'Issue tickets for your events using this module.', category: 'events', sortOrder: 16 },
  { name: 'event_attendance', displayName: 'Event Attendance Tracking', description: 'Report your service attendance using this module.', category: 'events', sortOrder: 17 },
  
  // Cell / Fellowship Management
  { name: 'cell_management', displayName: 'Cell & Fellowship Management', description: 'Manage cells and home fellowships using this module.', category: 'management', sortOrder: 21 },

  // Pledges
  { name: 'pledges_management', displayName: 'Pledge Management', description: 'Allow members to make giving pledges against campaigns and track fulfillment over time.', category: 'core', sortOrder: 22 },

  // Church Website
  { name: 'church_website', displayName: 'Church Public Website', description: 'Publish a branded public website on your own subdomain with custom branding, about section, service times, and contact info.', category: 'core', sortOrder: 23 },

  // Limits
  { name: 'max_members', displayName: 'Maximum Members', category: 'limit', sortOrder: 18 },
  { name: 'max_churches', displayName: 'Maximum Churches', category: 'limit', sortOrder: 19 },
  { name: 'max_events_per_month', displayName: 'Maximum Events Per Month', category: 'limit', sortOrder: 20 },
];

const MODULE_BUNDLES = [
  {
    key: 'members_core',
    name: 'Members Core',
    description: 'Membership, user, and church administration essentials.',
    category: 'core',
    sortOrder: 1,
    features: ['members_management', 'churches_management'],
  },
  {
    key: 'giving_basic',
    name: 'Giving Basic',
    description: 'Giving campaigns, manual records, and giving transaction visibility.',
    category: 'giving',
    sortOrder: 2,
    features: ['giving_tracking', 'giving_campaigns', 'giving_manual_records', 'transactions_view'],
  },
  {
    key: 'giving_full',
    name: 'Giving Full',
    description: 'Complete giving features including pledges, online payments, wallets, withdrawals, public links, QR codes, and cell/fellowship offerings.',
    category: 'giving',
    sortOrder: 3,
    features: [
      'giving_tracking',
      'giving_campaigns',
      'giving_manual_records',
      'pledges_management',
      'transactions_view',
      'giving_online_payments',
      'giving_public_links',
      'giving_qr_codes',
      'giving_wallets',
      'giving_withdrawals',
      'giving_cell_offering',
    ],
  },
  {
    key: 'attendance_full',
    name: 'Attendance Full',
    description: 'Attendance records, attendance reporting, and attendance exports.',
    category: 'attendance',
    sortOrder: 4,
    features: ['attendance_tracking'],
  },
  {
    key: 'events_full',
    name: 'Events Full',
    description: 'Event management, ticketing, and event attendance.',
    category: 'events',
    sortOrder: 5,
    features: ['events_management', 'event_ticketing', 'event_attendance'],
  },
  {
    key: 'communication_full',
    name: 'Communication Full',
    description: 'Announcements, teams, reminders, and communication tools.',
    category: 'communication',
    sortOrder: 6,
    features: ['communication', 'teams_management', 'reminders_management'],
  },
  {
    key: 'reports_full',
    name: 'Reports Full',
    description: 'Reports, analytics, performance dashboards, and advanced exports.',
    category: 'reporting',
    sortOrder: 7,
    features: ['reports_analytics', 'performance_dashboard', 'advanced_reports'],
  },
  {
    key: 'operations_full',
    name: 'Operations Full',
    description: 'Resources, roles, permissions, public website, and cell/fellowship operations.',
    category: 'management',
    sortOrder: 8,
    features: ['resources_library', 'users_management', 'roles_permissions', 'church_website', 'cell_management'],
  },
];

const PACKAGES = [
  {
    name: 'basic',
    displayName: 'Basic',
    description: 'Essential features for small churches',
    priceMonthly: 20,    // KES 2,580/mo  (20 × 129)
    priceYearly: 240,    // KES 30,960/yr (240 × 129)
    sortOrder: 1,
    features: [
      { name: 'members_management', limit: null },
      { name: 'events_management', limit: null },
      { name: 'giving_tracking', limit: null },
      { name: 'attendance_tracking', limit: null },
      { name: 'churches_management', limit: null },
      { name: 'transactions_view', limit: null },
      { name: 'max_members', limit: 100 },
      { name: 'max_churches', limit: 1 },
      { name: 'max_events_per_month', limit: 10 },
    ]
  },
  {
    name: 'standard',
    displayName: 'Standard',
    description: 'Advanced features for growing churches',
    priceMonthly: 30,    // KES 3,870/mo  (30 × 129)
    priceYearly: 360,    // KES 46,440/yr (360 × 129)
    sortOrder: 2,
    features: [
      { name: 'members_management', limit: null },
      { name: 'events_management', limit: null },
      { name: 'giving_tracking', limit: null },
      { name: 'attendance_tracking', limit: null },
      { name: 'resources_library', limit: null },
      { name: 'churches_management', limit: null },
      { name: 'transactions_view', limit: null },
      { name: 'communication', limit: null },
      { name: 'teams_management', limit: null },
      { name: 'reminders_management', limit: null },
      { name: 'reports_analytics', limit: null },
      { name: 'event_ticketing', limit: null },
      { name: 'event_attendance', limit: null },
      { name: 'pledges_management', limit: null },
      { name: 'church_website', limit: null },
      { name: 'max_members', limit: 500 },
      { name: 'max_churches', limit: 5 },
      { name: 'max_events_per_month', limit: 50 },
    ]
  },
  {
    name: 'premium',
    displayName: 'Premium',
    description: 'Complete solution for large church networks',
    priceMonthly: 50,    // KES 6,450/mo  (50 × 129)
    priceYearly: 600,    // KES 77,400/yr (600 × 129)
    sortOrder: 3,
    features: [
      { name: 'members_management', limit: null },
      { name: 'events_management', limit: null },
      { name: 'giving_tracking', limit: null },
      { name: 'attendance_tracking', limit: null },
      { name: 'resources_library', limit: null },
      { name: 'churches_management', limit: null },
      { name: 'transactions_view', limit: null },
      { name: 'users_management', limit: null },
      { name: 'roles_permissions', limit: null },
      { name: 'communication', limit: null },
      { name: 'teams_management', limit: null },
      { name: 'reminders_management', limit: null },
      { name: 'reports_analytics', limit: null },
      { name: 'performance_dashboard', limit: null },
      { name: 'advanced_reports', limit: null },
      { name: 'event_ticketing', limit: null },
      { name: 'event_attendance', limit: null },
      { name: 'cell_management', limit: null },
      { name: 'pledges_management', limit: null },
      { name: 'church_website', limit: null },
      { name: 'max_members', limit: 999999 },
      { name: 'max_churches', limit: 999 },
      { name: 'max_events_per_month', limit: 999999 },
    ]
  }
];

const PACKAGE_BUNDLES: Record<string, string[]> = {
  basic: ['members_core', 'giving_basic', 'attendance_full', 'events_full'],
  standard: ['members_core', 'giving_full', 'attendance_full', 'events_full', 'communication_full', 'operations_full'],
  premium: ['members_core', 'giving_full', 'attendance_full', 'events_full', 'communication_full', 'reports_full', 'operations_full'],
};

async function main() {
  console.log('🌱 Seeding packages and features...\n');

  // 1. Create Features
  console.log('📦 Creating package features...');
  for (const feature of FEATURES) {
    await prisma.packageFeature.upsert({
      where: { name: feature.name },
      update: { displayName: feature.displayName, description: feature.description, category: feature.category, sortOrder: feature.sortOrder },
      create: feature,
    });
  }
  console.log(`✅ Created ${FEATURES.length} features\n`);

  // 2. Create module bundles and link their features
  console.log('🧩 Creating module bundles...');
  for (const bundleConfig of MODULE_BUNDLES) {
    const { features, ...bundleData } = bundleConfig;
    const bundle = await prisma.moduleBundle.upsert({
      where: { key: bundleConfig.key },
      update: bundleData,
      create: bundleData,
    });

    for (const featureName of features) {
      const feature = await prisma.packageFeature.findUnique({ where: { name: featureName } });
      if (!feature) continue;

      await prisma.moduleBundleFeature.upsert({
        where: {
          bundleId_featureId: {
            bundleId: bundle.id,
            featureId: feature.id,
          },
        },
        update: { enabled: true },
        create: {
          bundleId: bundle.id,
          featureId: feature.id,
          enabled: true,
        },
      });
    }
  }
  console.log(`✅ Created ${MODULE_BUNDLES.length} module bundles\n`);

  // 3. Create Packages
  console.log('📦 Creating packages...');
  for (const pkg of PACKAGES) {
    const { features, ...packageData } = pkg;
    
    const createdPackage = await prisma.package.upsert({
      where: { name: pkg.name },
      update: packageData,
      create: packageData,
    });

    // Link features to package with limits
    for (const featureConfig of features) {
      const feature = await prisma.packageFeature.findUnique({
        where: { name: featureConfig.name },
      });

      if (feature) {
        await prisma.packageFeatureLink.upsert({
          where: {
            packageId_featureId: {
              packageId: createdPackage.id,
              featureId: feature.id,
            },
          },
          update: { limitValue: featureConfig.limit },
          create: {
            packageId: createdPackage.id,
            featureId: feature.id,
            limitValue: featureConfig.limit,
          },
        });
      }
    }

    for (const bundleKey of PACKAGE_BUNDLES[pkg.name] ?? []) {
      const bundle = await prisma.moduleBundle.findUnique({ where: { key: bundleKey } });
      if (!bundle) continue;

      await prisma.packageModuleBundle.upsert({
        where: {
          packageId_bundleId: {
            packageId: createdPackage.id,
            bundleId: bundle.id,
          },
        },
        update: {},
        create: {
          packageId: createdPackage.id,
          bundleId: bundle.id,
        },
      });
    }
  }
  console.log(`✅ Created ${PACKAGES.length} packages\n`);

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
