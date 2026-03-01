import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';

// Parse roles JSON string to array for API responses
function parseMember(m: Record<string, unknown>) {
  return {
    ...m,
    roles: (() => { try { return JSON.parse(m.roles as string); } catch { return []; } })(),
  };
}

const memberSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phone: z.string().min(7),
  email: z.string().email().optional().or(z.literal('')),
  gender: z.enum(['male', 'female', 'other']).optional(),
  dateOfBirth: z.string().optional(),
  status: z.enum(['active', 'inactive', 'pending']).optional(),
  roles: z.array(z.string()).optional(),
  familyId: z.string().optional(),
});

// Helper to get the churchId the current user can operate on
function resolveChurchId(req: Request): string | null {
  return req.query.churchId as string || req.user?.churchId || null;
}

export async function getMembers(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const role = req.user?.role ?? 'member';
  
  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  let churchIds: string[] = [];

  if (role === 'national_admin') {
    // National admin sees members from their churches
    const churches = await prisma.church.findMany({
      where: { nationalAdminId: userId },
      select: { id: true }
    });
    churchIds = churches.map(c => c.id);
  } else {
    // Other roles need churchId
    const churchId = resolveChurchId(req);
    if (!churchId) {
      res.status(400).json({ success: false, message: 'churchId required' });
      return;
    }
    churchIds = [churchId];
  }

  const members = await prisma.member.findMany({
    where: { churchId: { in: churchIds } },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ success: true, data: members.map(m => parseMember(m as unknown as Record<string, unknown>)) });
}

export async function getMember(req: Request, res: Response): Promise<void> {
  const member = await prisma.member.findUnique({ where: { id: String(req.params.id) } });
  if (!member) { res.status(404).json({ success: false, message: 'Member not found' }); return; }
  res.json({ success: true, data: parseMember(member as unknown as Record<string, unknown>) });
}

export async function createMember(req: Request, res: Response): Promise<void> {
  const parsed = memberSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const churchId = req.body.churchId || req.user?.churchId;
  if (!churchId) { res.status(400).json({ success: false, message: 'churchId required' }); return; }

  // Generate member ID
  const count = await prisma.member.count({ where: { churchId } });
  const memberId = `MBR-${String(count + 1).padStart(4, '0')}`;

  const member = await prisma.member.create({
    data: {
      ...parsed.data,
      email: parsed.data.email || undefined,
      dateOfBirth: parsed.data.dateOfBirth ? new Date(parsed.data.dateOfBirth) : undefined,
      roles: JSON.stringify(parsed.data.roles || []),
      memberId,
      churchId,
    },
  });
  res.status(201).json({ success: true, data: parseMember(member as unknown as Record<string, unknown>) });
}

export async function updateMember(req: Request, res: Response): Promise<void> {
  const parsed = memberSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const member = await prisma.member.update({
    where: { id: String(req.params.id) },
    data: {
      ...parsed.data,
      email: parsed.data.email || undefined,
      dateOfBirth: parsed.data.dateOfBirth ? new Date(parsed.data.dateOfBirth) : undefined,
      roles: parsed.data.roles ? JSON.stringify(parsed.data.roles) : undefined,
    },
  });
  res.json({ success: true, data: parseMember(member as unknown as Record<string, unknown>) });
}

export async function deleteMember(req: Request, res: Response): Promise<void> {
  await prisma.member.delete({ where: { id: String(req.params.id) } });
  res.json({ success: true, message: 'Member removed' });
}
