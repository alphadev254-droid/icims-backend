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

  if (roleName === 'ministry_admin') {
    // Use getAccessibleChurchIds consistently for all roles
    churchIds = await getAccessibleChurchIds(
      roleName,
      churchId,
      req.user?.districts,
      req.user?.traditionalAuthorities,
      req.user?.regions,
      userId
    );
  } else {
    // For sub-admin roles (district_admin, branch_admin, regional_admin):
    // churchId in JWT is null — they oversee multiple churches.
    // Use getAccessibleChurchIds which resolves via ministryAdminId + scope fields.
    churchIds = await getAccessibleChurchIds(
      roleName,
      churchId,
      req.user?.districts,
      req.user?.traditionalAuthorities,
      req.user?.regions,
      userId
    );

    if (churchIds.length === 0) {
      // No churches in scope yet — return empty stats rather than 400
      res.json({
        success: true,
        data: {
          totalMembers: 0, activeMembers: 0, totalChurches: 0,
          totalDonations: 0, upcomingEvents: 0, averageAttendance: 0,
          memberGrowth: 0, donationGrowth: 0, totalNewVisitors: 0,
          retentionRate: 0, attendanceRate: 0, newMembersThisMonth: 0,
          weeklyAttendance: [], monthlyGiving: [],
        },
      });
      return;
    }
  }

  const now = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const twoMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [
    totalMembers,
    activeMembers,
    newMembersThisMonth,
    prevMonthUsers,
    events,
    donations,
    lastMonthDonations,
    prevMonthDonations,
    attendance,
    visitorsAggregate,
  ] = await Promise.all([
    // Member counts — aggregates instead of fetching all rows
    prisma.user.count({ where: { churchId: { in: churchIds } } }),
    prisma.user.count({ where: { churchId: { in: churchIds }, status: 'active' } }),
    prisma.user.count({ where: { churchId: { in: churchIds }, createdAt: { gte: lastMonth, lt: now } } }),
    prisma.user.count({ where: { churchId: { in: churchIds }, createdAt: { gte: twoMonthsAgo, lt: lastMonth } } }),
    // Events — only need status + count, use select
    prisma.event.findMany({
      where: { churchId: { in: churchIds } },
      select: { status: true },
    }),
    // All-time donations for total + monthly breakdown
    prisma.donationTransaction.findMany({
      where: { churchId: { in: churchIds }, status: 'completed' },
      select: { amount: true, createdAt: true },
    }),
    // Last month donations aggregate
    prisma.donationTransaction.aggregate({
      where: { churchId: { in: churchIds }, status: 'completed', createdAt: { gte: lastMonth, lt: startOfThisMonth } },
      _sum: { amount: true },
    }),
    // Previous month donations aggregate
    prisma.donationTransaction.aggregate({
      where: { churchId: { in: churchIds }, status: 'completed', createdAt: { gte: twoMonthsAgo, lt: lastMonth } },
      _sum: { amount: true },
    }),
    // Attendance — last 12 records for charts only
    prisma.attendance.findMany({
      where: { churchId: { in: churchIds } },
      select: { totalAttendees: true, date: true, newVisitors: true },
      orderBy: { date: 'desc' },
      take: 12,
    }),
    // All-time new visitors total — separate aggregate, not limited to 12
    prisma.attendance.aggregate({
      where: { churchId: { in: churchIds } },
      _sum: { newVisitors: true },
    }),
  ]);

  const totalChurches = churchIds.length;
  const totalDonations = donations.reduce((sum, d) => sum + d.amount, 0);
  const avgAttendance = attendance.length
    ? Math.round(attendance.reduce((sum, a) => sum + a.totalAttendees, 0) / attendance.length)
    : 0;

  // Estimate member-only attendance by subtracting new visitors from total attendees.
  // totalAttendees includes visitors/guests, so totalAttendees - newVisitors gives a
  // rough count of members + returning visitors who attended.
  const avgMemberAttendance = attendance.length
    ? Math.round(attendance.reduce((sum, a) => sum + Math.max(0, a.totalAttendees - a.newVisitors), 0) / attendance.length)
    : 0;

  // Growth rates from pre-aggregated counts
  const memberGrowth = prevMonthUsers > 0
    ? Number(((newMembersThisMonth - prevMonthUsers) / prevMonthUsers * 100).toFixed(1))
    : 0;

  const lastMonthTotal = lastMonthDonations._sum.amount ?? 0;
  const prevMonthTotal = prevMonthDonations._sum.amount ?? 0;
  const donationGrowth = prevMonthTotal > 0
    ? Number(((lastMonthTotal - prevMonthTotal) / prevMonthTotal * 100).toFixed(1))
    : 0;

  const totalNewVisitors = visitorsAggregate._sum.newVisitors ?? 0;
  const retentionRate = totalMembers > 0 ? Number(((activeMembers / totalMembers) * 100).toFixed(1)) : 0;
  const attendanceRate = totalMembers > 0
    ? Number(Math.min(100, ((avgMemberAttendance / totalMembers) * 100)).toFixed(1))
    : 0;

  // Weekly attendance (last 4 records)
  const weeklyAttendance = attendance.slice(0, 4).reverse().map((a, idx) => ({
    week: `Week ${idx + 1}`,
    attendees: a.totalAttendees,
    date: a.date,
  }));

  // Monthly giving (last 6 months)
  const monthlyGiving: { month: string; amount: number }[] = [];
  for (let i = 5; i >= 0; i--) {
    const monthDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const nextMonth = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    const monthName = monthDate.toLocaleDateString('en-US', { month: 'short' });
    const monthTotal = donations
      .filter(d => {
        const dDate = new Date(d.createdAt);
        return dDate >= monthDate && dDate < nextMonth;
      })
      .reduce((sum, d) => sum + d.amount, 0);
    monthlyGiving.push({ month: monthName, amount: Math.round(monthTotal) });
  }

  // Determine currency from account country
  const accountCountry = req.user?.accountCountry || 'Malawi';
  const currency = accountCountry === 'Kenya' ? 'KES' : 'MWK';

  res.json({
    success: true,
    data: {
      currency,
      totalMembers,
      activeMembers,
      totalChurches,
      totalDonations,
      upcomingEvents: events.filter(e => e.status === 'upcoming').length,
      averageAttendance: avgAttendance,
      memberGrowth,
      donationGrowth,
      totalNewVisitors,
      retentionRate,
      attendanceRate,
      newMembersThisMonth,
      weeklyAttendance,
      monthlyGiving,
    },
  });
}
