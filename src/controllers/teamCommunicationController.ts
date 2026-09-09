import { Request, Response } from 'express';
import { Prisma, PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';
import { getAccessibleChurchIds } from '../lib/churchScope';
import { groupByDateRanges } from '../lib/dateGrouping';
import { assertScheduleAccess, hasRecurringRule } from '../lib/scheduleAccess';
import {
  deleteScheduledEventForSource,
  getRecurrenceRulesById,
  parseRecurrenceRuleForApi,
  type RecurrenceRuleInput,
  saveRecurrenceRule,
  syncTeamCommunicationToSchedule,
} from '../services/schedulerService';

const prisma = new PrismaClient();

function parseOptionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRecurrenceRuleBody(value: unknown): RecurrenceRuleInput {
  if (!value) return null;
  let raw = value;
  if (typeof value === 'string') {
    try {
      raw = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const rule = raw as Record<string, unknown>;
  return {
    frequency: typeof rule.frequency === 'string' ? rule.frequency : null,
    interval: parseOptionalNumber(rule.interval),
    daysOfWeek: Array.isArray(rule.daysOfWeek) ? rule.daysOfWeek.filter((day): day is string => typeof day === 'string') : null,
    dayOfMonth: parseOptionalNumber(rule.dayOfMonth),
    monthOfYear: parseOptionalNumber(rule.monthOfYear),
    startsAt: typeof rule.startsAt === 'string' ? rule.startsAt : null,
    endsAt: typeof rule.endsAt === 'string' ? rule.endsAt : null,
    count: parseOptionalNumber(rule.count),
  };
}

async function attachTeamCommunicationSchedules<T extends Array<{ id: string }>>(communications: T): Promise<Array<T[number] & { scheduledEvent: any | null }>> {
  const ids = communications.map(item => item.id);
  if (ids.length === 0) return communications.map(item => ({ ...item, scheduledEvent: null }));

  const rows = await prisma.$queryRaw<Array<{
    sourceId: string;
    startAt: Date;
    endAt: Date;
    status: string;
    timezone: string;
    recurrenceRuleId: string | null;
  }>>`
    SELECT sourceId, startAt, endAt, status, timezone, recurrenceRuleId
    FROM scheduled_events
    WHERE sourceModule = 'team_communications' AND sourceId IN (${Prisma.join(ids)})
  `;
  const recurrenceRulesById = await getRecurrenceRulesById(rows.map(row => row.recurrenceRuleId).filter((id): id is string => Boolean(id)));
  const schedulesBySourceId = new Map(rows.map(row => [row.sourceId, row]));

  return communications.map(item => {
    const schedule = schedulesBySourceId.get(item.id);
    return {
      ...item,
      scheduledEvent: schedule
        ? {
          startAt: schedule.startAt,
          endAt: schedule.endAt,
          status: schedule.status,
          timezone: schedule.timezone,
          recurrenceRuleId: schedule.recurrenceRuleId,
          recurrenceRule: schedule.recurrenceRuleId ? parseRecurrenceRuleForApi(recurrenceRulesById.get(schedule.recurrenceRuleId)) : null,
        }
        : null,
    };
  });
}

// Get all communications for user's teams
export const getTeamCommunications = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    const { teamId } = req.query;

    // Get user with role
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { role: true }
    });

    if (!user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const isAdmin = !!user.role && user.role.name !== 'member';

    let teamIds: string[] = [];
    let leaderTeamIds: string[] = [];

    console.log('User role:', user.role?.name ,'Is admin:', isAdmin);

    if (isAdmin) {
      // For admins, get teams from accessible churches
      const districts = user.districts ? JSON.parse(user.districts) : undefined;
      const tas = user.traditionalAuthorities ? JSON.parse(user.traditionalAuthorities) : undefined;
      const regions = user.regions ? JSON.parse(user.regions) : undefined;
      
      const accessibleChurchIds = await getAccessibleChurchIds(
        user.role!.name,
        user.churchId,
        districts,
        tas,
        regions,
        userId
      );

      console.log('Accessible church IDs for user:', accessibleChurchIds);

      const teams = await prisma.team.findMany({
        where: { churchId: { in: accessibleChurchIds } },
        select: { id: true }
      });

      teamIds = teams.map(t => t.id);

      // Also get teams where user is leader
      const userTeams = await prisma.userTeam.findMany({
        where: { userId, isLeader: true },
        select: { teamId: true }
      });
      leaderTeamIds = userTeams.map(ut => ut.teamId);
    } else {
      // For members, only get teams they belong to
      const userTeams = await prisma.userTeam.findMany({
        where: { userId },
        select: { teamId: true, isLeader: true }
      });

      teamIds = userTeams.map(ut => ut.teamId);
      leaderTeamIds = userTeams.filter(ut => ut.isLeader).map(ut => ut.teamId);
    }

    // If specific team requested, validate access
    if (teamId && !teamIds.includes(teamId as string)) {
      return res.status(403).json({ error: 'Access denied to this team' });
    }

    const communications = await prisma.teamCommunication.findMany({
      where: teamId ? { teamId: teamId as string } : { teamId: { in: teamIds } },
      include: {
        team: {
          select: { id: true, name: true, color: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    // Get author details
    const authorIds = [...new Set(communications.map(c => c.authorId))];
    const authors = await prisma.user.findMany({
      where: { id: { in: authorIds } },
      select: { id: true, firstName: true, lastName: true, avatar: true }
    });

    const authorsMap = Object.fromEntries(authors.map(a => [a.id, a]));

    // Get accessible churches for edit permission check
    let accessibleChurchIds: string[] = [];
    if (isAdmin) {
      const districts = user.districts ? JSON.parse(user.districts) : undefined;
      const tas = user.traditionalAuthorities ? JSON.parse(user.traditionalAuthorities) : undefined;
      const regions = user.regions ? JSON.parse(user.regions) : undefined;
      
      accessibleChurchIds = await getAccessibleChurchIds(
        user.role!.name,
        user.churchId,
        districts,
        tas,
        regions,
        userId
      );
    }

    const result = await Promise.all(communications.map(async c => {
      let canEdit = false;
      
      // Team leader can edit
      if (leaderTeamIds.includes(c.teamId)) {
        canEdit = true;
      }
      // Admin with scope can edit
      else if (isAdmin && accessibleChurchIds.length > 0) {
        const team = await prisma.team.findUnique({
          where: { id: c.teamId },
          select: { churchId: true }
        });
        if (team && accessibleChurchIds.includes(team.churchId)) {
          canEdit = true;
        }
      }

      return {
        ...c,
        author: authorsMap[c.authorId],
        canEdit
      };
    }));

    const resultWithSchedules = await attachTeamCommunicationSchedules(result);
    const visibleResult = isAdmin
      ? resultWithSchedules
      : resultWithSchedules.filter(post => post.canEdit || !post.scheduledEvent || post.scheduledEvent.status === 'completed');

    // Group by date ranges
    const grouped = groupByDateRanges(visibleResult);

    res.json(grouped);
  } catch (error: any) {
    console.error('Get team communications error:', error);
    res.status(500).json({ error: 'Failed to fetch communications' });
  }
};

// Create communication with file uploads
export const createTeamCommunication = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    const { title, content, teamId, deliveryMode, scheduledAt } = req.body;
    const recurrenceRule = parseRecurrenceRuleBody(req.body.recurrenceRule);
    const mode = ['now', 'scheduled'].includes(String(deliveryMode)) ? String(deliveryMode) : 'now';
    const files = req.files as Express.Multer.File[];

    if (!title || !content || !teamId) {
      return res.status(400).json({ error: 'Title, content, and teamId are required' });
    }

    // Check if user can post to this team
    const canPost = await canUserPostToTeam(userId!, teamId);
    if (!canPost) {
      return res.status(403).json({ error: 'You do not have permission to post to this team' });
    }

    if (mode !== 'scheduled' && hasRecurringRule(recurrenceRule)) {
      return res.status(400).json({ error: 'Recurrence is only available when delivery mode is Schedule.' });
    }

    if (mode === 'scheduled') {
      if (!scheduledAt) {
        return res.status(400).json({ error: 'Scheduled date and time required' });
      }
      const scheduleAccess = await assertScheduleAccess(req, recurrenceRule, 'create');
      if (!scheduleAccess.allowed) {
        return res.status(403).json({ error: scheduleAccess.message });
      }
    }

    // Process uploaded files
    const mediaUrls = files ? files.map(file => {
      // Extract just the filename from the full path
      const filename = file.filename;
      return {
        url: `/uploads/communication/${filename}`,
        type: file.mimetype,
        name: file.originalname,
        size: file.size
      };
    }) : [];

    const communication = await prisma.teamCommunication.create({
      data: {
        title,
        content,
        teamId,
        authorId: userId!,
        mediaUrls: mediaUrls.length > 0 ? mediaUrls : []
      },
      include: {
        team: {
          include: {
            church: { select: { name: true, ministryAdminId: true } },
            members: {
              include: {
                user: { select: { id: true, firstName: true, email: true } }
              }
            }
          }
        }
      }
    });

    const author = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, firstName: true, lastName: true, avatar: true }
    });

    const startAt = mode === 'scheduled' ? new Date(scheduledAt) : new Date();
    const recurrenceRuleId = mode === 'scheduled'
      ? await saveRecurrenceRule(recurrenceRule ?? null, startAt)
      : null;
    await syncTeamCommunicationToSchedule({
      ...communication,
      scheduledAt: startAt,
      recurrenceRuleId,
    });

    const [communicationWithSchedule] = await attachTeamCommunicationSchedules([
      { ...communication, author, team: { id: communication.team.id, name: communication.team.name, color: communication.team.color } },
    ]);
    res.status(201).json(communicationWithSchedule);
  } catch (error: any) {
    console.error('Create team communication error:', error);
    res.status(500).json({ error: 'Failed to create communication' });
  }
};

