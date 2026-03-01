import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { getAccessibleChurchIds } from '../lib/churchScope';

const donationSchema = z.object({
  memberName: z.string().min(1),
  memberId: z.string().optional(),
  amount: z.number().positive(),
  type: z.enum(['tithe', 'offering', 'pledge', 'special']),
  method: z.enum(['cash', 'card', 'mobile_money', 'bank_transfer']),
  status: z.enum(['completed', 'pending', 'failed']).optional().default('pending'),
  reference: z.string().optional(),
  notes: z.string().optional(),
  date: z.string().optional(),
  churchId: z.string().min(1, 'Church ID required'),
});

export async function getDonations(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const churchId = req.user?.churchId;
  const roleName = req.user?.role ?? 'member';
  
  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  let churchIds: string[] = [];

  if (roleName === 'national_admin') {
    // National admin sees donations from their churches
    const churches = await prisma.church.findMany({
      where: { nationalAdminId: userId },
      select: { id: true }
    });
    churchIds = churches.map(c => c.id);
  } else {
    // Other roles use existing scope logic
    if (!churchId) {
      res.status(400).json({ success: false, message: 'churchId required' });
      return;
    }
    churchIds = await getAccessibleChurchIds(roleName, churchId, req.user?.districts, req.user?.traditionalAuthorities, req.user?.regions, userId);
  }

  const donations = await prisma.donation.findMany({
    where: { churchId: { in: churchIds } },
    orderBy: { date: 'desc' },
  });
  res.json({ success: true, data: donations });
}

export async function getDonation(req: Request, res: Response): Promise<void> {
  const donation = await prisma.donation.findUnique({ where: { id: String(req.params.id) } });
  if (!donation) { res.status(404).json({ success: false, message: 'Donation not found' }); return; }
  res.json({ success: true, data: donation });
}

export async function createDonation(req: Request, res: Response): Promise<void> {
  const parsed = donationSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const donation = await prisma.donation.create({
    data: {
      ...parsed.data,
      date: parsed.data.date ? new Date(parsed.data.date) : new Date(),
    },
  });
  res.status(201).json({ success: true, data: donation });
}

export async function updateDonation(req: Request, res: Response): Promise<void> {
  const parsed = donationSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const donation = await prisma.donation.update({
    where: { id: String(req.params.id) },
    data: {
      ...parsed.data,
      date: parsed.data.date ? new Date(parsed.data.date) : undefined,
    },
  });
  res.json({ success: true, data: donation });
}

export async function deleteDonation(req: Request, res: Response): Promise<void> {
  await prisma.donation.delete({ where: { id: String(req.params.id) } });
  res.json({ success: true, message: 'Donation record deleted' });
}
