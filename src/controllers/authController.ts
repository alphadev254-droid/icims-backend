import { Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import { hashPassword, comparePassword } from '../lib/password';
import { signToken } from '../lib/jwt';
import { createSubdomain, toSlug } from '../lib/cloudflareDns';
import { recordLoginAttempt } from '../middleware/metrics';
import { displayName, logger, maskEmail, maskToken } from '../utils/logger';
import type { UserRole } from '../types';
import { buildSafePackageEntitlement, packageEntitlementInclude } from '../lib/packageEntitlements';
import { findPackageMarketPriceWithFallback, getUserPackageAccountCountry, resolvePricingMarket } from '../utils/pricingMarkets';
import { optionalPhoneSchema, phoneSchema } from '../lib/inputValidation';

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

async function getEffectiveMinistryAdminId(user: any): Promise<string | null> {
  if (user?.role?.name === 'ministry_admin') return user.id;
  if (user?.ministryAdminId) return user.ministryAdminId;
  if (!user?.churchId) return null;

  const church = await prisma.church.findUnique({
    where: { id: user.churchId },
    select: { ministryAdminId: true },
  });

  return church?.ministryAdminId ?? null;
}

async function getUserWithPackage(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: USER_INCLUDE,
  });

  if (!user) return null;

  // Every dashboard user inherits module availability from the effective
  // ministry owner. Permissions and church scope are still checked separately.
  const effectiveMinistryAdminId = await getEffectiveMinistryAdminId(user);
  if (effectiveMinistryAdminId) {
    const subscription = await prisma.subscription.findFirst({
      where: { ministryAdminId: effectiveMinistryAdminId, status: 'active' },
      include: {
        package: { include: packageEntitlementInclude },
      },
    });
    if (subscription?.package) {
      const accountCountry = await getUserPackageAccountCountry(user.id, user.role?.name);
      const market = await resolvePricingMarket(accountCountry);
      const generalMarket = market.code === 'general' ? market : await resolvePricingMarket('General');
      const marketPrice = findPackageMarketPriceWithFallback(subscription.package, market.id, generalMarket.id);
      return {
        ...user,
        package: buildSafePackageEntitlement(subscription.package, {
          pricingMarketId: marketPrice?.pricingMarketId ?? market.id,
          fallbackPricingMarketId: generalMarket.id,
        }),
      };
    }
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
  // Permissions are stored with ministryAdminId = <ministry_admin_id> (tenant-specific)
  // OR ministryAdminId = 'GLOBAL' (default permissions from seed)
  const effectiveMinistryAdminId = await getEffectiveMinistryAdminId(user);
  if (effectiveMinistryAdminId) {
    // Try tenant-specific permissions first, then fall back to GLOBAL for this role
    const permissions = await prisma.rolePermission.findMany({
      where: {
        roleId: user.roleId,
        OR: [
          { ministryAdminId: effectiveMinistryAdminId },
          { ministryAdminId: 'GLOBAL' },
        ],
      },
      include: { permission: { select: { name: true } } },
    });
    // Deduplicate — tenant-specific takes precedence but GLOBAL fills gaps
    const seen = new Set<string>();
    return permissions
      .map(rp => rp.permission.name)
      .filter(name => { if (seen.has(name)) return false; seen.add(name); return true; });
  }

  // ministryAdminId not set — fall back to GLOBAL permissions for this role
  // This handles users created before the ministryAdminId fix was applied
  const globalPermissions = await prisma.rolePermission.findMany({
    where: { roleId: user.roleId, ministryAdminId: 'GLOBAL' },
    include: { permission: { select: { name: true } } },
  });
  return globalPermissions.map(rp => rp.permission.name);
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
  const roleDisplayName = user.role?.displayName || roleName;

  const base = {
    ...rest,
    roleName,
    roleDisplayName,
    permissions,
    districts: parseJson(user.districts),
    traditionalAuthorities: parseJson(user.traditionalAuthorities),
    accountCountry: user.accountCountry,
  };

  // Members borrow package feature visibility from their ministry, but they
  // should not receive ministry-level scope/profile fields.
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
    recordLoginAttempt('failed', 'validation', {
      requestId: req.requestId,
      email: maskEmail(typeof req.body?.email === 'string' ? req.body.email : undefined),
      ip: req.ip,
    });
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const { email, password } = parsed.data;
  let user = await prisma.user.findUnique({ where: { email }, include: USER_INCLUDE });
  const loginLogMeta = {
    requestId: req.requestId,
    email: maskEmail(email),
    ip: req.ip,
    userId: user?.id,
    userName: displayName(user?.firstName, user?.lastName),
    role: user?.role?.name,
    churchId: user?.churchId,
    accountCountry: user?.accountCountry,
  };

  if (!user || !(await comparePassword(password, user.password))) {
    recordLoginAttempt('failed', 'invalid_credentials', loginLogMeta);
    res.status(401).json({ success: false, message: 'Invalid email or password' });
    return;
  }

  if (user.status === 'suspended') {
    recordLoginAttempt('failed', 'suspended', loginLogMeta);
    res.status(403).json({ success: false, message: 'Your account has been suspended. Please contact support.' });
    return;
  }

  if (user.status === 'inactive') {
    recordLoginAttempt('failed', 'inactive', loginLogMeta);
    res.status(403).json({ success: false, message: 'Your account is inactive. Please contact support.' });
    return;
  }
  if (user.status === 'cancelled') {
    recordLoginAttempt('failed', 'cancelled', loginLogMeta);
    res.status(403).json({ success: false, message: 'This account has been cancelled. Please contact support.' });
    return;
  }
  if (user.loginEnabled === false) {
    recordLoginAttempt('failed', 'login_disabled', loginLogMeta);
    res.status(403).json({ success: false, message: 'This account does not have login access.' });
    return;
  }

  // Get package from National Admin if needed
  const userWithPackage = await getUserWithPackage(user.id);
  if (!userWithPackage) {
    recordLoginAttempt('failed', 'user_load_failed', loginLogMeta);
    res.status(500).json({ success: false, message: 'Failed to load user data' });
    return;
  }

  const permissions = await getUserPermissions(userWithPackage);

  if (!userWithPackage) {
    recordLoginAttempt('failed', 'user_load_failed', loginLogMeta);
    res.status(500).json({ success: false, message: 'Failed to load user data' });
    return;
  }

  const token = signToken({
    userId: userWithPackage.id,
    email: userWithPackage.email,
    firstName: userWithPackage.firstName,
    lastName: userWithPackage.lastName,
    userName: displayName(userWithPackage.firstName, userWithPackage.lastName),
    role: (userWithPackage.role?.name || 'member') as UserRole,
    churchId: userWithPackage.churchId,
    permissions,
    accountCountry: userWithPackage.accountCountry ?? undefined,
    regions: parseJson(userWithPackage.regions),
    districts: parseJson(userWithPackage.districts),
    traditionalAuthorities: parseJson(userWithPackage.traditionalAuthorities),
  });

  res.cookie('icims_token', token, COOKIE_OPTIONS);
  recordLoginAttempt('success', 'none', loginLogMeta);
  res.json({ success: true, user: safeUser(userWithPackage, permissions) });
}

