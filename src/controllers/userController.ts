import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { hashPassword } from '../lib/password';
import { getAccessibleChurchIds } from '../lib/churchScope';
import { cancelUserAccount } from '../lib/userCancellation';
import { optionalPhoneSchema, phoneSchema } from '../lib/inputValidation';

const USER_INCLUDE = {
  role: true,
  church: true,
} as const;

const ASSIGNABLE_SYSTEM_ROLES = ['member'];

function safeUser(user: any) {
  const { password: _pw, ...rest } = user;
  // Parse JSON scope fields for frontend
  return {
    ...rest,
    roleName: rest.role?.name || rest.roleName,
    districts: rest.districts ? JSON.parse(rest.districts) : undefined,
    traditionalAuthorities: rest.traditionalAuthorities ? JSON.parse(rest.traditionalAuthorities) : undefined,
    regions: rest.regions ? JSON.parse(rest.regions) : undefined,
  };
}

function parseScopeList(value?: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function getRoleScopeLabel(scope: any): string | null {
  if (!scope) return null;
  if (scope.scopeType === 'all_ministry') return 'All ministry churches';
  if (scope.scopeType === 'own_church') return 'Own church only';
  if (scope.scopeType === 'regions') {
    const values = parseScopeList(scope.regions);
    return values.length ? `Regions: ${values.join(', ')}` : 'Regions';
  }
  if (scope.scopeType === 'districts') {
    const values = parseScopeList(scope.districts);
    return values.length ? `Districts: ${values.join(', ')}` : 'Districts';
  }
  if (scope.scopeType === 'traditional_authorities') {
    const values = parseScopeList(scope.traditionalAuthorities);
    return values.length ? `TAs: ${values.join(', ')}` : 'Traditional authorities';
  }
  return null;
}

function addRoleScopeContainsFilter(filters: any[], scopeType: string, field: string, value?: string | null) {
  if (!value) return;
  filters.push({ scopeType, [field]: { contains: value } });
}

async function resolveCallerMinistryAdminId(userId: string, role: string): Promise<string | null> {
  if (role === 'ministry_admin') return userId;

  const caller = await prisma.user.findUnique({
    where: { id: userId },
    select: { ministryAdminId: true },
  });

  return caller?.ministryAdminId ?? null;
}

async function resolveAssignableRole(roleName: string, userId: string, role: string) {
  if (roleName === 'ministry_admin') {
    return {
      errorStatus: 403,
      errorMessage: 'National admin role can only be assigned during initial signup. Please contact support.',
    } as const;
  }

  if (role !== 'ministry_admin' && roleName !== 'member') {
    return {
      errorStatus: 403,
      errorMessage: 'Only national administrators can assign administrative roles. You can only assign member role.',
    } as const;
  }

  const ministryAdminId = await resolveCallerMinistryAdminId(userId, role);
  const roleRecord = await prisma.role.findFirst({
    where: {
      name: roleName,
      OR: [
        { name: { in: ASSIGNABLE_SYSTEM_ROLES } },
        ...(ministryAdminId ? [{ ministryAdminId, isSystemRole: false }] : []),
      ],
    },
  });

  if (!roleRecord) {
    return {
      errorStatus: 404,
      errorMessage: `Role '${roleName}' not found or cannot be assigned`,
    } as const;
  }

  return { roleRecord, ministryAdminId } as const;
}

function roleNeedsMinistryAdminId(roleRecord: { name: string; ministryAdminId?: string | null; isSystemRole?: boolean | null }) {
  return !!roleRecord.ministryAdminId && roleRecord.isSystemRole === false;
}

// ─── GET /api/users ────────────────────────────────────────────────────────────

export async function getUsers(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const role   = req.user?.role ?? 'member';

  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  // Pagination
  const page  = Math.max(1, parseInt(req.query.page  as string) || 1);
  const isExport = req.query.export === 'true';
  const limit = isExport
    ? Math.min(parseInt(req.query.limit as string) || 10000, 10000)
    : Math.min(parseInt(req.query.limit as string) || 100, 500);
  const skip  = (page - 1) * limit;

  // Query filters from request
  const search        = (req.query.search   as string)?.trim() || '';
  const filterChurchId = req.query.churchId as string | undefined;
  const filterRole    = req.query.role      as string | undefined;
  const filterRoleId  = req.query.roleId    as string | undefined;
  const filterCellId  = req.query.cellId    as string | undefined;
  const requestedStatus = (req.query.status as string | undefined)?.trim();
  const filterStatus = requestedStatus && ['active', 'inactive', 'cancelled', 'all'].includes(requestedStatus)
    ? requestedStatus
    : 'active';
  const filterTeamId  = req.query.teamId    as string | undefined;
  const minAge        = req.query.minAge ? parseInt(req.query.minAge as string) : undefined;
  const maxAge        = req.query.maxAge ? parseInt(req.query.maxAge as string) : undefined;
  const emptyUsersSummary = () => ({ total: 0, gender: { male: 0, female: 0, other: 0, unknown: 0 } });
  const buildUsersSummary = (total: number, genderCounts: Array<{ gender: string | null; _count: { _all: number } }>) => {
    const summary = emptyUsersSummary();
    summary.total = total;
    for (const row of genderCounts) {
      const count = row._count._all;
      if (row.gender === 'male') summary.gender.male = count;
      else if (row.gender === 'female') summary.gender.female = count;
      else if (row.gender === 'other') summary.gender.other = count;
      else summary.gender.unknown += count;
    }
    return summary;
  };

  // ── Scope: get all church IDs this user is allowed to see ──────────────────
  // getAccessibleChurchIds already handles all role variants correctly and
  // always scopes to the same ministry — no cross-ministry leakage.
  const accessibleChurchIds = await getAccessibleChurchIds(
    role,
    req.user?.churchId,
    req.user?.districts,
    req.user?.traditionalAuthorities,
    req.user?.regions,
    userId,
  );

  // Members only see their own church
  if (role === 'member') {
    if (!req.user?.churchId) {
      res.status(400).json({ success: false, message: 'churchId required' });
      return;
    }
  }

  // If no accessible churches found (e.g. admin with no churches yet), return empty
  if (accessibleChurchIds.length === 0 && role !== 'ministry_admin') {
    res.json({ success: true, data: [], pagination: { page, limit, total: 0, totalPages: 0 }, summary: emptyUsersSummary() });
    return;
  }

  // ── filterChurchId: only allow if it's within the accessible scope ──────────
  // Never let a caller bypass scope by passing an arbitrary churchId.
  let scopedChurchIds = accessibleChurchIds;
  if (filterChurchId) {
    if (!accessibleChurchIds.includes(filterChurchId)) {
      // Requested church is outside this user's scope — return empty, not 403
      // (avoids leaking whether the church exists)
      res.json({ success: true, data: [], pagination: { page, limit, total: 0, totalPages: 0 }, summary: emptyUsersSummary() });
      return;
    }
    scopedChurchIds = [filterChurchId];
  }

  // ── Build where clause ──────────────────────────────────────────────────────
  // For ministry_admin: also include users whose ministryAdminId = userId
  // (sub-admins who don't have a churchId yet)
  let whereClause: any;

  if (role === 'ministry_admin') {
    if (filterChurchId) {
      const selectedChurch = await prisma.church.findFirst({
        where: { id: filterChurchId, ministryAdminId: userId, status: 'active' },
        select: { region: true, district: true, traditionalAuthority: true },
      });

      const roleScopeFilters: any[] = [{ scopeType: 'all_ministry' }];
      addRoleScopeContainsFilter(roleScopeFilters, 'specific_churches', 'churchIds', filterChurchId);
      addRoleScopeContainsFilter(roleScopeFilters, 'regions', 'regions', selectedChurch?.region);
      addRoleScopeContainsFilter(roleScopeFilters, 'districts', 'districts', selectedChurch?.district);
      addRoleScopeContainsFilter(roleScopeFilters, 'traditional_authorities', 'traditionalAuthorities', selectedChurch?.traditionalAuthority);

      whereClause = {
        OR: [
          { churchId: filterChurchId },
          {
            ministryAdminId: userId,
            role: {
              scope: {
                ministryAdminId: userId,
                OR: roleScopeFilters,
              },
            },
          },
        ],
      };
    } else {
      whereClause = {
        OR: [
          { churchId: { in: scopedChurchIds } },
          { ministryAdminId: userId },
        ],
      };
    }
  } else {
    whereClause = { churchId: { in: scopedChurchIds } };
  }

  // ── Additional filters — applied with AND so they never widen scope ─────────
  const andConditions: any[] = [];

  if (filterRoleId) {
    andConditions.push({ roleId: filterRoleId });
  } else if (filterRole) {
    andConditions.push({ role: { name: filterRole } });
  }

  if (filterCellId === 'none') {
    andConditions.push({ cellMemberships: { none: { status: { not: 'inactive' } } } });
  } else if (filterCellId) {
    andConditions.push({ cellMemberships: { some: { cellId: filterCellId, status: { not: 'inactive' } } } });
  }

  if (filterStatus !== 'all') andConditions.push({ status: filterStatus });
  if (filterTeamId) andConditions.push({ teams: { some: { teamId: filterTeamId } } });

  // Search: scoped with AND so it narrows within the ministry, never widens
  if (search) {
    andConditions.push({
      OR: [
        { firstName: { contains: search } },
        { lastName:  { contains: search } },
        { email:     { contains: search } },
      ],
    });
  }

  // Age filters
  if (minAge !== undefined || maxAge !== undefined) {
    const today = new Date();
    if (minAge !== undefined) {
      andConditions.push({
        dateOfBirth: { lte: new Date(today.getFullYear() - minAge, today.getMonth(), today.getDate()) },
      });
    }
    if (maxAge !== undefined) {
      andConditions.push({
        dateOfBirth: { gte: new Date(today.getFullYear() - maxAge - 1, today.getMonth(), today.getDate() + 1) },
      });
    }
  }

  if (andConditions.length > 0) {
    whereClause.AND = andConditions;
  }

  // ── Query ───────────────────────────────────────────────────────────────────
  const [users, total, genderCounts] = await Promise.all([
    prisma.user.findMany({
      where: whereClause,
      include: {
        role: { select: { id: true, name: true, displayName: true, createdAt: true, scope: true } },
        church: { select: { name: true } },
        teams: { include: { team: { select: { name: true } } } },
        childProfile: {
          include: {
            user: { select: { id: true, memberType: true, loginEnabled: true } },
            church: { select: { id: true, name: true } },
            guardians: {
              include: {
                guardian: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, churchId: true } },
              },
              orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
            },
          },
        },
        cellMemberships: {
          where: { status: { not: 'inactive' } },
          select: { cell: { select: { id: true, name: true } } },
          take: 3,
        },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.user.count({ where: whereClause }),
    prisma.user.groupBy({
      by: ['gender'],
      where: whereClause,
      _count: { _all: true },
    }),
  ]);

  const roleScopeChurchIds = new Set<string>();
  for (const user of users) {
    const scope = (user as any).role?.scope;
    if (scope?.scopeType === 'specific_churches') {
      parseScopeList(scope.churchIds).forEach(id => roleScopeChurchIds.add(id));
    }
  }

  const scopedChurches = roleScopeChurchIds.size > 0
    ? await prisma.church.findMany({
        where: { id: { in: Array.from(roleScopeChurchIds) }, status: 'active' },
        select: { id: true, name: true },
      })
    : [];
  const scopedChurchNameMap = new Map(scopedChurches.map(church => [church.id, church.name]));

  res.json({
    success: true,
    data: users.map(u => {
      const scope = (u as any).role?.scope;
      const scopeChurches = scope?.scopeType === 'specific_churches'
        ? parseScopeList(scope.churchIds)
            .map(id => {
              const name = scopedChurchNameMap.get(id);
              return name ? { id, name } : null;
            })
            .filter((church): church is { id: string; name: string } => Boolean(church))
        : [];

      return {
        ...safeUser(u),
        teams: u.teams.map(t => t.team.name),
        cells: (u as any).cellMemberships?.map((cm: any) => cm.cell) ?? [],
        scopeChurches,
        scopeLabel: getRoleScopeLabel(scope),
        gender:                    u.gender,
        dateOfBirth:               u.dateOfBirth,
        maritalStatus:             u.maritalStatus,
        weddingDate:               u.weddingDate,
        anniversary:               u.anniversary,
        residentialNeighbourhood:  u.residentialNeighbourhood,
        serviceInterest:           u.serviceInterest,
        membershipType:            u.membershipType,
        baptizedByImmersion:       u.baptizedByImmersion,
      };
    }),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    summary: buildUsersSummary(total, genderCounts),
  });
}

// ─── POST /api/users — create a user in the same church ───────────────────────

const createUserSchema = z.object({
  email: z.string().email('Invalid email'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  firstName: z.string().min(1, 'First name required'),
  lastName: z.string().min(1, 'Last name required'),
  phone: phoneSchema,
  gender: z.enum(['male', 'female']).optional(),
  dateOfBirth: z.string().optional(),
  maritalStatus: z.enum(['single', 'married', 'widowed', 'divorced']).optional(),
  weddingDate: z.string().optional(),
  residentialNeighbourhood: z.string().optional(),
  membershipType: z.enum(['member', 'pastor', 'deacon', 'other']).optional(),
  serviceInterest: z.string().optional(),
  baptizedByImmersion: z.boolean().optional(),
  roleName: z.string().default('member'),
  districts: z.array(z.string()).optional(),
  traditionalAuthorities: z.array(z.string()).optional(),
  regions: z.array(z.string()).optional(),
  churchId: z.string().optional(),
  region: z.string().optional(),
  district: z.string().optional(),
  traditionalAuthority: z.string().optional(),
  village: z.string().optional(),
}).refine((data) => {
  if (data.roleName === 'member') {
    if (!data.churchId) return false;
    if (!data.phone) return false;
    if (!data.dateOfBirth) return false;
    if (!data.maritalStatus) return false;
  }
  return true;
}, {
  message: 'Church, Phone, Date of Birth, and Marital Status are required for members',
  path: ['churchId'],
});

export async function createUser(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const role = req.user?.role ?? 'member';
  const permissions = req.user?.permissions ?? [];
  
  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  // Check if user has permission to create users
  if (!permissions.includes('users:create')) {
    res.status(403).json({ success: false, message: 'Permission denied: users:create required' });
    return;
  }

  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const { email, password, firstName, lastName, phone, gender, dateOfBirth, maritalStatus, weddingDate, residentialNeighbourhood, membershipType, serviceInterest, baptizedByImmersion, roleName, districts, traditionalAuthorities, regions, churchId } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    res.status(409).json({ success: false, message: 'Email already in use' });
    return;
  }

  const roleResolution = await resolveAssignableRole(roleName, userId, role);
  if ('errorMessage' in roleResolution) {
    res.status(roleResolution.errorStatus ?? 400).json({ success: false, message: roleResolution.errorMessage });
    return;
  }
  const { roleRecord, ministryAdminId } = roleResolution;

  // Custom/admin roles use RoleScope for access. Only normal members need a
  // direct churchId on their user row.
  let assignedChurchId: string | null = null;

  if (roleName === 'member') {
    if (!churchId) {
      res.status(400).json({ success: false, message: 'Church is required for members' });
      return;
    }
    const accessibleChurchIds = await getAccessibleChurchIds(
      role,
      req.user?.churchId,
      req.user?.districts,
      req.user?.traditionalAuthorities,
      req.user?.regions,
      userId,
    );
    if (!accessibleChurchIds.includes(churchId)) {
      res.status(403).json({ success: false, message: 'You can only create users in churches within your scope' });
      return;
    }
    assignedChurchId = churchId;
  }

  const hashed = await hashPassword(password);
  
  // Check max_members limit when creating a member
  if (roleName === 'member' && assignedChurchId) {
    const { checkMemberLimit } = await import('../lib/packageChecker');
    const adminId = role === 'ministry_admin' ? userId : (await prisma.user.findUnique({ where: { id: userId }, select: { ministryAdminId: true } }))?.ministryAdminId;
    if (adminId) {
      const limitCheck = await checkMemberLimit(adminId, assignedChurchId);
      if (!limitCheck.allowed) {
        res.status(403).json({ success: false, message: limitCheck.message || 'Member limit reached. Please upgrade your package.' });
        return;
      }
    }
  }

  // Determine ministryAdminId for the new user
  let ministryAdminIdForNewUser: string | undefined;
  if (roleName === 'member') {
    ministryAdminIdForNewUser = ministryAdminId ?? undefined;
  } else if (roleNeedsMinistryAdminId(roleRecord)) {
    ministryAdminIdForNewUser = ministryAdminId ?? undefined;
  }
  
  const user = await prisma.user.create({
    data: {
      email,
      password: hashed,
      firstName,
      lastName,
      phone,
      gender,
      dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : undefined,
      maritalStatus,
      weddingDate: weddingDate ? new Date(weddingDate) : undefined,
      residentialNeighbourhood,
      membershipType,
      serviceInterest,
      baptizedByImmersion,
      roleId: roleRecord.id,
      churchId: assignedChurchId,
      ministryAdminId: ministryAdminIdForNewUser,
      districts: districts ? JSON.stringify(districts) : undefined,
      traditionalAuthorities: traditionalAuthorities ? JSON.stringify(traditionalAuthorities) : undefined,
      regions: regions ? JSON.stringify(regions) : undefined,
    },
    include: USER_INCLUDE,
  });

  const { queueEmail } = await import('../lib/emailQueue');
  const { userCreatedTemplate } = await import('../lib/emailTemplates');
  
  queueEmail(
    user.email,
    'Your Account Has Been Created',
    userCreatedTemplate({
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      password,
      churchName: user.church?.name,
      roleName: user.role?.displayName || roleName,
    }),
    'user_created'
  ).catch(err => console.error('Failed to queue user creation email:', err));

  res.status(201).json({ success: true, data: safeUser(user) });
}

// ─── PUT /api/users/:id — update user details ─────────────────────────────────

const updateUserSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  phone: optionalPhoneSchema,
  email: z.string().email().optional(),
  password: z.string().min(8).optional(),
  roleName: z.string().optional(),
  districts: z.array(z.string()).optional(),
  traditionalAuthorities: z.array(z.string()).optional(),
  regions: z.array(z.string()).optional(),
  churchId: z.string().nullable().optional(),
  membershipType: z.enum(['member', 'pastor', 'deacon', 'other']).nullable().optional(),
  gender: z.enum(['male', 'female']).optional(),
  dateOfBirth: z.string().optional(),
  maritalStatus: z.enum(['single', 'married', 'widowed', 'divorced']).optional(),
  weddingDate: z.string().optional(),
  residentialNeighbourhood: z.string().optional(),
  serviceInterest: z.string().optional(),
  baptizedByImmersion: z.boolean().optional(),
  status: z.enum(['active', 'inactive', 'cancelled']).optional(),
});

