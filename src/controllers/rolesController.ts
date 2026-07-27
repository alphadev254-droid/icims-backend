import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { getAccessibleChurchIds } from '../lib/churchScope';

const GLOBAL_ROLES = ['ministry_admin', 'member', 'system_admin'];
const LOCKED_ROLES = ['system_admin'];
const SYSTEM_PERMISSION_PREFIXES = ['packages:', 'system_payments:', 'payments:'];
const SYSTEM_PERMISSION_NAMES = ['roles:manage', 'roles:assign', 'packages:view', 'packages:manage'];

const scopeSchema = z.object({
  scopeType: z.enum(['all_ministry', 'specific_churches', 'regions', 'districts', 'traditional_authorities', 'own_church']),
  churchIds: z.array(z.string()).optional().default([]),
  regions: z.array(z.string()).optional().default([]),
  districts: z.array(z.string()).optional().default([]),
  traditionalAuthorities: z.array(z.string()).optional().default([]),
});

const createRoleSchema = z.object({
  displayName: z.string().min(2).max(100),
  description: z.string().max(191).optional().nullable(),
  permissions: z.array(z.string()).default([]),
  scope: scopeSchema.optional(),
});

const updateRoleSchema = createRoleSchema.partial();
const updatePermsSchema = z.object({ permissions: z.array(z.string()) });

const assignRoleSchema = z.object({
  userId: z.string(),
  roleName: z.string().optional(),
  roleId: z.string().optional(),
});

const roleFiltersSchema = z.object({
  search: z.string().optional(),
  scopeType: z.enum(['all_ministry', 'specific_churches', 'regions', 'districts', 'traditional_authorities', 'own_church']).optional(),
  churchIds: z.string().optional(),
  regions: z.string().optional(),
  districts: z.string().optional(),
  traditionalAuthorities: z.string().optional(),
});

