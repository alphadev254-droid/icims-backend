import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { hashPassword } from '../lib/password';
import { console } from 'inspector';

const USER_INCLUDE = {
  role: true,
  church: true,
  rolePermissions: {
    include: {
      permission: true,
    },
  },
} as const;

function safeUser(user: any) {
  const { password: _pw, ...rest } = user;
  // Parse JSON scope fields for frontend
  return {
    ...rest,
    roleName: rest.role?.name || rest.roleName,
    districts: rest.districts ? JSON.parse(rest.districts) : undefined,
    traditionalAuthorities: rest.traditionalAuthorities ? JSON.parse(rest.traditionalAuthorities) : undefined,
  };
}

// ─── GET /api/users ────────────────────────────────────────────────────────────

export async function getUsers(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const role = req.user?.role ?? 'member';
  
  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  let users: any[] = [];

  if (role === 'national_admin') {
    // National admin sees all users in their churches + district_overseer/local_admin they created
    const churches = await prisma.church.findMany({
      where: { nationalAdminId: userId },
      select: { id: true }
    });
    const churchIds = churches.map(c => c.id);
    console.log('National admin userId:', userId, 'owns churches:', churchIds);
    
    users = await prisma.user.findMany({
      where: {
        OR: [
          { churchId: { in: churchIds } },
          { nationalAdminId: userId }
        ]
      },
      include: { role: true },
      orderBy: { createdAt: 'desc' },
    });
  } else {
    // Other roles need churchId
    const churchId = req.user?.churchId;
    if (!churchId) {
      res.status(400).json({ success: false, message: 'churchId required' });
      return;
    }

    users = await prisma.user.findMany({
      where: { churchId },
      include: { role: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  res.json({ success: true, data: users.map(safeUser) });
}

// ─── POST /api/users — create a user in the same church ───────────────────────

const createUserSchema = z.object({
  email: z.string().email('Invalid email'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  firstName: z.string().min(1, 'First name required'),
  lastName: z.string().min(1, 'Last name required'),
  phone: z.string().optional(),
  roleName: z.string().default('member'),
  // Geographic scope for district_overseer / local_admin
  districts: z.array(z.string()).optional(),
  traditionalAuthorities: z.array(z.string()).optional(),
  // Church assignment for member role
  churchId: z.string().optional(),
  // Location selection for roles that need geographic assignment
  region: z.string().optional(),
  district: z.string().optional(),
  traditionalAuthority: z.string().optional(),
  village: z.string().optional(),
});

export async function createUser(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const role = req.user?.role ?? 'member';
  const permissions = req.user?.permissions ?? [];
  const userDistricts = req.user?.districts ?? [];
  const userTAs = req.user?.traditionalAuthorities ?? [];
  
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

  const { email, password, firstName, lastName, phone, roleName, districts, traditionalAuthorities, churchId, region, district, traditionalAuthority, village } = parsed.data;

  // Role restrictions: only national_admin can create users with roles other than 'member'
  if (role !== 'national_admin' && roleName !== 'member') {
    res.status(403).json({ 
      success: false, 
      message: 'Only national administrators can create users with administrative roles. You can only create members.' 
    });
    return;
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    res.status(409).json({ success: false, message: 'Email already in use' });
    return;
  }

  // Find the global role
  const roleRecord = await prisma.role.findUnique({
    where: { name: roleName },
  });
  if (!roleRecord) {
    res.status(404).json({ success: false, message: `Role '${roleName}' not found` });
    return;
  }

  // Determine churchId based on user's role and the new user's role
  let assignedChurchId: string | null = null;
  
  if (role === 'national_admin') {
    if (roleName === 'member' && churchId) {
      // National admin assigning member to specific church
      assignedChurchId = churchId;
    } else {
      // Administrative roles don't need churchId initially
      assignedChurchId = null;
    }
  } else if (role === 'district_overseer') {
    // District overseer creating users - find church based on location
    if (district && traditionalAuthority) {
      // Check if the selected location is within their scope
      if (!userDistricts.includes('__all__') && !userDistricts.includes(district)) {
        res.status(403).json({ success: false, message: 'You can only create users in your assigned districts' });
        return;
      }
      
      // Find church in that location
      const church = await prisma.church.findFirst({
        where: {
          district,
          traditionalAuthority,
          village: village || undefined,
        },
      });
      
      if (church) {
        assignedChurchId = church.id;
      } else {
        res.status(404).json({ success: false, message: 'No church found in the specified location' });
        return;
      }
    } else {
      res.status(400).json({ success: false, message: 'District and Traditional Authority required for user assignment' });
      return;
    }
  } else if (role === 'local_admin') {
    // Local admin creating users - find church based on location
    if (traditionalAuthority) {
      // Check if the selected location is within their scope
      if (!userTAs.includes('__all__') && !userTAs.includes(traditionalAuthority)) {
        res.status(403).json({ success: false, message: 'You can only create users in your assigned traditional authorities' });
        return;
      }
      
      // Find church in that location
      const church = await prisma.church.findFirst({
        where: {
          traditionalAuthority,
          village: village || undefined,
        },
      });
      
      if (church) {
        assignedChurchId = church.id;
      } else {
        res.status(404).json({ success: false, message: 'No church found in the specified location' });
        return;
      }
    } else {
      res.status(400).json({ success: false, message: 'Traditional Authority required for user assignment' });
      return;
    }
  } else {
    // Other roles (regional_leader, member) use their own church
    const userChurchId = req.user?.churchId;
    if (!userChurchId) {
      res.status(400).json({ success: false, message: 'Church ID required for this role' });
      return;
    }
    assignedChurchId = userChurchId;
  }

  const hashed = await hashPassword(password);
  const user = await prisma.user.create({
    data: {
      email,
      password: hashed,
      firstName,
      lastName,
      phone,
      roleId: roleRecord.id,
      churchId: assignedChurchId,
      nationalAdminId: (roleName === 'district_overseer' || roleName === 'local_admin') ? userId : undefined,
      districts: districts ? JSON.stringify(districts) : undefined,
      traditionalAuthorities: traditionalAuthorities ? JSON.stringify(traditionalAuthorities) : undefined,
    },
    include: USER_INCLUDE,
  });

  res.status(201).json({ success: true, data: safeUser(user) });
}

// ─── PUT /api/users/:id — update user details ─────────────────────────────────

const updateUserSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  password: z.string().min(8).optional(),
  roleName: z.string().optional(),
  districts: z.array(z.string()).optional(),
  traditionalAuthorities: z.array(z.string()).optional(),
  churchId: z.string().optional(),
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

  const { firstName, lastName, phone, email, password, roleName, districts, traditionalAuthorities, churchId } = parsed.data;
  
  // Role restrictions: only national_admin can assign roles other than 'member'
  if (roleName && role !== 'national_admin' && roleName !== 'member') {
    res.status(403).json({ 
      success: false, 
      message: 'Only national administrators can assign administrative roles. You can only assign member role.' 
    });
    return;
  }

  const updateData: Record<string, unknown> = {};
  if (firstName) updateData.firstName = firstName;
  if (lastName) updateData.lastName = lastName;
  if (phone !== undefined) updateData.phone = phone;
  if (email) updateData.email = email;
  if (password) updateData.password = await hashPassword(password);
  if (churchId !== undefined) updateData.churchId = churchId;
  if (districts !== undefined) updateData.districts = JSON.stringify(districts);
  if (traditionalAuthorities !== undefined) updateData.traditionalAuthorities = JSON.stringify(traditionalAuthorities);

  if (roleName) {
    const roleRecord = await prisma.role.findUnique({ where: { name: roleName } });
    if (!roleRecord) {
      res.status(404).json({ success: false, message: `Role '${roleName}' not found` });
      return;
    }
    updateData.roleId = roleRecord.id;
    // Clear scope fields when role changes (let caller re-supply if needed)
    if (!districts) updateData.districts = null;
    if (!traditionalAuthorities) updateData.traditionalAuthorities = null;
  }

  const updated = await prisma.user.update({
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

  await prisma.user.delete({ where: { id: String(req.params.id) } });
  res.json({ success: true, message: 'User deleted' });
}
