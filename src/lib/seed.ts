import 'dotenv/config';
import prisma from './prisma';
import { hashPassword } from './password';

// ─── All permission definitions (seeded globally once) ─────────────────────────

const ALL_PERMISSIONS = [
  { name: 'dashboard:read',       resource: 'dashboard',     action: 'read'   },
  { name: 'members:read',         resource: 'members',       action: 'read'   },
  { name: 'members:create',       resource: 'members',       action: 'create' },
  { name: 'members:update',       resource: 'members',       action: 'update' },
  { name: 'members:delete',       resource: 'members',       action: 'delete' },
  { name: 'events:read',          resource: 'events',        action: 'read'   },
  { name: 'events:create',        resource: 'events',        action: 'create' },
  { name: 'events:update',        resource: 'events',        action: 'update' },
  { name: 'events:delete',        resource: 'events',        action: 'delete' },
  { name: 'giving:read',          resource: 'giving',        action: 'read'   },
  { name: 'giving:create',        resource: 'giving',        action: 'create' },
  { name: 'giving:update',        resource: 'giving',        action: 'update' },
  { name: 'giving:delete',        resource: 'giving',        action: 'delete' },
  { name: 'attendance:read',      resource: 'attendance',    action: 'read'   },
  { name: 'attendance:create',    resource: 'attendance',    action: 'create' },
  { name: 'attendance:update',    resource: 'attendance',    action: 'update' },
  { name: 'churches:read',        resource: 'churches',      action: 'read'   },
  { name: 'churches:create',      resource: 'churches',      action: 'create' },
  { name: 'churches:update',      resource: 'churches',      action: 'update' },
  { name: 'churches:delete',      resource: 'churches',      action: 'delete' },
  { name: 'communication:read',   resource: 'communication', action: 'read'   },
  { name: 'communication:create', resource: 'communication', action: 'create' },
  { name: 'communication:update', resource: 'communication', action: 'update' },
  { name: 'communication:delete', resource: 'communication', action: 'delete' },
  { name: 'resources:read',       resource: 'resources',     action: 'read'   },
  { name: 'resources:create',     resource: 'resources',     action: 'create' },
  { name: 'reports:read',         resource: 'reports',       action: 'read'   },
  { name: 'performance:read',     resource: 'performance',   action: 'read'   },
  { name: 'settings:read',        resource: 'settings',      action: 'read'   },
  { name: 'settings:update',      resource: 'settings',      action: 'update' },
  { name: 'users:read',           resource: 'users',         action: 'read'   },
  { name: 'users:create',         resource: 'users',         action: 'create' },
  { name: 'users:update',         resource: 'users',         action: 'update' },
  { name: 'users:delete',         resource: 'users',         action: 'delete' },
  { name: 'roles:read',           resource: 'roles',         action: 'read'   },
  { name: 'roles:assign',         resource: 'roles',         action: 'assign' },
  { name: 'roles:manage',         resource: 'roles',         action: 'manage' },
  // Packages & Payments
  { name: 'packages:read',        resource: 'packages',      action: 'read'   },
  { name: 'packages:manage',      resource: 'packages',      action: 'manage' },
  { name: 'payments:read',        resource: 'payments',      action: 'read'   },
  { name: 'payments:create',      resource: 'payments',      action: 'create' },
];

const ALL_PERM_NAMES = ALL_PERMISSIONS.map(p => p.name);

// ─── Default permissions per role per package ──────────────────────────────────