function parseList(value?: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function serializeList(value?: string[]): string | null {
  return value && value.length > 0 ? JSON.stringify(value) : null;
}

function parseQueryList(value?: string): string[] {
  if (!value) return [];
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

function listContainsAny(field: string, values: string[]) {
  return values.map(value => ({ [field]: { contains: `"${value.replace(/"/g, '\\"')}"` } }));
}

function safeSlug(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50) || 'custom_role';
}

function isSystemPermission(name: string): boolean {
  return SYSTEM_PERMISSION_NAMES.includes(name) || SYSTEM_PERMISSION_PREFIXES.some(prefix => name.startsWith(prefix));
}

async function expandWithReadPermissions(permNames: string[]): Promise<string[]> {
  const selected = new Set(permNames.filter(name => !isSystemPermission(name)));
  const readNames = Array.from(selected)
    .map(name => {
      const [resource, action] = name.split(':');
      return resource && action && action !== 'read' ? `${resource}:read` : null;
    })
    .filter(Boolean) as string[];

  if (readNames.length === 0) return Array.from(selected);

  const existingReadPermissions = await prisma.permission.findMany({
    where: { name: { in: readNames } },
    select: { name: true },
  });

  for (const permission of existingReadPermissions) selected.add(permission.name);
  return Array.from(selected);
}

async function resolveMinistryAdminId(req: Request): Promise<string | null> {
  const userId = req.user?.userId;
  if (req.user?.role === 'ministry_admin' && userId) return userId;
  if (!userId) return null;
  const caller = await prisma.user.findUnique({ where: { id: userId }, select: { ministryAdminId: true } });
  return caller?.ministryAdminId ?? null;
}

function formatScope(scope: any) {
  if (!scope) return null;
  return {
    id: scope.id,
    scopeType: scope.scopeType,
    churchIds: parseList(scope.churchIds),
    regions: parseList(scope.regions),
    districts: parseList(scope.districts),
    traditionalAuthorities: parseList(scope.traditionalAuthorities),
  };
}

async function upsertRoleScope(roleId: string, ministryAdminId: string, scope: z.infer<typeof scopeSchema>) {
  await prisma.roleScope.upsert({
    where: { roleId },
    update: {
      ministryAdminId,
      scopeType: scope.scopeType,
      churchIds: serializeList(scope.churchIds),
      regions: serializeList(scope.regions),
      districts: serializeList(scope.districts),
      traditionalAuthorities: serializeList(scope.traditionalAuthorities),
    },
    create: {
      roleId,
      ministryAdminId,
      scopeType: scope.scopeType,
      churchIds: serializeList(scope.churchIds),
      regions: serializeList(scope.regions),
      districts: serializeList(scope.districts),
      traditionalAuthorities: serializeList(scope.traditionalAuthorities),
    },
  });
}

async function replaceRolePermissions(roleId: string, ministryAdminId: string, permNames: string[]) {
  const blockedNames = permNames.filter(isSystemPermission);
  if (blockedNames.length > 0) {
    throw new Error(`These permissions cannot be assigned to custom roles: ${blockedNames.join(', ')}`);
  }

  const allowedNames = await expandWithReadPermissions(permNames);
  const permRecords = await prisma.permission.findMany({ where: { name: { in: allowedNames } } });

  await prisma.rolePermission.deleteMany({ where: { ministryAdminId, roleId } });
  if (permRecords.length === 0) return;

  await prisma.rolePermission.createMany({
    data: permRecords.map(permission => ({ ministryAdminId, roleId, permissionId: permission.id })),
    skipDuplicates: true,
  });
}

async function ensureCustomRoleForMinistry(roleId: string, ministryAdminId: string) {
  return prisma.role.findFirst({ where: { id: roleId, ministryAdminId, isSystemRole: false } });
}

async function countUsersForRoleInMinistry(roleId: string, ministryAdminId: string | null, roleName: string): Promise<number> {
  if (!ministryAdminId) {
    return prisma.user.count({ where: { roleId } });
  }

  return prisma.user.count({
    where: {
      roleId,
      OR: [
        { id: ministryAdminId },
        { ministryAdminId },
        { church: { ministryAdminId } },
      ],
      ...(roleName === 'ministry_admin' ? { id: ministryAdminId } : {}),
    },
  });
}

export async function getRoles(req: Request, res: Response): Promise<void> {
  const ministryAdminId = await resolveMinistryAdminId(req);
  const role = req.user?.role ?? 'member';
  const userId = req.user?.userId;
  const parsedFilters = roleFiltersSchema.safeParse(req.query);
  if (!parsedFilters.success) {
    res.status(400).json({ success: false, message: parsedFilters.error.errors[0].message });
    return;
  }

  const filters = parsedFilters.data;
  const search = filters.search?.trim();
  const scopeOr: any[] = [];
  const churchIds = parseQueryList(filters.churchIds);
  const regions = parseQueryList(filters.regions);
  const districts = parseQueryList(filters.districts);
  const traditionalAuthorities = parseQueryList(filters.traditionalAuthorities);
  let accessibleChurchIds: string[] | null = null;
  if (role !== 'system_admin') {
    accessibleChurchIds = await getAccessibleChurchIds(
      role,
      req.user?.churchId,
      req.user?.districts,
      req.user?.traditionalAuthorities,
      req.user?.regions,
      userId,
    );
  }

  const requestedScopedFilters = churchIds.length > 0 || regions.length > 0 || districts.length > 0 || traditionalAuthorities.length > 0;
  if (requestedScopedFilters && accessibleChurchIds && accessibleChurchIds.length === 0) {
    res.json({ success: true, data: [], total: 0 });
    return;
  }

  const accessibleChurchWhere = accessibleChurchIds
    ? { id: { in: accessibleChurchIds } }
    : {};
  const accessibleChurches = requestedScopedFilters
    ? await prisma.church.findMany({
        where: accessibleChurchWhere,
        select: { id: true, region: true, district: true, traditionalAuthority: true },
      })
    : [];
  const accessibleChurchIdSet = new Set(accessibleChurches.map(church => church.id));
  const accessibleRegions = new Set(accessibleChurches.map(church => church.region).filter(Boolean) as string[]);
  const accessibleDistricts = new Set(accessibleChurches.map(church => church.district).filter(Boolean) as string[]);
  const accessibleTraditionalAuthorities = new Set(accessibleChurches.map(church => church.traditionalAuthority).filter(Boolean) as string[]);
  const scopedChurchIds = accessibleChurchIds ? churchIds.filter(id => accessibleChurchIdSet.has(id)) : churchIds;
  const scopedRegions = accessibleChurchIds ? regions.filter(value => accessibleRegions.has(value)) : regions;
  const scopedDistricts = accessibleChurchIds ? districts.filter(value => accessibleDistricts.has(value)) : districts;
  const scopedTraditionalAuthorities = accessibleChurchIds
    ? traditionalAuthorities.filter(value => accessibleTraditionalAuthorities.has(value))
    : traditionalAuthorities;

  if (
    (churchIds.length > 0 && scopedChurchIds.length === 0) ||
    (regions.length > 0 && scopedRegions.length === 0) ||
    (districts.length > 0 && scopedDistricts.length === 0) ||
    (traditionalAuthorities.length > 0 && scopedTraditionalAuthorities.length === 0)
  ) {
    res.json({ success: true, data: [], total: 0 });
    return;
  }

  if (scopedChurchIds.length > 0) {
    const selectedChurches = await prisma.church.findMany({
      where: { id: { in: scopedChurchIds } },
      select: { region: true, district: true, traditionalAuthority: true },
    });
    const churchRegions = Array.from(new Set(selectedChurches.map(church => church.region).filter(Boolean))) as string[];
    const churchDistricts = Array.from(new Set(selectedChurches.map(church => church.district).filter(Boolean))) as string[];
    const churchTraditionalAuthorities = Array.from(new Set(selectedChurches.map(church => church.traditionalAuthority).filter(Boolean))) as string[];

    scopeOr.push(
      { scopeType: 'all_ministry' },
      { scopeType: 'own_church' },
      ...listContainsAny('churchIds', scopedChurchIds),
      ...listContainsAny('regions', churchRegions),
      ...listContainsAny('districts', churchDistricts),
      ...listContainsAny('traditionalAuthorities', churchTraditionalAuthorities),
    );
  }
  if (scopedRegions.length > 0) {
    scopeOr.push({ scopeType: 'all_ministry' }, ...listContainsAny('regions', scopedRegions));
  }
  if (scopedDistricts.length > 0) {
    scopeOr.push({ scopeType: 'all_ministry' }, ...listContainsAny('districts', scopedDistricts));
  }
  if (scopedTraditionalAuthorities.length > 0) {
    scopeOr.push({ scopeType: 'all_ministry' }, ...listContainsAny('traditionalAuthorities', scopedTraditionalAuthorities));
  }

  const where: any = role === 'system_admin'
    ? { name: { notIn: ['system_admin', 'ministry_admin'] } }
    : {
        name: { notIn: ['system_admin', 'ministry_admin'] },
        OR: [
          { ministryAdminId: null },
          ...(ministryAdminId ? [{ ministryAdminId }] : []),
        ],
      };

  const andFilters: any[] = [];
  if (search) {
    andFilters.push({
      OR: [
        { displayName: { contains: search } },
        { name: { contains: search } },
        { description: { contains: search } },
      ],
    });
  }
  if (filters.scopeType || scopeOr.length > 0) {
    andFilters.push({
      scope: {
        is: {
          ...(filters.scopeType ? { scopeType: filters.scopeType } : {}),
          ...(scopeOr.length > 0 ? { OR: scopeOr } : {}),
        },
      },
    });
  }
  if (andFilters.length > 0) {
    where.AND = andFilters;
  }

  const roles = await prisma.role.findMany({
    where,
    include: { scope: true },
    orderBy: [{ isSystemRole: 'desc' }, { displayName: 'asc' }],
  });

  const data = await Promise.all(roles.map(async (r) => {
    const isGlobalRole = GLOBAL_ROLES.includes(r.name);
    const isLocked = LOCKED_ROLES.includes(r.name);
    const permissionScope = isGlobalRole || !ministryAdminId ? 'GLOBAL' : ministryAdminId;

    const perms = await prisma.rolePermission.findMany({
      where: { ministryAdminId: permissionScope, roleId: r.id },
      include: { permission: true },
    });
    const userCount = await countUsersForRoleInMinistry(r.id, ministryAdminId, r.name);

    return {
      id: r.id,
      name: r.name,
      displayName: r.displayName,
      description: r.description,
      userCount,
      permissions: perms.map(rp => rp.permission),
      scope: formatScope((r as any).scope),
      createdAt: r.createdAt,
      isEditable: !isLocked && (!isGlobalRole || !r.isSystemRole),
      isGlobal: isGlobalRole,
      isSystemRole: r.isSystemRole,
      ministryAdminId: r.ministryAdminId,
    };
  }));

  res.json({ success: true, data, total: data.length });
}

export async function getAllPermissions(_req: Request, res: Response): Promise<void> {
  const permissions = await prisma.permission.findMany({ orderBy: [{ resource: 'asc' }, { action: 'asc' }] });
  res.json({ success: true, data: permissions });
}

export async function createRole(req: Request, res: Response): Promise<void> {
  if (!req.user?.permissions?.includes('roles:manage')) {
    res.status(403).json({ success: false, message: 'Permission denied: roles:manage required' });
    return;
  }
  if (req.user?.role !== 'ministry_admin') {
    res.status(403).json({ success: false, message: 'Only ministry admins can create custom roles' });
    return;
  }

  const ministryAdminId = await resolveMinistryAdminId(req);
  if (!ministryAdminId) { res.status(400).json({ success: false, message: 'Cannot determine ministry scope.' }); return; }

  const parsed = createRoleSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const role = await prisma.role.create({
    data: {
      name: `custom_${ministryAdminId}_${safeSlug(parsed.data.displayName)}_${Date.now()}`,
      displayName: parsed.data.displayName,
      description: parsed.data.description ?? null,
      ministryAdminId,
      isSystemRole: false,
    },
  });

  try {
    await replaceRolePermissions(role.id, ministryAdminId, parsed.data.permissions);
    await upsertRoleScope(role.id, ministryAdminId, parsed.data.scope ?? { scopeType: 'specific_churches', churchIds: [], regions: [], districts: [], traditionalAuthorities: [] });
  } catch (error: any) {
    await prisma.role.delete({ where: { id: role.id } });
    res.status(400).json({ success: false, message: error.message || 'Invalid role permissions' });
    return;
  }

  res.status(201).json({ success: true, data: role });
}

export async function updateRole(req: Request, res: Response): Promise<void> {
  if (!req.user?.permissions?.includes('roles:manage')) {
    res.status(403).json({ success: false, message: 'Permission denied: roles:manage required' });
    return;
  }
  if (req.user?.role !== 'ministry_admin') {
    res.status(403).json({ success: false, message: 'Only ministry admins can update custom roles' });
    return;
  }

  const ministryAdminId = await resolveMinistryAdminId(req);
  if (!ministryAdminId) { res.status(400).json({ success: false, message: 'Cannot determine ministry scope.' }); return; }

  const roleId = String(req.params.id);
  const roleRecord = await ensureCustomRoleForMinistry(roleId, ministryAdminId);
  if (!roleRecord) { res.status(404).json({ success: false, message: 'Custom role not found' }); return; }

  const parsed = updateRoleSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const updated = await prisma.role.update({
    where: { id: roleId },
    data: {
      displayName: parsed.data.displayName,
      description: parsed.data.description === undefined ? undefined : parsed.data.description ?? null,
    },
  });

  try {
    if (parsed.data.permissions) await replaceRolePermissions(roleId, ministryAdminId, parsed.data.permissions);
    if (parsed.data.scope) await upsertRoleScope(roleId, ministryAdminId, parsed.data.scope);
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message || 'Invalid role permissions' });
    return;
  }

  res.json({ success: true, data: updated });
}