export async function updateUser(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const role = req.user?.role ?? 'member';
  const permissions = req.user?.permissions ?? [];
  
  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  // Check if user has permission to update users
  if (!permissions.includes('users:update')) {
    res.status(403).json({ success: false, message: 'Permission denied: users:update required' });
    return;
  }

  const target = await prisma.user.findUnique({ where: { id: String(req.params.id) } });
  if (!target) {
    res.status(404).json({ success: false, message: 'User not found' });
    return;
  }

  const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const { firstName, lastName, phone, email, password, roleName, districts, traditionalAuthorities, regions, churchId, membershipType, gender, dateOfBirth, maritalStatus, weddingDate, residentialNeighbourhood, serviceInterest, baptizedByImmersion, status } = parsed.data;
  
  const updateData: Record<string, unknown> = {};
  if (firstName) updateData.firstName = firstName;
  if (lastName) updateData.lastName = lastName;
  if (phone !== undefined) updateData.phone = phone;
  if (email) updateData.email = email;
  if (password) updateData.password = await hashPassword(password);
  if (churchId !== undefined) updateData.churchId = churchId;
  if (membershipType !== undefined) updateData.membershipType = membershipType;
  if (gender !== undefined) updateData.gender = gender;
  if (dateOfBirth !== undefined) updateData.dateOfBirth = dateOfBirth ? new Date(dateOfBirth) : null;
  if (maritalStatus !== undefined) updateData.maritalStatus = maritalStatus;
  if (weddingDate !== undefined) updateData.weddingDate = weddingDate ? new Date(weddingDate) : null;
  if (residentialNeighbourhood !== undefined) updateData.residentialNeighbourhood = residentialNeighbourhood;
  if (serviceInterest !== undefined) updateData.serviceInterest = serviceInterest;
  if (baptizedByImmersion !== undefined) updateData.baptizedByImmersion = baptizedByImmersion;
  if (status) updateData.status = status;
  if (districts !== undefined) updateData.districts = JSON.stringify(districts);
  if (traditionalAuthorities !== undefined) updateData.traditionalAuthorities = JSON.stringify(traditionalAuthorities);
  if (regions !== undefined) updateData.regions = JSON.stringify(regions);

  if (churchId) {
    const accessibleChurchIds = await getAccessibleChurchIds(
      role,
      req.user?.churchId,
      req.user?.districts,
      req.user?.traditionalAuthorities,
      req.user?.regions,
      userId,
    );

    if (!accessibleChurchIds.includes(churchId)) {
      res.status(403).json({ success: false, message: 'You can only assign users to churches within your scope' });
      return;
    }
  }

  if (roleName) {
    const roleResolution = await resolveAssignableRole(roleName, userId, role);
    if ('errorMessage' in roleResolution) {
      res.status(roleResolution.errorStatus ?? 400).json({ success: false, message: roleResolution.errorMessage });
      return;
    }
    const { roleRecord, ministryAdminId } = roleResolution;
    updateData.roleId = roleRecord.id;

    if (roleNeedsMinistryAdminId(roleRecord)) {
      updateData.ministryAdminId = ministryAdminId;
      updateData.churchId = null;
      updateData.membershipType = null;
    } else if (roleName === 'member') {
      updateData.ministryAdminId = ministryAdminId;
    }

    // Clear scope fields when role changes (let caller re-supply if needed)
    if (!districts) updateData.districts = null;
    if (!traditionalAuthorities) updateData.traditionalAuthorities = null;
    if (!regions) updateData.regions = null;
  }

  const updated = status === 'cancelled'
    ? await prisma.$transaction(async (tx) => {
        const cancelled = await cancelUserAccount(tx, String(req.params.id));
        if (!cancelled) throw new Error('User not found');
        return tx.user.update({
          where: { id: String(req.params.id) },
          data: {
            ...updateData,
            email: cancelled.email,
            status: 'cancelled',
            loginEnabled: false,
          },
          include: USER_INCLUDE,
        });
      })
    : await prisma.user.update({
        where: { id: String(req.params.id) },
        data: updateData,
        include: USER_INCLUDE,
      });
  res.json({ success: true, data: safeUser(updated) });
}

