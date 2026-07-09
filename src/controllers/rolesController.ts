import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';

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

function safeSlug(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50) || 'custom_role';
}

function isSystemPermission(name: string): boolean {
  return SYSTEM_PERMISSION_NAMES.includes(name) || SYSTEM_PERMISSION_PREFIXES.some(prefix => name.startsWith(prefix));
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
  const allowedNames = permNames.filter(name => !isSystemPermission(name));
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

export async function getRoles(req: Request, res: Response): Promise<void> {
  const ministryAdminId = await resolveMinistryAdminId(req);
  const role = req.user?.role;

  const roles = await prisma.role.findMany({
    where: role === 'system_admin'
      ? {}
      : {
          name: { not: 'system_admin' },
          OR: [
            { ministryAdminId: null },
            ...(ministryAdminId ? [{ ministryAdminId }] : []),
          ],
        },
    include: { _count: { select: { users: true } }, scope: true },
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

    return {
      id: r.id,
      name: r.name,
      displayName: r.displayName,
      description: r.description,
      userCount: r._count.users,
      permissions: perms.map(rp => rp.permission),
      scope: formatScope((r as any).scope),
      createdAt: r.createdAt,
      isEditable: !isLocked && (!isGlobalRole || !r.isSystemRole),
      isGlobal: isGlobalRole,
      isSystemRole: r.isSystemRole,
      ministryAdminId: r.ministryAdminId,
    };
  }));

  res.json({ success: true, data });
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

  await replaceRolePermissions(role.id, ministryAdminId, parsed.data.permissions);
  await upsertRoleScope(role.id, ministryAdminId, parsed.data.scope ?? { scopeType: 'specific_churches', churchIds: [], regions: [], districts: [], traditionalAuthorities: [] });

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

  if (parsed.data.permissions) await replaceRolePermissions(roleId, ministryAdminId, parsed.data.permissions);
  if (parsed.data.scope) await upsertRoleScope(roleId, ministryAdminId, parsed.data.scope);

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

  await replaceRolePermissions(roleId, ministryAdminId, parsed.data.permissions);
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