const TITLES = ['Rev', 'Dr', 'Prof', 'Pastor', 'Prophet', 'Seer', 'Sister', 'Brother', 'Father', 'Deacon', 'Apostle', 'Evangelist', 'Other'] as const;
const TERMS_VERSION = '2026-08-11';
const PRIVACY_VERSION = '2026-08-11';

const termsAcceptanceSchema = {
  acceptedTerms: z.literal(true, {
    errorMap: () => ({ message: 'You must accept the Terms and Conditions and Privacy Policy to create an account' }),
  }),
  termsVersion: z.string().optional(),
  privacyVersion: z.string().optional(),
};

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
  phone: phoneSchema,
  gender: z.enum(['male', 'female'], { required_error: 'Gender is required' }),
  accountCountry: z.string({ required_error: 'Country is required' }).trim().min(2, 'Country is required').max(80).optional(),
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
  registrationType: z.enum(['ministry_admin', 'member']).optional(),
  ...termsAcceptanceSchema,
}).superRefine((data, ctx) => {
  const hasMemberOnlyFields = Boolean(
    data.registrationType === 'member' ||
    data.dateOfBirth ||
    data.maritalStatus ||
    data.weddingDate ||
    data.residentialNeighbourhood ||
    data.membershipType ||
    data.serviceInterest ||
    data.baptizedByImmersion !== undefined
  );

  if (hasMemberOnlyFields && !data.inviteToken) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A valid church invite link is required for member registration',
      path: ['inviteToken'],
    });
  }

  // Ministry admin registration (no invite token) requires ministryName and accountCountry
  if (!data.inviteToken && data.registrationType !== 'member') {
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

const memberRegisterSchema = z.object({
  firstName: z.string().min(2, 'First name must be at least 2 characters'),
  lastName: z.string().min(2, 'Last name must be at least 2 characters'),
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  phone: phoneSchema,
  gender: z.enum(['male', 'female'], { required_error: 'Gender is required' }),
  dateOfBirth: z.string().min(1, 'Date of birth is required'),
  maritalStatus: z.enum(['single', 'married', 'widowed', 'divorced'], { required_error: 'Marital status is required' }),
  weddingDate: z.string().optional(),
  residentialNeighbourhood: z.string().optional(),
  membershipType: z.enum(['member', 'pastor', 'deacon', 'other']).default('member'),
  serviceInterest: z.string().optional(),
  baptizedByImmersion: z.boolean().optional(),
  inviteToken: z.string().min(1, 'A valid church invite link is required'),
  expectedChurchId: z.string().optional(),
  ...termsAcceptanceSchema,
});

const acceptTermsSchema = z.object({
  acceptedTerms: z.literal(true, {
    errorMap: () => ({ message: 'You must accept the Terms and Conditions and Privacy Policy to continue' }),
  }),
  termsVersion: z.string().optional(),
  privacyVersion: z.string().optional(),
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
    const church = await prisma.church.findFirst({
      where: { inviteToken: data.inviteToken, status: 'active' },
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

  // ── All DB writes in a single transaction ─────────────────────────────────
  const { user, churchProfileCreated } = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: data.email,
        password: hashed,
        firstName: data.firstName,
        lastName: data.lastName,
        title: data.title,
        titleOther: data.titleOther,
        ministryName: data.inviteToken ? null : data.ministryName,
        currentMembership: data.inviteToken ? null : data.currentMembership,
        numberOfBranches: data.inviteToken ? 0 : (data.numberOfBranches ?? 0),
        roleId,
        churchId,
        ministryAdminId,
        accountCountry: data.inviteToken ? undefined : data.accountCountry,
        phone: data.phone,
        gender: data.gender,
        anniversary: !data.inviteToken && data.anniversary ? new Date(data.anniversary) : undefined,
        dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : undefined,
        maritalStatus: data.maritalStatus,
        weddingDate: data.weddingDate ? new Date(data.weddingDate) : undefined,
        residentialNeighbourhood: data.residentialNeighbourhood?.trim() || null,
        membershipType: data.membershipType,
        serviceInterest: data.serviceInterest,
        baptizedByImmersion: data.baptizedByImmersion,
        acceptedTerms: true,
        termsAcceptedAt: new Date(),
        termsVersion: data.termsVersion || TERMS_VERSION,
        privacyVersion: data.privacyVersion || PRIVACY_VERSION,
        termsAcceptedIp: req.ip,
        termsAcceptedUserAgent: req.get('user-agent') ?? null,
      },
      include: USER_INCLUDE,
    });

    // Auto-seed ChurchProfile for ministry_admin registrations
    let churchProfileCreated = false;
    if (!data.inviteToken && data.ministryName) {
      const ministryName = data.ministryName;
      await tx.churchProfile.create({
        data: {
          ministryAdminId: user.id,
          primaryColor: '#d89b12',
          tagline: 'A place of hope, community, and faith.',
          aboutText: `Welcome to ${ministryName} — a vibrant, Spirit-filled community committed to worship, discipleship, and service. We believe every person has a God-given purpose, and we exist to help you discover and live it out.\n\nWhether you are new to faith or have walked with God for years, there is a place for you here. Join us as we grow together in love and truth.`,
          visionText: 'To see every person transformed by the love of Christ and empowered to impact their community.',
          missionText: 'Making disciples who make disciples — through worship, the Word, and authentic community.',
          pastorName: [data.title, data.firstName, data.lastName].filter(Boolean).join(' '),
          pastorBio: 'Update this with your bio in the Church Website settings.',
          serviceTimes: JSON.stringify([
            { name: 'Sunday Service',        day: 'Sunday',    time: '9:00 AM',  location: 'Main Auditorium' },
            { name: 'Sunday Second Service', day: 'Sunday',    time: '11:30 AM', location: 'Main Auditorium' },
            { name: 'Wednesday Bible Study', day: 'Wednesday', time: '6:30 PM',  location: 'Fellowship Hall' },
          ]),
          phone: data.phone ?? null,
          email: data.email,
          isPublished: false,
        },
      });
      churchProfileCreated = true;
    }

    return { user, churchProfileCreated };
  });
  // ─────────────────────────────────────────────────────────────────────────

  const registeredUserWithPackage = await getUserWithPackage(user.id) ?? user;
  const permissions = await getUserPermissions(registeredUserWithPackage);

  // ── Subdomain creation (async via BullMQ queue) ──────────────────────────
  let subdomainValue: string | null = null;
  if (!data.inviteToken && data.ministryName) {
    const { queueSubdomainCreation } = await import('../lib/subdomainQueue');
    await queueSubdomainCreation({
      userId: user.id,
      ministryName: data.ministryName,
      customSubdomain: data.subdomain,
      email: user.email,
      firstName: user.firstName,
    });
    // Subdomain will be created asynchronously and email sent when ready
    console.log(`[Registration] Subdomain creation queued for user ${user.id}`);
  }
  // ─────────────────────────────────────────────────────────────────────────

  const { queueEmail } = await import('../lib/emailQueue');
  const { memberWelcomeTemplate } = await import('../lib/emailTemplates');
  
  // Send different email based on role
  if (data.inviteToken && user.church) {
    // Member registration - send welcome to church email immediately
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
  }
  // Note: Ministry admin welcome email is now sent AFTER subdomain is created (in queue worker)

  const token = signToken({
    userId: user.id,
    email: user.email,
    role: (user.role?.name || 'member') as UserRole,
    churchId: user.churchId,
    permissions,
    accountCountry: registeredUserWithPackage.accountCountry ?? undefined,
    regions: parseJson(registeredUserWithPackage.regions),
    districts: parseJson(registeredUserWithPackage.districts),
    traditionalAuthorities: parseJson(registeredUserWithPackage.traditionalAuthorities),
  });

  res.cookie('icims_token', token, COOKIE_OPTIONS);
  res.status(201).json({ success: true, user: { ...safeUser(registeredUserWithPackage, permissions), subdomain: subdomainValue } });
}

