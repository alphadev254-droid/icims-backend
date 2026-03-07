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
  role: {
    select: {
      id: true,
      name: true,
      displayName: true,
    },
  },
  church: {
    select: {
      id: true,
      name: true,
    },
  },
} as const;

async function getUserWithPackage(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: USER_INCLUDE,
  });

  if (!user) return null;

  const roleName = user.role?.name;
  
  // For member: get package from church's National Admin subscription
  if (roleName === 'member' && user.churchId) {
    const church = await prisma.church.findUnique({
      where: { id: user.churchId },
      select: { nationalAdminId: true },
    });
    
    if (church?.nationalAdminId) {
      const subscription = await prisma.subscription.findFirst({
        where: { 
          nationalAdminId: church.nationalAdminId,
          status: 'active',
        },
        include: {
          package: {
            include: {
              features: {
                include: {
                  feature: true,
                },
              },
            },
          },
        },
      });
      
      if (subscription?.package) {
        return { ...user, package: subscription.package };
      }
    }
  }
  
  // For district_overseer, local_admin, regional_leader: get package from their National Admin subscription
  if ((roleName === 'district_overseer' || roleName === 'local_admin' || roleName === 'regional_leader') && user.nationalAdminId) {
    const subscription = await prisma.subscription.findFirst({
      where: { 
        nationalAdminId: user.nationalAdminId,
        status: 'active',
      },
      include: {
        package: {
          include: {
            features: {
              include: {
                feature: true,
              },
            },
          },
        },
      },
    });
    
    if (subscription?.package) {
      return { ...user, package: subscription.package };
    }
  }
  
  // For national_admin: get their own subscription
  if (roleName === 'national_admin') {
    const subscription = await prisma.subscription.findFirst({
      where: { 
        nationalAdminId: userId,
        status: 'active',
      },
      include: {
        package: {
          include: {
            features: {
              include: {
                feature: true,
              },
            },
          },
        },
      },
    });
    
    if (subscription?.package) {
      return { ...user, package: subscription.package };
    }
  }

  // No subscription found - return user with null package
  return { ...user, package: null };
}

async function getUserPermissions(user: any): Promise<string[]> {
  if (!user.roleId) return [];
  
  const roleName = user.role?.name;
  
  // National admin: check both their own nationalAdminId and GLOBAL
  if (roleName === 'national_admin') {
    const permissions = await prisma.rolePermission.findMany({
      where: {
        roleId: user.roleId,
        OR: [
          { nationalAdminId: user.id },
          { nationalAdminId: 'GLOBAL' },
        ],
      },
      include: { permission: { select: { name: true } } },
    });
    return permissions.map(rp => rp.permission.name);
  }
  
  // Member: check GLOBAL permissions
  if (roleName === 'member') {
    const permissions = await prisma.rolePermission.findMany({
      where: {
        roleId: user.roleId,
        nationalAdminId: 'GLOBAL',
      },
      include: { permission: { select: { name: true } } },
    });
    return permissions.map(rp => rp.permission.name);
  }
  
  // Tenant-specific roles: district_overseer, local_admin - use nationalAdminId
  if (user.nationalAdminId) {
    const permissions = await prisma.rolePermission.findMany({
      where: {
        nationalAdminId: user.nationalAdminId,
        roleId: user.roleId,
      },
      include: { permission: { select: { name: true } } },
    });
    return permissions.map(rp => rp.permission.name);
  }
  
  return [];
}

function extractPermissions(user: { rolePermissions: { permission: { name: string } }[] }): string[] {
  return user.rolePermissions.map(rp => rp.permission.name);
}

function parseJson(val: string | null | undefined): string[] | undefined {
  if (!val) return undefined;
  try { return JSON.parse(val) as string[]; } catch { return undefined; }
}

