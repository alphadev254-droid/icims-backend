import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { hashPassword, comparePassword } from '../lib/password';
import { signToken } from '../lib/jwt';
import type { UserRole } from '../types';

const isProd = process.env.NODE_ENV === 'production';

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: isProd,
  sameSite: isProd ? 'none' as const : 'lax' as const,
  maxAge: 7 * 24 * 60 * 60 * 1000,
};
const USER_INCLUDE = {
  church: true,
  package: true,
  role: true,
  rolePermissions: {
    include: {
      permission: true,
    },
  },
} as const;

function extractPermissions(user: { rolePermissions: { permission: { name: string } }[] }): string[] {
  return user.rolePermissions.map(rp => rp.permission.name);
}

function parseJson(val: string | null | undefined): string[] | undefined {
  if (!val) return undefined;
  try { return JSON.parse(val) as string[]; } catch { return undefined; }
}

function safeUser(user: any): any {
  const { password: _pw, rolePermissions: _rp, ...rest } = user;
  return {
    ...rest,
    roleName: user.role?.name || null,
    permissions: extractPermissions(user),
    districts: parseJson(user.districts),
    traditionalAuthorities: parseJson(user.traditionalAuthorities),
  };
}

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
});

export async function login(req: Request, res: Response): Promise<void> {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const { email, password } = parsed.data;
  const user = await prisma.user.findUnique({ where: { email }, include: USER_INCLUDE });

  if (!user || !(await comparePassword(password, user.password))) {
    res.status(401).json({ success: false, message: 'Invalid email or password' });
    return;
  }

  const permissions = extractPermissions(user);

  const token = signToken({
    userId: user.id,
    email: user.email,
    role: (user.role?.name || 'member') as UserRole,
    churchId: user.churchId,
    permissions,
    districts: parseJson(user.districts),
    traditionalAuthorities: parseJson(user.traditionalAuthorities),
  });

  res.cookie('icims_token', token, COOKIE_OPTIONS);
  res.json({ success: true, user: safeUser(user) });
}

const registerSchema = z.object({
  firstName: z.string().min(2, 'First name must be at least 2 characters'),
  lastName: z.string().min(2, 'Last name must be at least 2 characters'),
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  phone: z.string().optional(),
});

export async function register(req: Request, res: Response): Promise<void> {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const data = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email: data.email } });
  if (existing) {
    res.status(409).json({ success: false, message: 'An account with this email already exists' });
    return;
  }

  const basicPackage = await prisma.package.findFirst({ where: { name: 'basic' } });
  const nationalAdminRole = await prisma.role.findFirst({ where: { name: 'national_admin' } });
  
  if (!basicPackage || !nationalAdminRole) {
    res.status(500).json({ success: false, message: 'System not properly configured. Please contact support.' });
    return;
  }

  const hashed = await hashPassword(data.password);

  const user = await prisma.user.create({
    data: {
      email: data.email,
      password: hashed,
      firstName: data.firstName,
      lastName: data.lastName,
      roleId: nationalAdminRole.id,
      phone: data.phone,
      packageId: basicPackage.id,
    },
  });

  // Give national admin ALL permissions by creating role-permission links
  const allPermissions = await prisma.permission.findMany();
  for (const permission of allPermissions) {
    await prisma.rolePermission.create({
      data: {
        nationalAdminId: user.id,
        roleId: nationalAdminRole.id,
        permissionId: permission.id,
      },
    });
  }

  // Refetch user with permissions
  const userWithPerms = await prisma.user.findUnique({
    where: { id: user.id },
    include: USER_INCLUDE,
  });

  if (!userWithPerms) {
    res.status(500).json({ success: false, message: 'Failed to create user' });
    return;
  }

  const permissions = extractPermissions(userWithPerms);

  const token = signToken({
    userId: userWithPerms.id,
    email: userWithPerms.email,
    role: (userWithPerms.role?.name || 'member') as UserRole,
    churchId: userWithPerms.churchId,
    permissions,
    districts: parseJson(userWithPerms.districts),
    traditionalAuthorities: parseJson(userWithPerms.traditionalAuthorities),
  });

  res.cookie('icims_token', token, COOKIE_OPTIONS);
  res.status(201).json({ success: true, user: safeUser(userWithPerms) });
}

export function logout(_req: Request, res: Response): void {
  res.clearCookie('icims_token');
  res.json({ success: true, message: 'Signed out successfully' });
}

export async function getMe(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: req.user.userId },
    include: USER_INCLUDE,
  });

  if (!user) {
    res.status(404).json({ success: false, message: 'User not found' });
    return;
  }

  res.json({ success: true, user: safeUser(user) });
}

const profileSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  phone: z.string().optional(),
  currentPassword: z.string().optional(),
  newPassword: z.string().min(8).optional(),
});

export async function updateProfile(req: Request, res: Response): Promise<void> {
  if (!req.user) { res.status(401).json({ success: false, message: 'Not authenticated' }); return; }

  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const { firstName, lastName, phone, currentPassword, newPassword } = parsed.data;

  const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
  if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }

  const updateData: Record<string, unknown> = {};
  if (firstName) updateData.firstName = firstName;
  if (lastName) updateData.lastName = lastName;
  if (phone !== undefined) updateData.phone = phone;

  if (newPassword) {
    if (!currentPassword) { res.status(400).json({ success: false, message: 'Current password required to set new password' }); return; }
    const valid = await comparePassword(currentPassword, user.password);
    if (!valid) { res.status(401).json({ success: false, message: 'Current password is incorrect' }); return; }
    updateData.password = await hashPassword(newPassword);
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: updateData,
    include: USER_INCLUDE,
  });

  res.json({ success: true, user: safeUser(updated) });
}