export async function registerMember(req: Request, res: Response): Promise<void> {
  const parsed = memberRegisterSchema.safeParse(req.body);
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

  const [church, memberRole] = await Promise.all([
    prisma.church.findFirst({ where: { inviteToken: data.inviteToken, status: 'active' }, select: { id: true, name: true } }),
    prisma.role.findFirst({ where: { name: 'member' } }),
  ]);

  if (!church) {
    res.status(400).json({ success: false, message: 'Invalid or expired invite link' });
    return;
  }

  if (data.expectedChurchId && data.expectedChurchId !== church.id) {
    logger.warn('member_registration_invite_church_mismatch', {
      requestId: req.requestId,
      inviteToken: maskToken(data.inviteToken),
      expectedChurchId: data.expectedChurchId,
      resolvedChurchId: church.id,
      email: maskEmail(data.email),
    });
    res.status(400).json({
      success: false,
      message: 'This registration link does not match the selected church. Please ask your church admin for a fresh invite link.',
    });
    return;
  }

  if (!memberRole) {
    res.status(500).json({ success: false, message: 'System not properly configured' });
    return;
  }

  const hashed = await hashPassword(data.password);

  const user = await prisma.user.create({
    data: {
      email: data.email,
      password: hashed,
      firstName: data.firstName,
      lastName: data.lastName,
      roleId: memberRole.id,
      churchId: church.id,
      ministryAdminId: null,
      phone: data.phone,
      gender: data.gender,
      dateOfBirth: new Date(data.dateOfBirth),
      maritalStatus: data.maritalStatus,
      weddingDate: data.weddingDate ? new Date(data.weddingDate) : undefined,
      residentialNeighbourhood: data.residentialNeighbourhood?.trim() || null,
      membershipType: data.membershipType ?? 'member',
      serviceInterest: data.serviceInterest,
      baptizedByImmersion: data.baptizedByImmersion,
      acceptedTerms: true,
      termsAcceptedAt: new Date(),
      termsVersion: data.termsVersion || TERMS_VERSION,
      privacyVersion: data.privacyVersion || PRIVACY_VERSION,
      termsAcceptedIp: req.ip,
      termsAcceptedUserAgent: req.get('user-agent') ?? null,
    },
    include: USER_INCLUDE,
  });

  logger.info('member_registration_completed', {
    requestId: req.requestId,
    userId: user.id,
    userName: displayName(user.firstName, user.lastName),
    email: maskEmail(user.email),
    churchId: church.id,
    inviteToken: maskToken(data.inviteToken),
  });

  const userWithPackage = await getUserWithPackage(user.id) ?? user;
  const permissions = await getUserPermissions(userWithPackage);

  const { queueEmail } = await import('../lib/emailQueue');
  const { memberWelcomeTemplate } = await import('../lib/emailTemplates');
  queueEmail(
    user.email,
    `Welcome to ${church.name}`,
    memberWelcomeTemplate({
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      churchName: church.name,
    }),
    'registration'
  ).catch(err => console.error('Failed to queue member welcome email:', err));

  const token = signToken({
    userId: user.id,
    email: user.email,
    role: 'member',
    churchId: user.churchId,
    permissions,
    accountCountry: user.accountCountry ?? undefined,
    regions: parseJson(user.regions),
    districts: parseJson(user.districts),
    traditionalAuthorities: parseJson(user.traditionalAuthorities),
  });

  res.cookie('icims_token', token, COOKIE_OPTIONS);
  res.status(201).json({ success: true, user: safeUser(userWithPackage, permissions) });
}