export async function deleteRole(req: Request, res: Response): Promise<void> {
  if (!req.user?.permissions?.includes('roles:manage')) {
    res.status(403).json({ success: false, message: 'Permission denied: roles:manage required' });
    return;
  }
  if (req.user?.role !== 'ministry_admin') {
    res.status(403).json({ success: false, message: 'Only ministry admins can delete custom roles' });
    return;
  }

  const ministryAdminId = await resolveMinistryAdminId(req);
  if (!ministryAdminId) { res.status(400).json({ success: false, message: 'Cannot determine ministry scope.' }); return; }

  const roleId = String(req.params.id);
  const roleRecord = await prisma.role.findFirst({
    where: { id: roleId, ministryAdminId, isSystemRole: false },
    include: { _count: { select: { users: true } } },
  });
  if (!roleRecord) { res.status(404).json({ success: false, message: 'Custom role not found' }); return; }
  if (roleRecord._count.users > 0) {
    res.status(400).json({ success: false, message: 'Move users off this role before deleting it.' });
    return;
  }

  await prisma.role.delete({ where: { id: roleId } });
  res.json({ success: true, message: 'Role deleted' });
}

export async function updateRolePermissions(req: Request, res: Response): Promise<void> {
  if (!req.user?.permissions?.includes('roles:manage')) {
    res.status(403).json({ success: false, message: 'Permission denied: roles:manage required' });
    return;
  }

  const parsed = updatePermsSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const roleId = String(req.params.id);
  const roleRecord = await prisma.role.findUnique({ where: { id: roleId } });
  if (!roleRecord) { res.status(404).json({ success: false, message: 'Role not found' }); return; }

  if (LOCKED_ROLES.includes(roleRecord.name)) {
    res.status(403).json({ success: false, message: `The ${roleRecord.displayName} role cannot be modified.` });
    return;
  }
  if (GLOBAL_ROLES.includes(roleRecord.name)) {
    res.status(403).json({ success: false, message: `The ${roleRecord.displayName} role is global and cannot be customised per ministry.` });
    return;
  }

  const ministryAdminId = await resolveMinistryAdminId(req);
  if (!ministryAdminId) { res.status(400).json({ success: false, message: 'Cannot determine ministry scope.' }); return; }

  if (roleRecord.ministryAdminId && roleRecord.ministryAdminId !== ministryAdminId) {
    res.status(403).json({ success: false, message: 'Access denied to this role.' });
    return;
  }

  try {
    await replaceRolePermissions(roleId, ministryAdminId, parsed.data.permissions);
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message || 'Invalid role permissions' });
    return;
  }
  res.json({ success: true, message: 'Permissions updated' });
}

