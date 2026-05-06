import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { hashPassword, comparePassword } from '../lib/password';
import { signToken } from '../lib/jwt';
import { createSubdomain, toSlug } from '../lib/hostingerDns';
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

  // Members don't need the package object in the auth response —
  // hasFeature() queries the DB directly and doesn't use this field.
  // Returning the full features array for members wastes bandwidth and
  // exposes subscription details they have no use for.
  if (roleName === 'member') {
    return { ...user, package: null };
  }

  // For district_admin, branch_admin, regional_admin: get package from their National Admin subscription
  if ((roleName === 'district_admin' || roleName === 'branch_admin' || roleName === 'regional_admin') && user.ministryAdminId) {
    const subscription = await prisma.subscription.findFirst({
      where: { ministryAdminId: user.ministryAdminId, status: 'active' },
      include: {
        package: {
          include: { features: { include: { feature: true } } },
        },
      },
    });
    if (subscription?.package) return { ...user, package: subscription.package };
  }

  // For ministry_admin: get their own subscription
  if (roleName === 'ministry_admin') {
    const subscription = await prisma.subscription.findFirst({
      where: { ministryAdminId: userId, status: 'active' },
      include: {
        package: {
          include: { features: { include: { feature: true } } },
        },
      },
    });
    if (subscription?.package) return { ...user, package: subscription.package };
  }

  // No subscription found
  return { ...user, package: null };
}

