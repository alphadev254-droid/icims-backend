import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';

// Roles that are global and not editable by ministry admins
const GLOBAL_ROLES = ['ministry_admin', 'member', 'system_admin'];
// Roles that are completely locked (no one can edit)
const LOCKED_ROLES = ['system_admin'];

// ─── GET /api/roles ────────────────────────────────────────────────────────────

export async function getRoles(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const role = req.user?.role;

  // Resolve the ministryAdminId for the caller
  let ministryAdminId: string | null = null;
  if (role === 'ministry_admin' && userId) {
    ministryAdminId = userId;
  } else if (userId) {
    const caller = await prisma.user.findUnique({
      where: { id: userId },
      select: { ministryAdminId: true },
    });
    ministryAdminId = caller?.ministryAdminId ?? null;
  }

  const roles = await prisma.role.findMany({
    where: role === 'system_admin' ? {} : { name: { not: 'system_admin' } },
    include: { _count: { select: { users: true } } },
    orderBy: { name: 'asc' },
  });

  // For each role, fetch permissions from the correct scope:
  // - member, ministry_admin, system_admin → always GLOBAL
  // - district_admin, branch_admin, regional_admin → ministryAdminId (tenant-specific)
  //   If no tenant rows exist yet, fall back to GLOBAL so the UI shows defaults
  const data = await Promise.all(roles.map(async (r) => {
    const isGlobalRole = GLOBAL_ROLES.includes(r.name);
    const isLocked = LOCKED_ROLES.includes(r.name);

    let perms;
    if (isGlobalRole || !ministryAdminId) {
      // Always use GLOBAL for these roles
      perms = await prisma.rolePermission.findMany({
        where: { ministryAdminId: 'GLOBAL', roleId: r.id },
        include: { permission: true },
      });
    } else {
      // Try tenant-specific first
      const tenantPerms = await prisma.rolePermission.findMany({
        where: { ministryAdminId, roleId: r.id },
        include: { permission: true },
      });
      // If no tenant customisation exists yet, show GLOBAL defaults
      perms = tenantPerms.length > 0
        ? tenantPerms
        : await prisma.rolePermission.findMany({
            where: { ministryAdminId: 'GLOBAL', roleId: r.id },
            include: { permission: true },
          });
    }

    return {
      id: r.id,
      name: r.name,
      displayName: r.displayName,
      userCount: r._count.users,
      permissions: perms.map(rp => rp.permission),
      createdAt: r.createdAt,
      isEditable: !isLocked && !isGlobalRole,  // only sub-admin roles are editable
      isGlobal: isGlobalRole,
    };
  }));

  res.json({ success: true, data });
}

// ─── GET /api/roles/permissions ────────────────────────────────────────────────

export async function getAllPermissions(_req: Request, res: Response): Promise<void> {
  const permissions = await prisma.permission.findMany({ orderBy: [{ resource: 'asc' }, { action: 'asc' }] });
  res.json({ success: true, data: permissions });
}

// ─── PUT /api/roles/:id/permissions ───────────────────────────────────────────

const updatePermsSchema = z.object({
  permissions: z.array(z.string()),
});

export async function updateRolePermissions(req: Request, res: Response): Promise<void> {
  const callerPermissions = req.user?.permissions ?? [];
  const userId = req.user?.userId;
  const role = req.user?.role;

  if (!callerPermissions.includes('roles:manage')) {
    res.status(403).json({ success: false, message: 'Permission denied: roles:manage required' });
    return;
  }

  const parsed = updatePermsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const roleId = String(req.params.id);
  const { permissions: permNames } = parsed.data;

  const roleRecord = await prisma.role.findUnique({ where: { id: roleId } });
  if (!roleRecord) {
    res.status(404).json({ success: false, message: 'Role not found' });
    return;
  }

  // Block editing of global/locked roles
  if (LOCKED_ROLES.includes(roleRecord.name)) {
    res.status(403).json({ success: false, message: `The ${roleRecord.displayName} role cannot be modified.` });
    return;
  }
  if (GLOBAL_ROLES.includes(roleRecord.name)) {
    res.status(403).json({ success: false, message: `The ${roleRecord.displayName} role is global and cannot be customised per ministry.` });
    return;
  }

  // Resolve ministryAdminId — write to tenant scope only
  let ministryAdminId: string | null = null;
  if (role === 'ministry_admin' && userId) {
    ministryAdminId = userId;
  } else if (userId) {
    const caller = await prisma.user.findUnique({
      where: { id: userId },
      select: { ministryAdminId: true },
    });
    ministryAdminId = caller?.ministryAdminId ?? null;
  }

  if (!ministryAdminId) {
    res.status(400).json({ success: false, message: 'Cannot determine ministry scope.' });
    return;
  }

  const permRecords = await prisma.permission.findMany({
    where: { name: { in: permNames } },
  });

  // Replace tenant-specific permissions for this role
  await prisma.rolePermission.deleteMany({ where: { ministryAdminId, roleId } });
  for (const perm of permRecords) {
    await prisma.rolePermission.create({
      data: { ministryAdminId, roleId, permissionId: perm.id },
    });
  }

  res.json({ success: true, message: 'Permissions updated' });
}

// ─── POST /api/roles/assign — assign a role to a user ─────────────────────────

const assignRoleSchema = z.object({
  userId: z.string(),
  roleName: z.string(),
});

export async function assignRole(req: Request, res: Response): Promise<void> {
  const parsed = assignRoleSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const { userId, roleName } = parsed.data;
  const currentUserId = req.user?.userId;
  const currentUserRole = req.user?.role;

  if (!currentUserId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  // Only national admins can assign roles
  if (currentUserRole !== 'ministry_admin') {
    res.status(403).json({ success: false, message: 'Only national administrators can assign roles' });
    return;
  }

  // Find the target user
  const targetUser = await prisma.user.findUnique({ where: { id: userId } });
  if (!targetUser) { res.status(404).json({ success: false, message: 'User not found' }); return; }

  // Find the global role
  const role = await prisma.role.findUnique({
    where: { name: roleName },
  });
  if (!role) { res.status(404).json({ success: false, message: `Role '${roleName}' not found` }); return; }

  // Update the user's role
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { roleId: role.id },
    select: { id: true, email: true, firstName: true, lastName: true, role: { select: { name: true, displayName: true } } },
  });

  res.json({
    success: true,
    message: `Role '${role.displayName}' assigned to ${updated.firstName} ${updated.lastName}`,
    data: {
      ...updated,
      roleName: updated.role?.name || null,
    },
  });
}
