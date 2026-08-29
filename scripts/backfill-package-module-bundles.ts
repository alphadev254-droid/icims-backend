import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply');
const PRESERVE_EXISTING_OVERRIDES = !process.argv.includes('--replace-overrides');

const FEATURES = [
  { name: 'members_management', displayName: 'Members Management', description: 'This module helps you manage an online membership register of all the brethren in the church.', category: 'core', sortOrder: 1 },
  { name: 'events_management', displayName: 'Events Management', description: 'This module allows you to create church events and share them with all your church members. It also issues tickets for all ticketed events.', category: 'core', sortOrder: 2 },
  { name: 'giving_tracking', displayName: 'Giving & Donations', description: 'Online giving is made easy! You can now manage your church\'s giving online.', category: 'core', sortOrder: 3 },
  { name: 'attendance_tracking', displayName: 'Attendance Tracking', description: 'Report every church meeting and retrieve the data at any time in the future.', category: 'core', sortOrder: 4 },
  { name: 'resources_library', displayName: 'Resources Library', description: 'This module gives you a platform to keep resource materials that can be accessed by all church members.', category: 'core', sortOrder: 5 },
  { name: 'churches_management', displayName: 'Churches Management', description: 'Create your church and manage how data flows from the churches under you in this module.', category: 'core', sortOrder: 6 },
  { name: 'transactions_view', displayName: 'Transactions View', description: 'View all the giving transactions on your account as they happen.', category: 'core', sortOrder: 7 },
  { name: 'users_management', displayName: 'Users Management', description: 'Manage the users using this module.', category: 'management', sortOrder: 8 },
  { name: 'roles_permissions', displayName: 'Roles & Permissions', description: 'Assign roles and permissions to the users using this module.', category: 'management', sortOrder: 9 },
  { name: 'communication', displayName: 'Communication & Announcements', description: 'This module helps you manage your communication within the church. You communicate directly with your targeted audience in the church/ministry.', category: 'communication', sortOrder: 10 },
  { name: 'teams_management', displayName: 'Teams Management', description: 'Assign your church members to teams to ensure they are engaged in the ministry\'s work.', category: 'communication', sortOrder: 11 },
  { name: 'reminders_management', displayName: 'Reminders Management', description: 'This module reminds you of special days, including anniversaries, birthdays, and ministry events, so that you do not miss any.', category: 'communication', sortOrder: 12 },
  { name: 'reports_analytics', displayName: 'Reports & Analytics', description: 'Access all your giving, attendance, and membership reports using this module.', category: 'reporting', sortOrder: 13 },
  { name: 'performance_dashboard', displayName: 'Performance Dashboard', description: 'Track all your Key Performance Indicators using this module.', category: 'reporting', sortOrder: 14 },
  { name: 'advanced_reports', displayName: 'Advanced Reports', description: 'Export and analyze your data using other analytical softwares.', category: 'reporting', sortOrder: 15 },
  { name: 'event_ticketing', displayName: 'Event Ticketing', description: 'Issue tickets for your events using this module.', category: 'events', sortOrder: 16 },
  { name: 'event_attendance', displayName: 'Event Attendance Tracking', description: 'Report your service attendance using this module.', category: 'events', sortOrder: 17 },
  { name: 'max_members', displayName: 'Maximum Members', category: 'limit', sortOrder: 18 },
  { name: 'max_churches', displayName: 'Maximum Churches', category: 'limit', sortOrder: 19 },
  { name: 'max_events_per_month', displayName: 'Maximum Events Per Month', category: 'limit', sortOrder: 20 },
  { name: 'cell_management', displayName: 'Cell & Fellowship Management', description: 'Manage cells and home fellowships using this module.', category: 'management', sortOrder: 21 },
  { name: 'pledges_management', displayName: 'Pledge Management', description: 'Allow members to make giving pledges against campaigns and track fulfillment over time.', category: 'core', sortOrder: 22 },
  { name: 'church_website', displayName: 'Church Public Website', description: 'Publish a branded public website on your own subdomain with custom branding, about section, service times, and contact info.', category: 'core', sortOrder: 23 },
  { name: 'giving_campaigns', displayName: 'Giving Campaigns', description: 'Create and manage giving campaigns.', category: 'giving', sortOrder: 24 },
  { name: 'giving_manual_records', displayName: 'Manual Giving Records', description: 'Record cash, bank, mobile money, or other manual giving records.', category: 'giving', sortOrder: 25 },
  { name: 'giving_online_payments', displayName: 'Online Giving Payments', description: 'Accept online giving payments through configured payment providers.', category: 'giving', sortOrder: 26 },
  { name: 'giving_public_links', displayName: 'Public Giving Links', description: 'Generate public giving links for campaigns.', category: 'giving', sortOrder: 27 },
  { name: 'giving_qr_codes', displayName: 'Giving QR Codes', description: 'Generate QR codes for public giving links.', category: 'giving', sortOrder: 28 },
  { name: 'giving_wallets', displayName: 'Wallets', description: 'Track ministry and church wallet balances from giving, event, and other collection flows.', category: 'giving', sortOrder: 29 },
  { name: 'giving_withdrawals', displayName: 'Withdrawals', description: 'Request withdrawals from ministry and church wallet balances.', category: 'giving', sortOrder: 30 },
  { name: 'giving_cell_offering', displayName: 'Cell/Fellowship Offering', description: 'Track giving connected to cell and fellowship offerings.', category: 'giving', sortOrder: 31 },
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
    key: 'giving_full',
    name: 'Giving Full',
    description: 'Giving campaigns, manual records, pledges, online payments, public links, QR codes, wallets, withdrawals, and cell/fellowship offerings.',
    category: 'giving',
    sortOrder: 2,
    features: [
      'giving_tracking',
      'giving_campaigns',
      'giving_manual_records',
      'giving_online_payments',
      'giving_public_links',
      'giving_qr_codes',
      'giving_wallets',
      'giving_withdrawals',
      'giving_cell_offering',
      'transactions_view',
      'pledges_management',
    ],
  },
  {
    key: 'attendance_full',
    name: 'Attendance Full',
    description: 'Attendance records, attendance reporting, exports, and attendance links.',
    category: 'attendance',
    sortOrder: 3,
    features: ['attendance_tracking'],
  },
  {
    key: 'events_full',
    name: 'Events Full',
    description: 'Event management, event tickets, and event attendance.',
    category: 'events',
    sortOrder: 4,
    features: ['events_management', 'event_ticketing', 'event_attendance'],
  },
  {
    key: 'communication_full',
    name: 'Communication Full',
    description: 'Announcements, teams, reminders, and communication tools.',
    category: 'communication',
    sortOrder: 5,
    features: ['communication', 'teams_management', 'reminders_management'],
  },
  {
    key: 'reports_full',
    name: 'Reports Full',
    description: 'Reports, analytics, performance dashboards, and advanced exports.',
    category: 'reporting',
    sortOrder: 6,
    features: ['reports_analytics', 'performance_dashboard', 'advanced_reports'],
  },
  {
    key: 'operations_full',
    name: 'Operations Full',
    description: 'Resources, users, roles, church website, and cell/fellowship operations.',
    category: 'management',
    sortOrder: 7,
    features: ['resources_library', 'users_management', 'roles_permissions', 'church_website', 'cell_management'],
  },
];

