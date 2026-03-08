import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { getAccessibleChurchIds } from '../lib/churchScope';

const createKPISchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  category: z.enum(['Attendance', 'Giving', 'Membership', 'Events']),
  metricType: z.string(),
  targetValue: z.number().positive(),
  unit: z.string(),
  period: z.enum(['monthly', 'quarterly', 'yearly']),
  startDate: z.string(),
  endDate: z.string(),
  churchId: z.string().min(1),
});

const updateKPISchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  targetValue: z.number().positive().optional(),
  status: z.enum(['active', 'completed', 'cancelled']).optional(),
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

      // Get nationalAdminId from the church
      const church = await prisma.church.findUnique({
        where: { id: data.churchId },
        select: { nationalAdminId: true },
      });

      if (!church?.nationalAdminId) {
        res.status(400).json({ error: 'Church has no national admin' });
        return;
      }

      const kpi = await prisma.kPI.create({
        data: {
          ...data,
          startDate: new Date(data.startDate),
          endDate: new Date(data.endDate),
          nationalAdminId: church.nationalAdminId,
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
      const { id } = req.params;
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
      const { id } = req.params;
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

      const updated = await prisma.kPI.update({
        where: { id },
        data,
        include: { church: { select: { id: true, name: true } } },
      });

      res.json(updated);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  },

  async delete(req: Request, res: Response) {
    try {
      const { id } = req.params;
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

      for (const kpi of kpis) {
        let currentValue = 0;

        try {
          switch (kpi.metricType) {
            case 'total_attendance':
              const attendance = await prisma.attendance.aggregate({
                where: {
                  churchId: kpi.churchId,
                  date: { gte: kpi.startDate, lte: kpi.endDate },
                },
                _sum: { totalAttendees: true },
              });
              currentValue = attendance._sum.totalAttendees || 0;
              break;

            case 'average_attendance':
              const avgAttendance = await prisma.attendance.aggregate({
                where: {
                  churchId: kpi.churchId,
                  date: { gte: kpi.startDate, lte: kpi.endDate },
                },
                _avg: { totalAttendees: true },
              });
              currentValue = Math.round(avgAttendance._avg.totalAttendees || 0);
              break;

            case 'total_giving':
              const donations = await prisma.donationTransaction.aggregate({
                where: {
                  churchId: kpi.churchId,
                  status: 'completed',
                  createdAt: { gte: kpi.startDate, lte: kpi.endDate },
                },
                _sum: { amount: true },
              });
              currentValue = donations._sum.amount || 0;
              break;

            case 'new_members':
              const memberRole = await prisma.role.findUnique({ where: { name: 'member' } });
              const members = await prisma.user.count({
                where: {
                  churchId: kpi.churchId,
                  roleId: memberRole?.id,
                  status: 'active',
                  createdAt: { gte: kpi.startDate, lte: kpi.endDate },
                },
              });
              currentValue = members;
              break;

            case 'event_count':
              const events = await prisma.event.count({
                where: {
                  churchId: kpi.churchId,
                  date: { gte: kpi.startDate, lte: kpi.endDate },
                },
              });
              currentValue = events;
              break;

            case 'total_members':
              const memberRole2 = await prisma.role.findUnique({ where: { name: 'member' } });
              const totalMembers = await prisma.user.count({
                where: { 
                  churchId: kpi.churchId, 
                  roleId: memberRole2?.id,
                  status: 'active' 
                },
              });
              currentValue = totalMembers;
              break;

            case 'new_visitors':
              const visitors = await prisma.attendance.aggregate({
                where: {
                  churchId: kpi.churchId,
                  date: { gte: kpi.startDate, lte: kpi.endDate },
                },
                _sum: { newVisitors: true },
              });
              currentValue = visitors._sum.newVisitors || 0;
              break;
          }

          await prisma.kPI.update({
            where: { id: kpi.id },
            data: { currentValue },
          });
        } catch (error) {
          console.error(`Failed to calculate KPI ${kpi.id}:`, error);
        }
      }

      res.json({ message: 'KPIs calculated successfully' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  },
};
