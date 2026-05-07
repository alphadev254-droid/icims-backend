import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { getAccessibleChurchIds } from '../lib/churchScope';

const createKPISchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  category: z.enum(['Attendance', 'Giving', 'Membership', 'Events']),
  metricType: z.string(),
  attendanceType: z.enum(['regular', 'event']).optional(),
  eventId: z.string().optional(),
  targetValue: z.number().positive(),
  unit: z.string(),
  period: z.enum(['monthly', 'quarterly', 'yearly']),
  startDate: z.string(),
  endDate: z.string(),
  churchId: z.string().min(1),
  isRecurring: z.boolean().optional().default(false),
});

const updateKPISchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  category: z.enum(['Attendance', 'Giving', 'Membership', 'Events']).optional(),
  metricType: z.string().optional(),
  attendanceType: z.enum(['regular', 'event']).optional(),
  eventId: z.string().optional(),
  targetValue: z.number().positive().optional(),
  unit: z.string().optional(),
  period: z.enum(['monthly', 'quarterly', 'yearly']).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  churchId: z.string().optional(),
  status: z.enum(['active', 'completed', 'cancelled']).optional(),
  recurringActive: z.boolean().optional(),
});

export const kpiController = {
  async create(req: Request, res: Response) {
    try {
      const data = createKPISchema.parse(req.body);
      const user = (req as any).user;
      const userId = user.userId;
      const role = user.role;

      // Get accessible churches for this user
      const accessibleChurchIds = await getAccessibleChurchIds(
        role,
        user.churchId,
        user.districts,
        user.traditionalAuthorities,
        user.regions,
        userId
      );

      // Verify user has access to the selected church
      if (!accessibleChurchIds.includes(data.churchId)) {
        res.status(403).json({ error: 'Access denied to this church' });
        return;
      }

      // Get ministryAdminId from the church
      const church = await prisma.church.findUnique({
        where: { id: data.churchId },
        select: { ministryAdminId: true },
      });

      if (!church?.ministryAdminId) {
        res.status(400).json({ error: 'Church has no national admin' });
        return;
      }

      const kpi = await prisma.kPI.create({
        data: {
          ...data,
          startDate: new Date(data.startDate),
          endDate: new Date(data.endDate),
          ministryAdminId: church.ministryAdminId,
        },
        include: { church: { select: { id: true, name: true } } },
      });

      res.json(kpi);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  },

  async getAll(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const userId = user.userId;
      const role = user.role;
      const { churchId, category, status, period } = req.query;

      // Get accessible churches for this user
      const accessibleChurchIds = await getAccessibleChurchIds(
        role,
        user.churchId,
        user.districts,
        user.traditionalAuthorities,
        user.regions,
        userId
      );

      const where: any = { churchId: { in: accessibleChurchIds } };
      if (churchId) where.churchId = churchId as string;
      if (category) where.category = category as string;
      if (status) where.status = status as string;
      if (period) where.period = period as string;

      const kpis = await prisma.kPI.findMany({
        where,
        include: { church: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
      });

      res.json(kpis);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  },

  async getById(req: Request, res: Response) {
    try {
      const id = req.params.id as string;
      const user = (req as any).user;
      const userId = user.userId;
      const role = user.role;

      // Get accessible churches
      const accessibleChurchIds = await getAccessibleChurchIds(
        role,
        user.churchId,
        user.districts,
        user.traditionalAuthorities,
        user.regions,
        userId
      );

      const kpi = await prisma.kPI.findFirst({
        where: { id, churchId: { in: accessibleChurchIds } },
        include: { church: { select: { id: true, name: true } } },
      });

      if (!kpi) return res.status(404).json({ error: 'KPI not found' });
      res.json(kpi);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  },

  async update(req: Request, res: Response) {
    try {
      const id = req.params.id as string;
      const data = updateKPISchema.parse(req.body);
      const user = (req as any).user;
      const userId = user.userId;
      const role = user.role;

      // Get accessible churches
      const accessibleChurchIds = await getAccessibleChurchIds(
        role,
        user.churchId,
        user.districts,
        user.traditionalAuthorities,
        user.regions,
        userId
      );

      const kpi = await prisma.kPI.findFirst({
        where: { id, churchId: { in: accessibleChurchIds } },
      });

      if (!kpi) return res.status(404).json({ error: 'KPI not found' });

      // PROTECTION: Prevent editing completed KPIs
      if (kpi.status === 'completed') {
        res.status(400).json({ error: 'Cannot edit completed KPI. This KPI period has ended.' });
        return;
      }

      // PROTECTION: Prevent editing if end date has passed
      if (new Date(kpi.endDate) < new Date()) {
        res.status(400).json({ error: 'Cannot edit KPI. The end date has passed.' });
        return;
      }

      // If churchId is being updated, verify access
      if (data.churchId && !accessibleChurchIds.includes(data.churchId)) {
        res.status(403).json({ error: 'Access denied to target church' });
        return;
      }

      const updateData: any = { ...data };
      if (data.startDate) updateData.startDate = new Date(data.startDate);
      if (data.endDate) updateData.endDate = new Date(data.endDate);

      const updated = await prisma.kPI.update({
        where: { id },
        data: updateData,
        include: { church: { select: { id: true, name: true } } },
      });

      res.json(updated);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  },

  async delete(req: Request, res: Response) {
    try {
      const id = req.params.id as string;
      const user = (req as any).user;
      const userId = user.userId;
      const role = user.role;

      // Get accessible churches
      const accessibleChurchIds = await getAccessibleChurchIds(
        role,
        user.churchId,
        user.districts,
        user.traditionalAuthorities,
        user.regions,
        userId
      );

      const kpi = await prisma.kPI.findFirst({
        where: { id, churchId: { in: accessibleChurchIds } },
      });

      if (!kpi) return res.status(404).json({ error: 'KPI not found' });

      await prisma.kPI.delete({ where: { id } });
      res.json({ message: 'KPI deleted' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  },

  async calculate(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const userId = user.userId;
      const role = user.role;

      // Get accessible churches
      const accessibleChurchIds = await getAccessibleChurchIds(
        role,
        user.churchId,
        user.districts,
        user.traditionalAuthorities,
        user.regions,
        userId
      );

      const kpis = await prisma.kPI.findMany({
        where: { churchId: { in: accessibleChurchIds }, status: 'active' },
      });

      if (kpis.length === 0) {
        res.json({ message: 'No active KPIs to calculate' });
        return;
      }

      // Cache member role lookup once
      const memberRole = await prisma.role.findUnique({ where: { name: 'member' } });
      const memberRoleId = memberRole?.id;

      // Group KPIs by churchId + metricType to batch DB queries
      // Instead of N queries for N KPIs, we run one query per unique (churchId, metricType) combo
      type MetricKey = string; // `${churchId}:${metricType}:${attendanceType}:${eventId}`
      const metricCache = new Map<MetricKey, number>();

      const getMetricKey = (kpi: typeof kpis[0]) =>
        `${kpi.churchId}:${kpi.metricType}:${kpi.attendanceType ?? ''}:${kpi.eventId ?? ''}:${kpi.startDate.toISOString()}:${kpi.endDate.toISOString()}`;

      // Collect all unique metric computations needed
      const uniqueMetrics = new Map<MetricKey, typeof kpis[0]>();
      for (const kpi of kpis) {
        uniqueMetrics.set(getMetricKey(kpi), kpi);
      }

      // Compute each unique metric once
      await Promise.all(
        Array.from(uniqueMetrics.entries()).map(async ([key, kpi]) => {
          let currentValue = 0;
          try {
            switch (kpi.metricType) {
              case 'total_attendance': {
                const whereClause: any = {
                  churchId: kpi.churchId,
                  date: { gte: kpi.startDate, lte: kpi.endDate },
                };
                if (kpi.attendanceType === 'regular') whereClause.eventId = null;
                else if (kpi.attendanceType === 'event') {
                  whereClause.eventId = kpi.eventId ? kpi.eventId : { not: null };
                }
                const result = await prisma.attendance.aggregate({ where: whereClause, _sum: { totalAttendees: true } });
                currentValue = result._sum.totalAttendees ?? 0;
                break;
              }
              case 'average_attendance': {
                const whereClause: any = {
                  churchId: kpi.churchId,
                  date: { gte: kpi.startDate, lte: kpi.endDate },
                };
                if (kpi.attendanceType === 'regular') whereClause.eventId = null;
                else if (kpi.attendanceType === 'event') {
                  whereClause.eventId = kpi.eventId ? kpi.eventId : { not: null };
                }
                const result = await prisma.attendance.aggregate({ where: whereClause, _avg: { totalAttendees: true } });
                currentValue = Math.round(result._avg.totalAttendees ?? 0);
                break;
              }
              case 'total_giving': {
                const result = await prisma.donationTransaction.aggregate({
                  where: { churchId: kpi.churchId, status: 'completed', createdAt: { gte: kpi.startDate, lte: kpi.endDate } },
                  _sum: { amount: true },
                });
                currentValue = result._sum.amount ?? 0;
                break;
              }
              case 'new_members': {
                if (memberRoleId) {
                  currentValue = await prisma.user.count({
                    where: { churchId: kpi.churchId, roleId: memberRoleId, status: 'active', createdAt: { gte: kpi.startDate, lte: kpi.endDate } },
                  });
                }
                break;
              }
              case 'event_count': {
                currentValue = await prisma.event.count({
                  where: { churchId: kpi.churchId, date: { gte: kpi.startDate, lte: kpi.endDate } },
                });
                break;
              }
              case 'total_members': {
                if (memberRoleId) {
                  currentValue = await prisma.user.count({
                    where: { churchId: kpi.churchId, roleId: memberRoleId, status: 'active' },
                  });
                }
                break;
              }
              case 'new_visitors': {
                const result = await prisma.attendance.aggregate({
                  where: { churchId: kpi.churchId, date: { gte: kpi.startDate, lte: kpi.endDate } },
                  _sum: { newVisitors: true },
                });
                currentValue = result._sum.newVisitors ?? 0;
                break;
              }
            }
            metricCache.set(key, currentValue);
          } catch (error) {
            console.error(`Failed to calculate metric ${key}:`, error);
          }
        })
      );

      // Batch update all KPIs in parallel using cached values
      await Promise.all(
        kpis.map(kpi => {
          const key = getMetricKey(kpi);
          const currentValue = metricCache.get(key) ?? 0;
          return prisma.kPI.update({ where: { id: kpi.id }, data: { currentValue } });
        })
      );

      res.json({ message: 'KPIs calculated successfully' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  },
};
