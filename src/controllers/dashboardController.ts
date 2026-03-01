import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { getAccessibleChurchIds } from '../lib/churchScope';

export async function getStats(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const churchId = req.user?.churchId;
  const roleName = req.user?.role ?? 'member';
  
  if (!userId) { 
    res.status(401).json({ success: false, message: 'User not authenticated' }); 
    return; 
  }

  let churchIds: string[] = [];

  if (roleName === 'national_admin') {
    // For national admin, get churches where they are the nationalAdminId
    const churches = await prisma.church.findMany({ 
      where: { nationalAdminId: userId },
      select: { id: true } 
    });
    churchIds = churches.map(c => c.id);
  } else {
    // For other roles, use the existing churchScope logic
    if (!churchId) { 
      res.status(400).json({ success: false, message: 'churchId required for this role' }); 
      return; 
    }
    churchIds = await getAccessibleChurchIds(roleName, churchId, req.user?.districts, req.user?.traditionalAuthorities, req.user?.regions, userId);
  }

  const [members, events, donations, attendance] = await Promise.all([
    prisma.member.findMany({ where: { churchId: { in: churchIds } } }),
    prisma.event.findMany({ where: { churchId: { in: churchIds } } }),
    prisma.donation.findMany({ where: { churchId: { in: churchIds } } }),
    prisma.attendance.findMany({ where: { churchId: { in: churchIds } } }),
  ]);

  const totalChurches = churchIds.length;

  const completedDonations = donations.filter(d => d.status === 'completed');
  const completedAmount = completedDonations.reduce((sum, d) => sum + d.amount, 0);

  const avgAttendance = attendance.length
    ? Math.round(attendance.reduce((sum, a) => sum + a.totalAttendees, 0) / attendance.length)
    : 0;

  const activeMembers = members.filter(m => m.status === 'active').length;

  res.json({
    success: true,
    data: {
      totalMembers: members.length,
      activeMembers,
      totalChurches,
      totalDonations: completedAmount,
      totalDonationRecords: donations.length,
      totalEvents: events.length,
      upcomingEvents: events.filter(e => e.status === 'upcoming').length,
      recentDonationAmount: completedAmount,
      averageAttendance: avgAttendance,
      memberGrowth: 12.5,
      donationGrowth: 8.3,
    },
  });
}