export async function assignRole(req: Request, res: Response): Promise<void> {
  const parsed = assignRoleSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const { userId, roleName, roleId } = parsed.data;
  const currentUserId = req.user?.userId;
  if (!currentUserId) { res.status(401).json({ success: false, message: 'Not authenticated' }); return; }
  if (req.user?.role !== 'ministry_admin') {
    res.status(403).json({ success: false, message: 'Only ministry administrators can assign roles' });
    return;
  }

  const ministryAdminId = await resolveMinistryAdminId(req);
  if (!ministryAdminId) { res.status(400).json({ success: false, message: 'Cannot determine ministry scope.' }); return; }

  const targetUser = await prisma.user.findFirst({
    where: {
      id: userId,
      OR: [
        { ministryAdminId },
        { id: ministryAdminId },
      ],
    },
  });
  if (!targetUser) { res.status(404).json({ success: false, message: 'User not found' }); return; }

  const role = roleId
    ? await prisma.role.findFirst({
        where: {
          id: roleId,
          OR: [{ ministryAdminId: null }, { ministryAdminId }],
        },
      })
    : roleName
    ? await prisma.role.findFirst({
        where: {
          name: roleName,
          OR: [{ ministryAdminId: null }, { ministryAdminId }],
        },
      })
    : null;
  if (!role) { res.status(404).json({ success: false, message: 'Role not found' }); return; }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { roleId: role.id, ministryAdminId },
    select: { id: true, email: true, firstName: true, lastName: true, role: { select: { name: true, displayName: true } } },
  });

  res.json({
    success: true,
    message: `Role '${role.displayName}' assigned to ${updated.firstName} ${updated.lastName}`,
    data: { ...updated, roleName: updated.role?.name || null },
  });
}