function safeUser(user: any, permissions: string[]): any {
  const { password: _pw, rolePermissions: _rp, ...rest } = user;
  return {
    ...rest,
    roleName: user.role?.name || null,
    permissions,
    districts: parseJson(user.districts),
    traditionalAuthorities: parseJson(user.traditionalAuthorities),
    accountCountry: user.accountCountry,
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
  let user = await prisma.user.findUnique({ where: { email }, include: USER_INCLUDE });

  if (!user || !(await comparePassword(password, user.password))) {
    res.status(401).json({ success: false, message: 'Invalid email or password' });
    return;
  }

  // Get package from National Admin if needed
  user = await getUserWithPackage(user.id) as any;

  const permissions = await getUserPermissions(user);

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
  res.json({ success: true, user: safeUser(user, permissions) });
}

const registerSchema = z.object({
  firstName: z.string().min(2, 'First name must be at least 2 characters'),
  lastName: z.string().min(2, 'Last name must be at least 2 characters'),
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  phone: z.string().min(1, 'Phone number is required'),
  accountCountry: z.enum(['Malawi', 'Kenya'], { required_error: 'Country is required' }).optional(),
  inviteToken: z.string().optional(),
}).superRefine((data, ctx) => {
  // If no inviteToken (national admin registration), require accountCountry
  if (!data.inviteToken && !data.accountCountry) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Country is required',
      path: ['accountCountry'],
    });
  }
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

  let churchId: string | null = null;
  let nationalAdminId: string | null = null;
  let roleId: string;

  // Check if registering via church invite link
  if (data.inviteToken) {
    const church = await prisma.church.findUnique({ 
      where: { inviteToken: data.inviteToken },
      select: { id: true, nationalAdminId: true }
    });
    
    if (!church) {
      res.status(400).json({ success: false, message: 'Invalid or expired invite link' });
      return;
    }
    
    // Member registration via invite link:
    // - Assign churchId so member belongs to this church
    // - nationalAdminId stays null for members (they get package access via church.nationalAdminId lookup)
    // - Assign member role
    churchId = church.id;
    nationalAdminId = null; // Members don't have direct nationalAdminId
    
    const memberRole = await prisma.role.findFirst({ where: { name: 'member' } });
    if (!memberRole) {
      res.status(500).json({ success: false, message: 'System not properly configured' });
      return;
    }
    roleId = memberRole.id;
  } else {
    // Regular registration as national admin (no invite link)
    const nationalAdminRole = await prisma.role.findFirst({ where: { name: 'national_admin' } });
    if (!nationalAdminRole) {
      res.status(500).json({ success: false, message: 'System not properly configured. Please contact support.' });
      return;
    }
    roleId = nationalAdminRole.id;
  }

  const hashed = await hashPassword(data.password);

  const user = await prisma.user.create({
    data: {
      email: data.email,
      password: hashed,
      firstName: data.firstName,
      lastName: data.lastName,
      roleId,
      churchId,
      nationalAdminId,
      accountCountry: data.accountCountry,
      phone: data.phone,
    },
    include: USER_INCLUDE,
  });

  const permissions = await getUserPermissions(user);

  const { queueEmail } = await import('../lib/emailQueue');
  const { registrationTemplate } = await import('../lib/emailTemplates');
  
  queueEmail(
    user.email,
    'Welcome to ICIMS',
    registrationTemplate({
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      roleName: user.role?.displayName,
    }),
    'registration'
  ).catch(err => console.error('Failed to queue registration email:', err));

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
  res.status(201).json({ success: true, user: safeUser(user, permissions) });
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

  const user = await getUserWithPackage(req.user.userId);

  if (!user) {
    res.status(404).json({ success: false, message: 'User not found' });
    return;
  }

  res.json({ success: true, user: safeUser(user, await getUserPermissions(user)) });
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

  await prisma.user.update({
    where: { id: user.id },
    data: updateData,
  });

  const updated = await getUserWithPackage(user.id);
  if (!updated) { res.status(404).json({ success: false, message: 'User not found' }); return; }

  res.json({ success: true, user: safeUser(updated, await getUserPermissions(updated)) });
}