// Update communication
export const updateTeamCommunication = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    const { id } = req.params;
    const { title, content, deliveryMode, scheduledAt } = req.body;
    const recurrenceRule = parseRecurrenceRuleBody(req.body.recurrenceRule);
    const mode = deliveryMode && ['now', 'scheduled'].includes(String(deliveryMode)) ? String(deliveryMode) : undefined;
    const files = req.files as Express.Multer.File[];
    let existingMediaUrls = req.body.existingMediaUrls;

    // Parse existingMediaUrls if it's a string
    if (typeof existingMediaUrls === 'string') {
      try {
        existingMediaUrls = JSON.parse(existingMediaUrls);
      } catch {
        existingMediaUrls = [];
      }
    }

    const existing = await prisma.teamCommunication.findUnique({
      where: { id: String(id) }
    });

    if (!existing) {
      return res.status(404).json({ error: 'Communication not found' });
    }

    // Check if user can update (team leader or admin with scope)
    const canUpdate = await canUserEditOrDelete(userId!, existing.teamId, existing.authorId);
    if (!canUpdate) {
      return res.status(403).json({ error: 'Permission denied' });
    }

    if (mode !== 'scheduled' && hasRecurringRule(recurrenceRule)) {
      return res.status(400).json({ error: 'Recurrence is only available when delivery mode is Schedule.' });
    }

    // Delete removed media files from server
    if (existing.mediaUrls && Array.isArray(existing.mediaUrls)) {
      const existingUrls = (existing.mediaUrls as any[]).map(m => m.url);
      const keptUrls = (existingMediaUrls || []).map((m: any) => m.url);
      const removedUrls = existingUrls.filter(url => !keptUrls.includes(url));
      
      removedUrls.forEach(url => {
        const filePath = path.join(process.cwd(), url.replace('/uploads/', 'uploads/'));
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      });
    }

    // Process new uploaded files
    const newMediaUrls = files ? files.map(file => {
      const filename = file.filename;
      return {
        url: `/uploads/communication/${filename}`,
        type: file.mimetype,
        name: file.originalname,
        size: file.size
      };
    }) : [];

    // Combine existing and new media
    const allMediaUrls = [...(existingMediaUrls || []), ...newMediaUrls];

    const communication = await prisma.teamCommunication.update({
      where: { id: String(id) },
      data: {
        title: title || existing.title,
        content: content || existing.content,
        mediaUrls: allMediaUrls.length > 0 ? allMediaUrls : []
      },
      include: {
        team: {
          select: { id: true, name: true, color: true, churchId: true, church: { select: { ministryAdminId: true } } }
        }
      }
    });

    const author = await prisma.user.findUnique({
      where: { id: communication.authorId },
      select: { id: true, firstName: true, lastName: true, avatar: true }
    });

    const existingSchedule = await prisma.$queryRaw<Array<{ recurrenceRuleId: string | null }>>`
      SELECT recurrenceRuleId
      FROM scheduled_events
      WHERE sourceModule = 'team_communications' AND sourceId = ${String(id)}
      LIMIT 1
    `;

    if (mode === 'scheduled') {
      if (!scheduledAt) {
        return res.status(400).json({ error: 'Scheduled date and time required' });
      }
      const scheduleAction = existingSchedule.length > 0 ? 'update' : 'create';
      const scheduleAccess = await assertScheduleAccess(req, recurrenceRule, scheduleAction);
      if (!scheduleAccess.allowed) {
        return res.status(403).json({ error: scheduleAccess.message });
      }

      const startAt = new Date(scheduledAt);
      const recurrenceRuleId = await saveRecurrenceRule(recurrenceRule ?? null, startAt, existingSchedule[0]?.recurrenceRuleId);
      await syncTeamCommunicationToSchedule({
        ...communication,
        scheduledAt: startAt,
        recurrenceRuleId,
      });
    } else if (mode === 'now') {
      if (existingSchedule.length > 0) {
        const scheduleAccess = await assertScheduleAccess(req, null, 'update');
        if (!scheduleAccess.allowed) {
          return res.status(403).json({ error: scheduleAccess.message });
        }
      }
      await syncTeamCommunicationToSchedule({
        ...communication,
        scheduledAt: new Date(),
        recurrenceRuleId: null,
      });
    }

    const [communicationWithSchedule] = await attachTeamCommunicationSchedules([{ ...communication, author }]);
    res.json(communicationWithSchedule);
  } catch (error: any) {
    console.error('Update team communication error:', error);
    res.status(500).json({ error: 'Failed to update communication' });
  }
};