async function getUserPermissions(user: any): Promise<string[]> {
  if (!user.roleId) return [];
  
  const roleName = user.role?.name;
  
  // National admin: check both their own ministryAdminId and GLOBAL
  if (roleName === 'ministry_admin') {
    const permissions = await prisma.rolePermission.findMany({
      where: {
        roleId: user.roleId,
        OR: [
          { ministryAdminId: user.id },
          { ministryAdminId: 'GLOBAL' },
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
        ministryAdminId: 'GLOBAL',
      },
      include: { permission: { select: { name: true } } },
    });
    return permissions.map(rp => rp.permission.name);
  }
  
  // Tenant-specific roles: district_admin, branch_admin - use ministryAdminId
  if (user.ministryAdminId) {
    const permissions = await prisma.rolePermission.findMany({
      where: {
        ministryAdminId: user.ministryAdminId,
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
  const roleName = user.role?.name || null;

  const base = {
    ...rest,
    roleName,
    permissions,
    districts: parseJson(user.districts),
    traditionalAuthorities: parseJson(user.traditionalAuthorities),
    accountCountry: user.accountCountry,
  };

  // Members don't need scope fields, package details, or ministry-level data
  if (roleName === 'member') {
    const {
      ministryAdminId: _mai,
      regions: _reg,
      districts: _dist,
      traditionalAuthorities: _ta,
      ministryName: _mn,
      numberOfBranches: _nb,
      currentMembership: _cm,
      subdomain: _sd,
      package: _pkg,
      ...memberBase
    } = base;
    return memberBase;
  }

  return base;
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

  if (user.status === 'suspended') {
    res.status(403).json({ success: false, message: 'Your account has been suspended. Please contact support.' });
    return;
  }

  if (user.status === 'inactive') {
    res.status(403).json({ success: false, message: 'Your account is inactive. Please contact support.' });
    return;
  }

  // Get package from National Admin if needed
  const userWithPackage = await getUserWithPackage(user.id);
  if (!userWithPackage) {
    res.status(500).json({ success: false, message: 'Failed to load user data' });
    return;
  }

  const permissions = await getUserPermissions(userWithPackage);

  if (!userWithPackage) {
    res.status(500).json({ success: false, message: 'Failed to load user data' });
    return;
  }

  const token = signToken({
    userId: userWithPackage.id,
    email: userWithPackage.email,
    role: (userWithPackage.role?.name || 'member') as UserRole,
    churchId: userWithPackage.churchId,
    permissions,
    districts: parseJson(userWithPackage.districts),
    traditionalAuthorities: parseJson(userWithPackage.traditionalAuthorities),
  });

  res.cookie('icims_token', token, COOKIE_OPTIONS);
  res.json({ success: true, user: safeUser(userWithPackage, permissions) });
}

const TITLES = ['Rev', 'Dr', 'Prof', 'Pastor', 'Prophet', 'Seer', 'Sister', 'Brother', 'Father', 'Other'] as const;

const registerSchema = z.object({
  firstName: z.string().min(2, 'First name must be at least 2 characters'),
  lastName: z.string().min(2, 'Last name must be at least 2 characters'),
  title: z.enum(TITLES).optional(),
  titleOther: z.string().optional(),
  ministryName: z.string().optional(),
  subdomain: z.string().optional(),  // custom slug; falls back to slugified ministryName
  currentMembership: z.number().int().min(0).optional(),
  numberOfBranches: z.number().int().min(0).optional(),
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  phone: z.string().min(1, 'Phone number is required'),
  gender: z.enum(['male', 'female'], { required_error: 'Gender is required' }),
  accountCountry: z.enum(['Malawi', 'Kenya'], { required_error: 'Country is required' }).optional(),
  anniversary: z.string().optional(),
  // Member-specific fields (sent when registering via invite link)
  dateOfBirth: z.string().optional(),
  maritalStatus: z.enum(['single', 'married', 'widowed', 'divorced']).optional(),
  weddingDate: z.string().optional(),
  residentialNeighbourhood: z.string().optional(),
  membershipType: z.enum(['member', 'pastor', 'deacon', 'other']).optional(),
  serviceInterest: z.string().optional(),
  baptizedByImmersion: z.boolean().optional(),
  inviteToken: z.string().optional(),
}).superRefine((data, ctx) => {
  // Ministry admin registration (no invite token) requires ministryName and accountCountry
  if (!data.inviteToken) {
    if (!data.ministryName || data.ministryName.trim().length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Ministry / church name is required',
        path: ['ministryName'],
      });
    }
    if (!data.accountCountry) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Country is required',
        path: ['accountCountry'],
      });
    }
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
  let ministryAdminId: string | null = null;
  let roleId: string;

  // Check if registering via church invite link
  if (data.inviteToken) {
    const church = await prisma.church.findUnique({ 
      where: { inviteToken: data.inviteToken },
      select: { id: true, ministryAdminId: true }
    });
    
    if (!church) {
      res.status(400).json({ success: false, message: 'Invalid or expired invite link' });
      return;
    }
    
    // Member registration via invite link:
    // - Assign churchId so member belongs to this church
    // - ministryAdminId stays null for members (they get package access via church.ministryAdminId lookup)
    // - Assign member role
    churchId = church.id;
    ministryAdminId = null; // Members don't have direct ministryAdminId
    
    const memberRole = await prisma.role.findFirst({ where: { name: 'member' } });
    if (!memberRole) {
      res.status(500).json({ success: false, message: 'System not properly configured' });
      return;
    }
    roleId = memberRole.id;
  } else {
    // Regular registration as national admin (no invite link)
    const ministryAdminRole = await prisma.role.findFirst({ where: { name: 'ministry_admin' } });
    if (!ministryAdminRole) {
      res.status(500).json({ success: false, message: 'System not properly configured. Please contact support.' });
      return;
    }
    roleId = ministryAdminRole.id;
  }

  const hashed = await hashPassword(data.password);

  const user = await prisma.user.create({
    data: {
      email: data.email,
      password: hashed,
      firstName: data.firstName,
      lastName: data.lastName,
      title: data.title,
      titleOther: data.titleOther,
      ministryName: data.ministryName,
      currentMembership: data.currentMembership,
      numberOfBranches: data.numberOfBranches ?? 0,
      roleId,
      churchId,
      ministryAdminId,
      accountCountry: data.accountCountry,
      phone: data.phone,
      gender: data.gender,
      anniversary: data.anniversary ? new Date(data.anniversary) : undefined,
      // Member fields
      dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : undefined,
      maritalStatus: data.maritalStatus,
      weddingDate: data.weddingDate ? new Date(data.weddingDate) : undefined,
      residentialNeighbourhood: data.residentialNeighbourhood,
      membershipType: data.membershipType,
      serviceInterest: data.serviceInterest,
      baptizedByImmersion: data.baptizedByImmersion,
    },
    include: USER_INCLUDE,
  });

  const permissions = await getUserPermissions(user);

  // ── Subdomain creation for ministry_admin registrations ──────────────────
  let subdomainValue: string | null = null;
  if (!data.inviteToken && data.ministryName) {
    // Use custom slug if provided, otherwise derive from ministry name
    const slugSource = (data.subdomain && data.subdomain.trim())
      ? data.subdomain.trim()
      : data.ministryName;
    const fullSubdomain = await createSubdomain(toSlug(slugSource));
    if (fullSubdomain) {
      subdomainValue = fullSubdomain;
      await prisma.user.update({
        where: { id: user.id },
        data: { subdomain: fullSubdomain },
      });
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  const { queueEmail } = await import('../lib/emailQueue');
  const { registrationTemplate, memberWelcomeTemplate } = await import('../lib/emailTemplates');
  
  // Send different email based on role
  if (data.inviteToken && user.church) {
    // Member registration - send welcome to church email
    queueEmail(
      user.email,
      `Welcome to ${user.church.name}`,
      memberWelcomeTemplate({
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        churchName: user.church.name,
      }),
      'registration'
    ).catch(err => console.error('Failed to queue member welcome email:', err));
  } else {
    // National admin registration - send full registration email
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
  }

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
  res.status(201).json({ success: true, user: { ...safeUser(user, permissions), subdomain: subdomainValue } });
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

  if (user.status === 'suspended') {
    res.status(403).json({ success: false, message: 'Your account has been suspended. Please contact support.' });
    return;
  }

  if (user.status === 'inactive') {
    res.status(403).json({ success: false, message: 'Your account is inactive. Please contact support.' });
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

  const file = (req as any).file;
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const { firstName, lastName, phone, currentPassword, newPassword } = parsed.data;

  const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
  if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }

  const updateData: Record<string, unknown> = {};
  if (firstName) updateData.firstName = firstName;
  if (lastName) updateData.lastName = lastName;
  if (phone !== undefined) updateData.phone = phone;
  if (file) updateData.avatar = `/uploads/avatars/${file.filename}`;

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