const PREMIUM_PERMS: Record<string, string[]> = {
  national_admin:    ALL_PERM_NAMES,
  regional_leader:   [
    'dashboard:read', 'members:read', 'giving:read', 'attendance:read',
    'churches:read', 'reports:read', 'performance:read', 'users:read', 'roles:read',
    'packages:read',
  ],
  district_overseer: [
    'dashboard:read', 'members:read', 'giving:read', 'attendance:read',
    'churches:read', 'reports:read', 'users:read', 'roles:read',
  ],
  local_admin: [
    'dashboard:read',
    'members:read', 'members:create', 'members:update', 'members:delete',
    'events:read', 'events:create', 'events:update', 'events:delete',
    'giving:read', 'giving:create', 'giving:update', 'giving:delete',
    'attendance:read', 'attendance:create', 'attendance:update',
    'communication:read', 'communication:create', 'communication:update', 'communication:delete',
    'resources:read', 'resources:create',
    'reports:read', 'settings:read', 'settings:update',
    'users:read', 'users:create', 'users:update',
    'roles:read', 'roles:assign',
    'packages:read', 'payments:read', 'payments:create',
  ],
  member: ['dashboard:read', 'events:read', 'giving:read', 'communication:read', 'resources:read'],
};

// Standard/Basic: local_admin is super admin; other roles start empty
const STANDARD_PERMS: Record<string, string[]> = {
  national_admin:    [],
  regional_leader:   [],
  district_overseer: [],
  local_admin:       ALL_PERM_NAMES,
  member:            ['dashboard:read', 'events:read', 'giving:read', 'communication:read', 'resources:read'],
};

const ROLE_DISPLAY_NAMES: Record<string, string> = {
  national_admin:    'National Administrator',
  regional_leader:   'Regional Leader',
  district_overseer: 'District Overseer',
  local_admin:       'Local Administrator',
  member:            'Member',
};

// ─── Package tiers ─────────────────────────────────────────────────────────────

const PACKAGES = [
  {
    name: 'basic',
    displayName: 'Basic',
    description: 'Essential tools for a single local congregation to manage members and giving.',
    priceMonthly: 5000,
    priceYearly: 50000,
    maxChurches: 1,
    sortOrder: 1,
  },
  {
    name: 'standard',
    displayName: 'Standard',
    description: 'Advanced features for growing churches — events, attendance, communication, and reporting.',
    priceMonthly: 15000,
    priceYearly: 150000,
    maxChurches: 5,
    sortOrder: 2,
  },
  {
    name: 'premium',
    displayName: 'Premium',
    description: 'Full denomination management — multi-church oversight, analytics, roles, and all features.',
    priceMonthly: 35000,
    priceYearly: 350000,
    maxChurches: 999,
    sortOrder: 3,
  },
];

// ─── Package features ──────────────────────────────────────────────────────────

const PACKAGE_FEATURES = [
  { name: 'member_management',     displayName: 'Member Management',       category: 'core',          sortOrder: 1, description: 'Add, edit, and track congregation members' },
  { name: 'giving_tracking',       displayName: 'Giving & Donations',      category: 'core',          sortOrder: 2, description: 'Record tithes, offerings, and pledges' },
  { name: 'event_management',      displayName: 'Event Management',        category: 'core',          sortOrder: 3, description: 'Create and manage church events' },
  { name: 'attendance_tracking',   displayName: 'Attendance Tracking',     category: 'core',          sortOrder: 4, description: 'Record and monitor service attendance' },
  { name: 'basic_dashboard',       displayName: 'Basic Dashboard',         category: 'core',          sortOrder: 5, description: 'Overview of key church statistics' },
  { name: 'announcements',         displayName: 'Announcements',           category: 'communication', sortOrder: 1, description: 'Post announcements to congregation' },
  { name: 'prayer_requests',       displayName: 'Prayer Requests',         category: 'communication', sortOrder: 2, description: 'Share and track prayer requests' },
  { name: 'sms_notifications',     displayName: 'SMS Notifications',       category: 'communication', sortOrder: 3, description: 'Send SMS alerts to members' },
  { name: 'basic_reports',         displayName: 'Basic Reports',           category: 'reporting',     sortOrder: 1, description: 'Standard giving and attendance reports' },
  { name: 'advanced_reports',      displayName: 'Advanced Reports',        category: 'reporting',     sortOrder: 2, description: 'Custom date-range financial and growth reports' },
  { name: 'performance_analytics', displayName: 'Performance Analytics',   category: 'reporting',     sortOrder: 3, description: 'Trend analysis and growth metrics' },
  { name: 'export_data',           displayName: 'Data Export (CSV/PDF)',   category: 'reporting',     sortOrder: 4, description: 'Export reports to CSV or PDF' },
  { name: 'multi_church',          displayName: 'Multi-Church Management', category: 'management',    sortOrder: 1, description: 'Manage multiple branches under one account' },
  { name: 'role_management',       displayName: 'Roles & Permissions',     category: 'management',    sortOrder: 2, description: 'Assign custom roles and permissions to users' },
  { name: 'resource_library',      displayName: 'Resource Library',        category: 'management',    sortOrder: 3, description: 'Upload and share documents and sermons' },
  { name: 'user_management',       displayName: 'User Management',         category: 'management',    sortOrder: 4, description: 'Create and manage user accounts' },
  { name: 'package_management',    displayName: 'Package Management',      category: 'management',    sortOrder: 5, description: 'Manage subscription packages and payments' },
  { name: 'api_access',            displayName: 'API Access',              category: 'management',    sortOrder: 6, description: 'Integrate with third-party systems via REST API' },
];