// Delete communication
export const deleteTeamCommunication = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    const { id } = req.params;

    const existing = await prisma.teamCommunication.findUnique({
      where: { id: String(id) }
    });

    if (!existing) {
      return res.status(404).json({ error: 'Communication not found' });
    }

    // Check if user can delete (team leader or admin with scope)
    const canDelete = await canUserEditOrDelete(userId!, existing.teamId, existing.authorId);
    if (!canDelete) {
      return res.status(403).json({ error: 'Permission denied' });
    }

    // Delete media files from server
    if (existing.mediaUrls && Array.isArray(existing.mediaUrls)) {
      (existing.mediaUrls as any[]).forEach(media => {
        const filePath = path.join(process.cwd(), media.url.replace('/uploads/', 'uploads/'));
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      });
    }

    await deleteScheduledEventForSource('team_communications', String(id));

    await prisma.teamCommunication.delete({
      where: { id: String(id) }
    });

    res.json({ message: 'Communication deleted' });
  } catch (error: any) {
    console.error('Delete team communication error:', error);
    res.status(500).json({ error: 'Failed to delete communication' });
  }
};

// Get teams where user can post (leaders or admins)
export const getPostableTeams = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        role: true,
        teams: {
          where: { isLeader: true },
          include: {
            team: {
              include: { church: true }
            }
          }
        }
      }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    let teams: any[] = [];

    // Get teams where user is leader
    const leaderTeams = user.teams.map(ut => ({
      id: ut.team.id,
      name: ut.team.name,
      color: ut.team.color,
      church: { id: ut.team.church.id, name: ut.team.church.name }
    }));

    teams = [...leaderTeams];

    // If admin role, get teams in their scope
    if (user.role && user.role.name !== 'member') {
      const districts = user.districts ? JSON.parse(user.districts) : undefined;
      const tas = user.traditionalAuthorities ? JSON.parse(user.traditionalAuthorities) : undefined;
      const regions = user.regions ? JSON.parse(user.regions) : undefined;
      
      const accessibleChurchIds = await getAccessibleChurchIds(
        user.role.name,
        user.churchId,
        districts,
        tas,
        regions,
        userId
      );

      const scopeTeams = await prisma.team.findMany({
        where: { churchId: { in: accessibleChurchIds } },
        include: {
          church: { select: { id: true, name: true } }
        }
      });

      // Add scope teams that aren't already in leader teams
      const leaderTeamIds = new Set(leaderTeams.map(t => t.id));
      const additionalTeams = scopeTeams
        .filter(t => !leaderTeamIds.has(t.id))
        .map(t => ({
          id: t.id,
          name: t.name,
          color: t.color,
          church: { id: t.church.id, name: t.church.name }
        }));

      teams = [...teams, ...additionalTeams];
    }

    res.json(teams);
  } catch (error: any) {
    console.error('Get postable teams error:', error);
    res.status(500).json({ error: 'Failed to fetch teams' });
  }
};