const NEW_GIVING_FEATURES = new Set([
  'giving_campaigns',
  'giving_manual_records',
  'giving_online_payments',
  'giving_public_links',
  'giving_qr_codes',
  'giving_wallets',
  'giving_withdrawals',
  'giving_cell_offering',
]);

const BUNDLE_TRIGGERS: Record<string, string[]> = {
  members_core: ['members_management', 'churches_management'],
  giving_full: ['giving_tracking', 'transactions_view', 'pledges_management'],
  attendance_full: ['attendance_tracking'],
  events_full: ['events_management', 'event_ticketing', 'event_attendance'],
  communication_full: ['communication', 'teams_management', 'reminders_management'],
  reports_full: ['reports_analytics', 'performance_dashboard', 'advanced_reports'],
  operations_full: ['resources_library', 'users_management', 'roles_permissions', 'church_website', 'cell_management'],
};

function shouldEnableFeature(featureName: string, packageFeatureNames: Set<string>) {
  if (packageFeatureNames.has(featureName)) return true;
  return NEW_GIVING_FEATURES.has(featureName) && packageFeatureNames.has('giving_tracking');
}

async function main() {
  console.log(APPLY ? 'Applying package bundle backfill...' : 'Dry run only. No database changes will be made.');

  const packages = await prisma.package.findMany({
    orderBy: [{ sortOrder: 'asc' }, { displayName: 'asc' }],
    include: {
      features: { include: { feature: true } },
      moduleBundles: { include: { bundle: true } },
      bundleFeatureOverrides: true,
    },
  });

  const activeSubscriptions = await prisma.subscription.findMany({
    where: { status: 'active' },
    select: { packageId: true, ministryAdminId: true },
  });
  const ministryAdminIds = [...new Set(activeSubscriptions.map(sub => sub.ministryAdminId))];
  const ministryAdmins = await prisma.user.findMany({
    where: { id: { in: ministryAdminIds } },
    select: { id: true, firstName: true, lastName: true, ministryName: true, email: true },
  });
  const adminById = new Map(ministryAdmins.map(admin => [admin.id, admin]));

  console.log(`Packages found: ${packages.length}`);
  console.log(`Active subscriptions found: ${activeSubscriptions.length}`);

  if (APPLY) {
    for (const feature of FEATURES) {
      await prisma.packageFeature.upsert({
        where: { name: feature.name },
        update: feature,
        create: feature,
      });
    }

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
          where: { bundleId_featureId: { bundleId: bundle.id, featureId: feature.id } },
          update: { enabled: true },
          create: { bundleId: bundle.id, featureId: feature.id, enabled: true },
        });
      }
    }
  }

  const featureRows = APPLY
    ? await prisma.packageFeature.findMany()
    : FEATURES.map((feature, index) => ({ ...feature, id: `dry-run-feature-${index}` }));
  const featureByName = new Map(featureRows.map(feature => [feature.name, feature]));
  const bundleByKey = new Map(
    (APPLY ? await prisma.moduleBundle.findMany() : MODULE_BUNDLES.map((bundle, index) => ({ ...bundle, id: `dry-run-${index}` }))).map(bundle => [bundle.key, bundle]),
  );

  for (const pkg of packages) {
    const packageFeatureNames = new Set(pkg.features.map(link => link.feature.name));
    const selectedBundleKeys = MODULE_BUNDLES
      .filter(bundle => (BUNDLE_TRIGGERS[bundle.key] ?? []).some(featureName => packageFeatureNames.has(featureName)))
      .map(bundle => bundle.key);

    const activeUsers = activeSubscriptions
      .filter(sub => sub.packageId === pkg.id)
      .map(sub => adminById.get(sub.ministryAdminId))
      .filter(Boolean)
      .map(admin => admin?.ministryName || `${admin?.firstName ?? ''} ${admin?.lastName ?? ''}`.trim() || admin?.email)
      .filter(Boolean);

    console.log('');
    console.log(`PACKAGE: ${pkg.displayName} (${pkg.name})`);
    console.log(`  Current direct features: ${[...packageFeatureNames].sort().join(', ') || 'none'}`);
    console.log(`  Bundles to link: ${selectedBundleKeys.join(', ') || 'none'}`);
    console.log(`  Active ministries using this package: ${activeUsers.length ? activeUsers.join(' | ') : 'none'}`);

    for (const bundleKey of selectedBundleKeys) {
      const bundleConfig = MODULE_BUNDLES.find(item => item.key === bundleKey);
      const bundle = bundleByKey.get(bundleKey);
      if (!bundle || !bundleConfig) continue;

      const disabledFeatureNames = bundleConfig.features.filter(featureName => !shouldEnableFeature(featureName, packageFeatureNames));
      console.log(`  - ${bundleConfig.name}: disable overrides needed for ${disabledFeatureNames.length ? disabledFeatureNames.join(', ') : 'none'}`);

      if (!APPLY) continue;

      await prisma.packageModuleBundle.upsert({
        where: { packageId_bundleId: { packageId: pkg.id, bundleId: bundle.id } },
        update: {},
        create: { packageId: pkg.id, bundleId: bundle.id },
      });

      for (const featureName of disabledFeatureNames) {
        const feature = featureByName.get(featureName);
        if (!feature) continue;

        const existingOverride = await prisma.packageBundleFeatureOverride.findUnique({
          where: {
            packageId_bundleId_featureId: {
              packageId: pkg.id,
              bundleId: bundle.id,
              featureId: feature.id,
            },
          },
        });

        if (existingOverride && PRESERVE_EXISTING_OVERRIDES) continue;

        await prisma.packageBundleFeatureOverride.upsert({
          where: {
            packageId_bundleId_featureId: {
              packageId: pkg.id,
              bundleId: bundle.id,
              featureId: feature.id,
            },
          },
          update: {
            enabled: false,
            reason: 'Backfilled to preserve existing package access when moving to module bundles.',
          },
          create: {
            packageId: pkg.id,
            bundleId: bundle.id,
            featureId: feature.id,
            enabled: false,
            reason: 'Backfilled to preserve existing package access when moving to module bundles.',
          },
        });
      }
    }
  }

  console.log('');
  if (!APPLY) {
    console.log('Dry run complete. Run with --apply to create/update features, bundles, package bundle links, and preservation overrides.');
  } else {
    console.log('Package bundle backfill complete.');
  }
}

main()
  .catch(error => {
    console.error('Package bundle backfill failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
