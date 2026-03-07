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

  if (roleName === 'member') {
    // Members see stats only for their church
    if (!churchId) {
      res.status(400).json({ success: false, message: 'No church assigned' });
      return;
    }
    churchIds = [churchId];

    // Get member-specific data
    const [myDonations, churchEvents] = await Promise.all([
      prisma.donationTransaction.findMany({ where: { userId } }),
      prisma.event.findMany({ where: { churchId } }),
    ]);

    const myTotalDonations = myDonations.filter(d => d.status === 'completed').reduce((sum, d) => sum + d.amount, 0);

    res.json({
      success: true,
      data: {
        myTotalDonations,
        myDonationRecords: myDonations.length,
        upcomingEvents: churchEvents.filter(e => e.status === 'upcoming').length,
        totalEvents: churchEvents.length,
      },
    });
    return;
  }

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

  const [users, events, donations, attendance] = await Promise.all([
    prisma.user.findMany({ where: { churchId: { in: churchIds } } }),
    prisma.event.findMany({ where: { churchId: { in: churchIds } } }),
    prisma.donationTransaction.findMany({ where: { churchId: { in: churchIds } } }),
    prisma.attendance.findMany({ where: { churchId: { in: churchIds } } }),
  ]);

  const totalChurches = churchIds.length;

  const completedDonations = donations.filter(d => d.status === 'completed');
  const completedAmount = completedDonations.reduce((sum, d) => sum + d.amount, 0);

  const avgAttendance = attendance.length
    ? Math.round(attendance.reduce((sum, a) => sum + a.totalAttendees, 0) / attendance.length)
    : 0;

  const activeMembers = users.filter(u => u.status === 'active').length;

  res.json({
    success: true,
    data: {
      totalMembers: users.length,
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