// ─── DELETE /api/users/:id ────────────────────────────────────────────────────

export async function deleteUser(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const permissions = req.user?.permissions ?? [];
  
  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  // Check if user has permission to delete users
  if (!permissions.includes('users:delete')) {
    res.status(403).json({ success: false, message: 'Permission denied: users:delete required' });
    return;
  }

  const target = await prisma.user.findUnique({ where: { id: String(req.params.id) } });
  if (!target) {
    res.status(404).json({ success: false, message: 'User not found' });
    return;
  }
  
  if (target.id === userId) {
    res.status(400).json({ success: false, message: 'Cannot delete your own account' });
    return;
  }

  await prisma.$transaction(async (tx) => {
    await cancelUserAccount(tx, target.id);
  });

  res.json({ success: true, message: 'User cancelled' });
}

// ─── POST /api/users/bulk — bulk create users ────────────────────────────────

export async function bulkCreateUsers(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const role = req.user?.role ?? 'member';
  const permissions = req.user?.permissions ?? [];
  
  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  if (!permissions.includes('users:create')) {
    res.status(403).json({ success: false, message: 'Permission denied: users:create required' });
    return;
  }

  const { users } = req.body;
  if (!Array.isArray(users) || users.length === 0) {
    res.status(400).json({ success: false, message: 'Users array required' });
    return;
  }

  const results = { success: 0, failed: 0, errors: [] as any[] };

  for (const userData of users) {
    try {
      // Pre-fill password if missing — will be auto-generated after parsing
      const dataWithPassword = {
        ...userData,
        password: userData.password && userData.password.length >= 8
          ? userData.password
          : `${(userData.firstName || 'User').charAt(0).toUpperCase()}${userData.lastName || 'User'}@${new Date().getFullYear()}!`,
      };
      const parsed = createUserSchema.safeParse(dataWithPassword);
      if (!parsed.success) {
        results.failed++;
        results.errors.push({ email: userData.email, error: parsed.error.errors[0].message });
        continue;
      }

      const { email, password: rawPassword, firstName, lastName, phone, gender, dateOfBirth, maritalStatus, weddingDate, residentialNeighbourhood, membershipType, serviceInterest, baptizedByImmersion, roleName, churchId } = parsed.data;

      // Auto-generate password if not provided (bulk import without password column)
      const password = rawPassword && rawPassword.length >= 8
        ? rawPassword
        : `${firstName.charAt(0).toUpperCase()}${lastName}@${new Date().getFullYear()}!`;

      // Check if user exists
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        results.failed++;
        results.errors.push({ email, error: 'Email already exists' });
        continue;
      }

      const roleResolution = await resolveAssignableRole(roleName, userId, role);
      if ('errorMessage' in roleResolution) {
        results.failed++;
        results.errors.push({ email, error: roleResolution.errorMessage });
        continue;
      }
      const { roleRecord, ministryAdminId } = roleResolution;

      const hashed = await hashPassword(password);
      
      // Determine ministryAdminId
      let ministryAdminIdForNewUser: string | undefined;
      if (roleName === 'member') {
        ministryAdminIdForNewUser = ministryAdminId ?? undefined;
      } else if (roleNeedsMinistryAdminId(roleRecord)) {
        ministryAdminIdForNewUser = ministryAdminId ?? undefined;
      }

      await prisma.user.create({
        data: {
          email,
          password: hashed,
          firstName,
          lastName,
          phone,
          gender,
          dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : undefined,
          maritalStatus,
          weddingDate: weddingDate ? new Date(weddingDate) : undefined,
          residentialNeighbourhood,
          membershipType,
          serviceInterest,
          baptizedByImmersion,
          roleId: roleRecord.id,
          churchId: churchId || null,
          ministryAdminId: ministryAdminIdForNewUser,
        },
      });

      results.success++;
    } catch (error: any) {
      results.failed++;
      results.errors.push({ email: userData.email, error: error.message });
    }
  }

  res.json(results);
}
