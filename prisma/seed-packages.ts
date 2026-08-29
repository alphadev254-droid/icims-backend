import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const FEATURES = [
  // Core Features
  { name: 'members_management', displayName: 'Members Management', description: 'Create, update, search, and manage church member records.', category: 'core', sortOrder: 1 },
  { name: 'events_management', displayName: 'Events Management', description: 'Create and manage church events, dates, venues, and linked churches.', category: 'core', sortOrder: 2 },
  { name: 'giving_tracking', displayName: 'Giving Overview', description: 'View giving campaigns, totals, and collection activity.', category: 'core', sortOrder: 3 },
  { name: 'giving_campaigns', displayName: 'Giving Campaigns', description: 'Create and manage giving campaigns across selected churches.', category: 'giving', sortOrder: 24 },
  { name: 'giving_manual_records', displayName: 'Manual Giving Records', description: 'Record offline cash, bank, mobile money, and other manual giving payments.', category: 'giving', sortOrder: 25 },
  { name: 'giving_online_payments', displayName: 'Online Giving Payments', description: 'Accept giving payments through the configured online checkout.', category: 'giving', sortOrder: 26 },
  { name: 'giving_public_links', displayName: 'Public Giving Links', description: 'Create shareable campaign links for public giving.', category: 'giving', sortOrder: 27 },
  { name: 'giving_qr_codes', displayName: 'Giving QR Codes', description: 'Generate QR codes for campaign giving links.', category: 'giving', sortOrder: 28 },
  { name: 'giving_wallets', displayName: 'Wallets', description: 'Track ministry and church wallet balances from giving, event, and other collection flows.', category: 'giving', sortOrder: 29 },
  { name: 'giving_withdrawals', displayName: 'Withdrawals', description: 'Request withdrawals from ministry and church wallet balances.', category: 'giving', sortOrder: 30 },
  { name: 'giving_cell_offering', displayName: 'Cell/Fellowship Offering', description: 'Track giving connected to cell and fellowship offerings.', category: 'giving', sortOrder: 31 },
  { name: 'attendance_tracking', displayName: 'Attendance Tracking', description: 'Create attendance records, scan check-ins, and view attendance summaries.', category: 'core', sortOrder: 4 },
  { name: 'resources_library', displayName: 'Resources Library', description: 'Publish resources and documents for church members.', category: 'core', sortOrder: 5 },
  { name: 'churches_management', displayName: 'Churches Management', description: 'Create and manage ministry churches and their hierarchy.', category: 'core', sortOrder: 6 },
  { name: 'transactions_view', displayName: 'Transactions View', description: 'View giving, ticket, package, and wallet transaction records.', category: 'core', sortOrder: 7 },
  
  // Management Features
  { name: 'users_management', displayName: 'Users Management', description: 'Create, edit, activate, and manage system users.', category: 'management', sortOrder: 8 },
  { name: 'roles_permissions', displayName: 'Roles & Permissions', description: 'Create roles, assign permissions, and control data scope.', category: 'management', sortOrder: 9 },
  
  // Communication Features
  { name: 'communication', displayName: 'Communication & Announcements', description: 'Send targeted church and ministry announcements.', category: 'communication', sortOrder: 10 },
  { name: 'teams_management', displayName: 'Teams Management', description: 'Create teams and assign members for ministry work.', category: 'communication', sortOrder: 11 },
  { name: 'reminders_management', displayName: 'Reminders Management', description: 'Track birthdays, anniversaries, ministry dates, and scheduled reminders.', category: 'communication', sortOrder: 12 },
  
  // Reporting Features
  { name: 'reports_analytics', displayName: 'Reports & Analytics', description: 'View ministry reports for giving, attendance, events, and members.', category: 'reporting', sortOrder: 13 },
  { name: 'performance_dashboard', displayName: 'Performance Dashboard', description: 'View KPI dashboards and ministry performance trends.', category: 'reporting', sortOrder: 14 },
  { name: 'advanced_reports', displayName: 'Advanced Reports', description: 'Export detailed data for deeper analysis.', category: 'reporting', sortOrder: 15 },
  
  // Event Features
  { name: 'event_ticketing', displayName: 'Event Ticketing', description: 'Create and manage tickets for events.', category: 'events', sortOrder: 16 },
  { name: 'event_attendance', displayName: 'Event Attendance Tracking', description: 'Create event attendance records and connect tickets to attendance.', category: 'events', sortOrder: 17 },
  { name: 'event_public_links', displayName: 'Event Public Links', description: 'Generate public event links for registration and ticket booking.', category: 'events', sortOrder: 32 },
  { name: 'event_qr_codes', displayName: 'Event QR Codes', description: 'Generate QR codes for public event links.', category: 'events', sortOrder: 33 },
  { name: 'event_member_booking', displayName: 'Member Event Booking', description: 'Allow signed-in members to book their own event tickets.', category: 'events', sortOrder: 34 },
  { name: 'event_guest_booking', displayName: 'Guest Event Booking', description: 'Allow guests to register or buy tickets from public event pages.', category: 'events', sortOrder: 35 },
  { name: 'event_online_payments', displayName: 'Event Online Payments', description: 'Accept online payments for paid event tickets.', category: 'events', sortOrder: 36 },
  { name: 'event_manual_payments', displayName: 'Event Manual Payments', description: 'Record manual cash, bank, mobile money, or other ticket payments.', category: 'events', sortOrder: 37 },
  { name: 'event_ticket_scanning', displayName: 'Event Ticket Scanning', description: 'Scan booked tickets into event attendance records.', category: 'events', sortOrder: 38 },
  { name: 'event_reports', displayName: 'Event Reports', description: 'View event ticket lists, attendance summaries, and event exports.', category: 'events', sortOrder: 39 },
  
  // Cell / Fellowship Management
  { name: 'cell_management', displayName: 'Cell & Fellowship Management', description: 'Manage cells, fellowships, meetings, attendance, and member assignments.', category: 'management', sortOrder: 21 },

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
    description: 'Event management, public links, QR codes, member and guest booking, ticket payments, scanning, and event reports.',
    category: 'events',
    sortOrder: 5,
    features: [
      'events_management',
      'event_public_links',
      'event_qr_codes',
      'event_member_booking',
      'event_guest_booking',
      'event_ticketing',
      'event_online_payments',
      'event_manual_payments',
      'event_attendance',
      'event_ticket_scanning',
      'event_reports',
    ],
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