// Helper: Check if user can post to team (must be leader or admin)
async function canUserPostToTeam(userId: string, teamId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      role: true,
      teams: { where: { teamId } }
    }
  });

  if (!user) return false;

  // Must be team leader to post
  const isLeader = user.teams.some(t => t.isLeader);
  if (isLeader) return true;

  // Admin roles can post to teams in their scope
  if (user.role && user.role.name !== 'member') {
    const team = await prisma.team.findUnique({
      where: { id: teamId },
      include: { church: true }
    });

    if (!team) return false;
    
    // Use existing churchScope function to check access
    const districts = user.districts ? JSON.parse(user.districts) : undefined;
    const tas = user.traditionalAuthorities ? JSON.parse(user.traditionalAuthorities) : undefined;
    const regions = user.regions ? JSON.parse(user.regions) : undefined;
    
    const accessibleChurchIds = await getAccessibleChurchIds(
      user.role.name,
      user.churchId,
      districts,
      tas,
      regions,
      userId
    );
    
    return accessibleChurchIds.includes(team.churchId);
  }

  return false;
}

// Helper: Check if user can edit or delete (must be author AND leader, or team leader, or admin with scope)
async function canUserEditOrDelete(userId: string, teamId: string, authorId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      role: true,
      teams: { where: { teamId } }
    }
  });

  if (!user) return false;

  // Check if team leader
  const isLeader = user.teams.some(t => t.isLeader);
  
  // Author can edit/delete ONLY if they are also a leader of the team
  if (userId === authorId && isLeader) return true;
  
  // Team leader can edit/delete any post in their team
  if (isLeader) return true;

  // Admin with scope can edit/delete
  if (user.role && user.role.name !== 'member') {
    const team = await prisma.team.findUnique({
      where: { id: teamId },
      include: { church: true }
    });

    if (!team) return false;
    
    // Use existing churchScope function to check access
    const districts = user.districts ? JSON.parse(user.districts) : undefined;
    const tas = user.traditionalAuthorities ? JSON.parse(user.traditionalAuthorities) : undefined;
    const regions = user.regions ? JSON.parse(user.regions) : undefined;
    
    const accessibleChurchIds = await getAccessibleChurchIds(
      user.role.name,
      user.churchId,
      districts,
      tas,
      regions,
      userId
    );
    
    return accessibleChurchIds.includes(team.churchId);
  }

  return false;
}