// Which features belong to each package
const PACKAGE_FEATURE_MAP: Record<string, string[]> = {
  basic: [
    'member_management', 'giving_tracking', 'basic_dashboard',
    'announcements', 'basic_reports', 'user_management',
  ],
  standard: [
    'member_management', 'giving_tracking', 'event_management', 'attendance_tracking', 'basic_dashboard',
    'announcements', 'prayer_requests',
    'basic_reports', 'advanced_reports', 'export_data',
    'role_management', 'resource_library', 'user_management', 'package_management',
  ],
  premium: [
    'member_management', 'giving_tracking', 'event_management', 'attendance_tracking', 'basic_dashboard',
    'announcements', 'prayer_requests', 'sms_notifications',
    'basic_reports', 'advanced_reports', 'performance_analytics', 'export_data',
    'multi_church', 'role_management', 'resource_library', 'user_management', 'package_management', 'api_access',
  ],
};

// ─── Helper: seed roles + permissions for one church ───────────────────────────

async function seedChurchRoles(
  churchId: string,
  pkg: string,
  permMap: Map<string, string>,
): Promise<Map<string, string>> {
  const roleNames = ['national_admin', 'regional_leader', 'district_overseer', 'local_admin', 'member'];
  const perms = pkg === 'premium' ? PREMIUM_PERMS : STANDARD_PERMS;
  const roleIdMap = new Map<string, string>();

  for (const name of roleNames) {
    const role = await prisma.role.upsert({
      where: { name_churchId: { name, churchId } },
      update: {},
      create: { name, displayName: ROLE_DISPLAY_NAMES[name], churchId },
    });
    roleIdMap.set(name, role.id);

    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    const permNames = perms[name] ?? [];
    if (permNames.length > 0) {
      await prisma.rolePermission.createMany({
        data: permNames.map(pn => ({
          roleId: role.id,
          permissionId: permMap.get(pn)!,
        })),
        skipDuplicates: true,
      });
    }
  }

  return roleIdMap;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🌱 Seeding database...');

  // 1. Seed global permissions
  for (const perm of ALL_PERMISSIONS) {
    await prisma.permission.upsert({
      where: { name: perm.name },
      update: {},
      create: perm,
    });
  }
  const allPerms = await prisma.permission.findMany();
  const permMap = new Map(allPerms.map(p => [p.name, p.id]));

  // 2. Seed package tiers
  const packageIdMap = new Map<string, string>();
  for (const pkg of PACKAGES) {
    const p = await prisma.package.upsert({
      where: { name: pkg.name },
      update: { 
        displayName: pkg.displayName, 
        description: pkg.description, 
        priceMonthly: pkg.priceMonthly, 
        priceYearly: pkg.priceYearly, 
        maxChurches: pkg.maxChurches,
        sortOrder: pkg.sortOrder 
      },
      create: pkg,
    });
    packageIdMap.set(pkg.name, p.id);
  }

  // 3. Seed package features
  const featureIdMap = new Map<string, string>();
  for (const feat of PACKAGE_FEATURES) {
    const f = await prisma.packageFeature.upsert({
      where: { name: feat.name },
      update: { displayName: feat.displayName, description: feat.description, category: feat.category, sortOrder: feat.sortOrder },
      create: feat,
    });
    featureIdMap.set(feat.name, f.id);
  }

  // 4. Seed package ↔ feature links
  for (const [pkgName, featureNames] of Object.entries(PACKAGE_FEATURE_MAP)) {
    const packageId = packageIdMap.get(pkgName)!;
    await prisma.packageFeatureLink.deleteMany({ where: { packageId } });
    await prisma.packageFeatureLink.createMany({
      data: featureNames.map(fn => ({ packageId, featureId: featureIdMap.get(fn)! })),
      skipDuplicates: true,
    });
  }

  // 5. Seed church hierarchy
  const denomination = await prisma.church.upsert({
    where: { branchCode: 'CCAP-NAT' },
    update: {},
    create: {
      name: 'Church of Central Africa Presbyterian (CCAP)',
      level: 'national', location: 'Lilongwe, Malawi',
      country: 'Malawi', branchCode: 'CCAP-NAT', email: 'national@ccap.org.mw',
      phone: '+265 1 123 456', memberCount: 0,
    },
  });

  const centralRegion = await prisma.church.upsert({
    where: { branchCode: 'CCAP-CEN' },
    update: {},
    create: {
      name: 'CCAP Central Region', level: 'regional',
      location: 'Lilongwe', country: 'Malawi', region: 'Central',
      branchCode: 'CCAP-CEN', parentId: denomination.id, memberCount: 0,
    },
  });

  const lilongweDistrict = await prisma.church.upsert({
    where: { branchCode: 'CCAP-LLW' },
    update: {},
    create: {
      name: 'CCAP Lilongwe District', level: 'district',
      location: 'Lilongwe', country: 'Malawi', region: 'Central', district: 'Lilongwe',
      branchCode: 'CCAP-LLW', parentId: centralRegion.id, memberCount: 0,
    },
  });

  const localChurch = await prisma.church.upsert({
    where: { branchCode: 'CCAP-AREA25' },
    update: {},
    create: {
      name: 'CCAP Area 25 Congregation', level: 'local',
      location: 'Area 25, Lilongwe', country: 'Malawi', region: 'Central', district: 'Lilongwe',
      traditionalAuthority: 'Kalumbu',
      address: 'Area 25, Lilongwe', branchCode: 'CCAP-AREA25',
      parentId: lilongweDistrict.id, memberCount: 0,
    },
  });

  const singleChurch = await prisma.church.upsert({
    where: { branchCode: 'GRACE-BLT' },
    update: {},
    create: {
      name: 'Grace Community Church', level: 'local',
      location: 'Blantyre, Malawi', country: 'Malawi', region: 'Southern', district: 'Blantyre',
      traditionalAuthority: 'Kapeni',
      branchCode: 'GRACE-BLT', memberCount: 0,
    },
  });

  // 6. Seed roles + permissions for each church
  const denomRoles    = await seedChurchRoles(denomination.id,     'premium',  permMap);
  const regionRoles   = await seedChurchRoles(centralRegion.id,    'premium',  permMap);
  const districtRoles = await seedChurchRoles(lilongweDistrict.id, 'premium',  permMap);
  const localRoles    = await seedChurchRoles(localChurch.id,      'premium',  permMap);
  const singleRoles   = await seedChurchRoles(singleChurch.id,     'standard', permMap);

  // 7. Seed demo users
  const adminPassword = await hashPassword('Admin@1234');

  async function upsertUser(data: {
    email: string; firstName: string; lastName: string;
    roleName: string; roleId: string; phone?: string; churchId: string;
    districts?: string; traditionalAuthorities?: string;
  }) {
    return prisma.user.upsert({
      where: { email: data.email },
      update: { roleId: data.roleId, roleName: data.roleName, districts: data.districts ?? null, traditionalAuthorities: data.traditionalAuthorities ?? null },
      create: {
        email: data.email, password: adminPassword,
        firstName: data.firstName, lastName: data.lastName,
        roleName: data.roleName, roleId: data.roleId,
        phone: data.phone, churchId: data.churchId,
        districts: data.districts,
        traditionalAuthorities: data.traditionalAuthorities,
      },
    });
  }

  await upsertUser({
    email: 'admin@icims.org', firstName: 'James', lastName: 'Banda',
    roleName: 'national_admin', roleId: denomRoles.get('national_admin')!,
    phone: '+265 999 123 456', churchId: denomination.id,
  });

  // Link national admin to premium package and churches
  const nationalAdmin = await prisma.user.findUnique({ where: { email: 'admin@icims.org' } });
  if (nationalAdmin) {
    await prisma.user.update({
      where: { id: nationalAdmin.id },
      data: { packageId: packageIdMap.get('premium') }
    });
    
    // Link all churches to this national admin
    await prisma.church.updateMany({
      where: { id: { in: [denomination.id, centralRegion.id, lilongweDistrict.id, localChurch.id] } },
      data: { nationalAdminId: nationalAdmin.id }
    });
  }

  await upsertUser({
    email: 'central.leader@ccap.org.mw', firstName: 'Grace', lastName: 'Phiri',
    roleName: 'regional_leader', roleId: regionRoles.get('regional_leader')!,
    phone: '+265 888 234 567', churchId: centralRegion.id,
  });

  await upsertUser({
    email: 'lilongwe.overseer@ccap.org.mw', firstName: 'Samuel', lastName: 'Chirwa',
    roleName: 'district_overseer', roleId: districtRoles.get('district_overseer')!,
    phone: '+265 777 345 678', churchId: lilongweDistrict.id,
    districts: JSON.stringify(['Lilongwe']),
  });

  await upsertUser({
    email: 'area25.admin@ccap.org.mw', firstName: 'Esther', lastName: 'Mwale',
    roleName: 'local_admin', roleId: localRoles.get('local_admin')!,
    phone: '+265 666 456 789', churchId: localChurch.id,
    traditionalAuthorities: JSON.stringify(['Kalumbu']),
  });

  await upsertUser({
    email: 'pastor@gracechurch.mw', firstName: 'Peter', lastName: 'Njoroge',
    roleName: 'local_admin', roleId: singleRoles.get('local_admin')!,
    churchId: singleChurch.id,
    traditionalAuthorities: JSON.stringify(['Kapeni']),
  });

  // Link single church admin to standard package
  const singleChurchAdmin = await prisma.user.findUnique({ where: { email: 'pastor@gracechurch.mw' } });
  if (singleChurchAdmin) {
    await prisma.user.update({
      where: { id: singleChurchAdmin.id },
      data: { packageId: packageIdMap.get('standard') }
    });
    
    await prisma.church.update({
      where: { id: singleChurch.id },
      data: { nationalAdminId: singleChurchAdmin.id }
    });
  }

  await upsertUser({
    email: 'grace.muthoni@ccap.org.mw', firstName: 'Grace', lastName: 'Muthoni',
    roleName: 'member', roleId: localRoles.get('member')!,
    phone: '+265 991 111 001', churchId: localChurch.id,
  });

  // 8. Seed congregation members
  const memberData = [
    { firstName: 'Grace',  lastName: 'Muthoni', phone: '+265 991 111 001', status: 'active',   roles: '["choir"]' },
    { firstName: 'James',  lastName: 'Ochieng', phone: '+265 991 111 002', status: 'active',   roles: '["usher", "deacon"]' },
    { firstName: 'Faith',  lastName: 'Wanjiru', phone: '+265 991 111 003', status: 'active',   roles: '["youth_leader"]' },
    { firstName: 'David',  lastName: 'Kamau',   phone: '+265 991 111 004', status: 'inactive', roles: '["elder"]' },
    { firstName: 'Mary',   lastName: 'Akinyi',  phone: '+265 991 111 005', status: 'active',   roles: '["finance"]' },
  ];

  for (let i = 0; i < memberData.length; i++) {
    await prisma.member.upsert({
      where: { memberId: `MBR-${String(i + 1).padStart(4, '0')}` },
      update: {},
      create: {
        ...memberData[i],
        memberId: `MBR-${String(i + 1).padStart(4, '0')}`,
        churchId: localChurch.id,
      },
    });
  }

  // 9. Clear & recreate transactional data
  await prisma.attendance.deleteMany({ where: { churchId: localChurch.id } });
  await prisma.donation.deleteMany({ where: { churchId: localChurch.id } });
  await prisma.event.deleteMany({ where: { churchId: localChurch.id } });

  const natAdmin = await prisma.user.findUnique({ where: { email: 'admin@icims.org' } });

  await prisma.event.createMany({
    data: [
      { title: 'Sunday Worship Service', description: 'Weekly Sunday worship and sermon',
        date: new Date('2026-03-02'), time: '09:00', location: 'Main Sanctuary',
        type: 'service', status: 'upcoming', attendeeCount: 250,
        churchId: localChurch.id, createdById: natAdmin!.id },
      { title: 'Youth Conference 2026', description: 'Annual youth conference',
        date: new Date('2026-04-15'), time: '08:00', location: 'Conference Hall',
        type: 'conference', status: 'upcoming', attendeeCount: 0,
        churchId: localChurch.id, createdById: natAdmin!.id },
      { title: 'Community Outreach', description: 'Monthly outreach to the community',
        date: new Date('2026-02-15'), time: '07:00', location: 'Area 25 Market',
        type: 'outreach', status: 'completed', attendeeCount: 80,
        churchId: localChurch.id, createdById: natAdmin!.id },
    ],
  });

  await prisma.donation.createMany({
    data: [
      { memberName: 'Grace Muthoni', amount: 15000, type: 'tithe',    method: 'mobile_money',  status: 'completed', churchId: localChurch.id },
      { memberName: 'James Ochieng', amount: 8000,  type: 'offering', method: 'cash',          status: 'completed', churchId: localChurch.id },
      { memberName: 'Faith Wanjiru', amount: 50000, type: 'pledge',   method: 'bank_transfer', status: 'pending',   churchId: localChurch.id },
      { memberName: 'David Kamau',   amount: 3000,  type: 'offering', method: 'cash',          status: 'completed', churchId: localChurch.id },
      { memberName: 'Mary Akinyi',   amount: 12000, type: 'tithe',    method: 'card',          status: 'completed', churchId: localChurch.id },
    ],
  });

  await prisma.attendance.createMany({
    data: [
      { churchId: localChurch.id, date: new Date('2026-02-23'), totalAttendees: 245, newVisitors: 12, serviceType: 'Sunday Service' },
      { churchId: localChurch.id, date: new Date('2026-02-16'), totalAttendees: 258, newVisitors: 8,  serviceType: 'Sunday Service' },
      { churchId: localChurch.id, date: new Date('2026-02-09'), totalAttendees: 220, newVisitors: 5,  serviceType: 'Sunday Service' },
      { churchId: localChurch.id, date: new Date('2026-02-02'), totalAttendees: 237, newVisitors: 15, serviceType: 'Sunday Service' },
    ],
  });

  console.log('✅ Seed complete!');
  console.log('');
  console.log('Demo accounts (all passwords: Admin@1234):');
  console.log('  National Admin:    admin@icims.org                  → ALL permissions');
  console.log('  Regional Leader:   central.leader@ccap.org.mw       → read-only oversight');
  console.log('  District Overseer: lilongwe.overseer@ccap.org.mw    → Lilongwe district scope');
  console.log('  Local Admin:       area25.admin@ccap.org.mw         → Kalumbu T/A scope');
  console.log('  Single Church:     pastor@gracechurch.mw            → Kapeni T/A (standard pkg)');
  console.log('  Member:            grace.muthoni@ccap.org.mw        → personal portal only');
  console.log('');
  console.log('Packages: Basic / Standard / Premium with DB features linked');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