export async function acceptTerms(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const parsed = acceptTermsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const data = parsed.data;
  const updated = await prisma.user.update({
    where: { id: req.user.userId },
    data: {
      acceptedTerms: true,
      termsAcceptedAt: new Date(),
      termsVersion: data.termsVersion || TERMS_VERSION,
      privacyVersion: data.privacyVersion || PRIVACY_VERSION,
      termsAcceptedIp: req.ip,
      termsAcceptedUserAgent: req.get('user-agent') ?? null,
    },
    include: USER_INCLUDE,
  });

  logger.info('terms_accepted', {
    requestId: req.requestId,
    userId: updated.id,
    userName: displayName(updated.firstName, updated.lastName),
    email: maskEmail(updated.email),
    termsVersion: data.termsVersion || TERMS_VERSION,
    privacyVersion: data.privacyVersion || PRIVACY_VERSION,
  });

  const updatedWithPackage = await getUserWithPackage(updated.id) ?? updated;
  res.json({ success: true, user: safeUser(updatedWithPackage, await getUserPermissions(updatedWithPackage)) });
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
  if (user.status === 'cancelled') {
    res.status(403).json({ success: false, message: 'This account has been cancelled. Please contact support.' });
    return;
  }
  if (user.loginEnabled === false) {
    res.status(403).json({ success: false, message: 'This account does not have login access.' });
    return;
  }

  res.json({ success: true, user: safeUser(user, await getUserPermissions(user)) });
}

const profileSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  phone: optionalPhoneSchema,
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

export async function getAttendanceQr(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const existing = await (prisma.user as any).findUnique({
    where: { id: req.user.userId },
    select: { id: true, attendanceQrToken: true, loginEnabled: true, memberType: true, status: true },
  });

  if (!existing) {
    res.status(404).json({ success: false, message: 'User not found' });
    return;
  }
  if (existing.status !== 'active' || existing.loginEnabled === false || existing.memberType === 'child') {
    res.status(403).json({ success: false, message: 'Attendance QR is only available for active member accounts' });
    return;
  }

  const token = existing.attendanceQrToken || crypto.randomBytes(24).toString('base64url');
  if (!existing.attendanceQrToken) {
    await (prisma.user as any).update({
      where: { id: existing.id },
      data: { attendanceQrToken: token },
    });
  }

  res.json({ success: true, data: { token } });
}
