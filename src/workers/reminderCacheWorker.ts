import cron from 'node-cron';
import prisma from '../lib/prisma';
import { sendPushNotification, sendPushToUsers } from '../lib/fcm';

// Runs daily at 2 AM
cron.schedule('0 2 * * *', async () => {
  console.log('[ReminderCache] Starting daily refresh...');
  await refreshReminderCache();
});

// Run immediately on server startup (to handle missed cron jobs)
console.log('[ReminderCache] Running startup refresh...');
refreshReminderCache().then(() => {
  console.log('[ReminderCache] ✅ Startup refresh completed');
}).catch(err => {
  console.error('[ReminderCache] ❌ Startup refresh failed:', err.message);
});

export async function refreshReminderCache() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const thirtyDaysFromNow = new Date(today);
  thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);

  // Clear entire cache at start of each refresh — we rebuild it completely
  // This avoids duplicate rows from partial previous runs
  await prisma.reminderCache.deleteMany({});

  // Get all active users with date fields
  const users = await prisma.user.findMany({
    where: {
      OR: [
        { dateOfBirth: { not: null } },
        { weddingDate: { not: null } },
        { anniversary: { not: null } },
      ],
      status: 'active',
      churchId: { not: null },
    },
    select: {
      id: true,
      dateOfBirth: true,
      weddingDate: true,
      anniversary: true,
      createdAt: true,
      churchId: true,
      maritalStatus: true,
      role: { select: { name: true } },
      church: { select: { ministryAdminId: true } },
    },
  });

  const reminders = [];

  for (const user of users) {
    const ministryAdminId = user.church?.ministryAdminId || null;

    // Birthday
    if (user.dateOfBirth) {
      const next = getNextOccurrence(user.dateOfBirth, today);
      const daysUntil = Math.floor((next.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
      if (daysUntil <= 30) {
        reminders.push({
          userId: user.id,
          type: 'birthday',
          originalDate: user.dateOfBirth,
          upcomingDate: next,
          daysUntil,
          age: next.getFullYear() - user.dateOfBirth.getFullYear(),
          churchId: user.churchId!,
          ministryAdminId,
        });
      }
    }

    // Wedding Anniversary
    if (user.weddingDate && user.maritalStatus === 'Married') {
      const next = getNextOccurrence(user.weddingDate, today);
      const daysUntil = Math.floor((next.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
      if (daysUntil <= 30) {
        reminders.push({
          userId: user.id,
          type: 'wedding',
          originalDate: user.weddingDate,
          upcomingDate: next,
          daysUntil,
          years: next.getFullYear() - user.weddingDate.getFullYear(),
          churchId: user.churchId!,
          ministryAdminId,
        });
      }
    }

    // Member Anniversary (skip first year)
    const memberNext = getNextOccurrence(user.createdAt, today);
    const memberYears = memberNext.getFullYear() - user.createdAt.getFullYear();
    const daysUntilMember = Math.floor((memberNext.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    if (daysUntilMember <= 30 && memberYears > 0) {
      reminders.push({
        userId: user.id,
        type: 'member_anniversary',
        originalDate: user.createdAt,
        upcomingDate: memberNext,
        daysUntil: daysUntilMember,
        years: memberYears,
        churchId: user.churchId!,
        ministryAdminId,
      });
    }

    // Church Founded (National Admin only)
    if (user.anniversary && user.role?.name === 'ministry_admin') {
      const next = getNextOccurrence(user.anniversary, today);
      const daysUntil = Math.floor((next.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
      if (daysUntil <= 30) {
        reminders.push({
          userId: user.id,
          type: 'church_founded',
          originalDate: user.anniversary,
          upcomingDate: next,
          daysUntil,
          years: next.getFullYear() - user.anniversary.getFullYear(),
          churchId: user.churchId!,
          ministryAdminId,
        });
      }
    }
  }

  // Get upcoming events with church members in one query
  const upcomingEvents = await prisma.event.findMany({
    where: {
      date: { gte: today, lte: thirtyDaysFromNow },
      status: { in: ['upcoming', 'ongoing'] },
    },
    select: {
      id: true,
      title: true,
      date: true,
      churchId: true,
      isFree: true,
      requiresTicket: true,
      tickets: { select: { userId: true, user: { select: { churchId: true } } }, where: { isGuest: false } },
      church: { select: { ministryAdminId: true } },
    },
  });

  // Get all church IDs for free events
  const freeEventChurchIds = upcomingEvents
    .filter(e => e.isFree && !e.requiresTicket)
    .map(e => e.churchId);

  // Fetch all members for free event churches in one query
  const churchMembersMap = new Map<string, Array<{ id: string; churchId: string }>>();
  if (freeEventChurchIds.length > 0) {
    const allChurchMembers = await prisma.user.findMany({
      where: {
        churchId: { in: freeEventChurchIds },
        status: 'active',
        role: { name: 'member' },
      },
      select: { id: true, churchId: true },
    });

    // Group members by churchId
    for (const member of allChurchMembers) {
      if (member.churchId) {
        if (!churchMembersMap.has(member.churchId)) {
          churchMembersMap.set(member.churchId, []);
        }
        churchMembersMap.get(member.churchId)!.push({ id: member.id, churchId: member.churchId });
      }
    }
  }

  // Create event reminders
  for (const event of upcomingEvents) {
    const eventDate = new Date(event.date);
    eventDate.setHours(0, 0, 0, 0);
    const daysUntil = Math.floor((eventDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    const ministryAdminId = event.church?.ministryAdminId || null;

    if (event.isFree && !event.requiresTicket) {
      // Use pre-fetched church members
      const churchMembers = churchMembersMap.get(event.churchId) || [];
      for (const member of churchMembers) {
        if (member.churchId) {
          reminders.push({
            userId: member.id,
            type: 'event',
            originalDate: event.date,
            upcomingDate: eventDate,
            daysUntil,
            churchId: member.churchId,
            ministryAdminId,
            eventId: event.id,
            eventTitle: event.title,
          });
        }
      }
    } else if (event.requiresTicket) {
      // Use tickets data already loaded
      const uniqueTickets = new Map<string, string>();
      for (const ticket of event.tickets) {
        if (ticket.userId && ticket.user?.churchId) {
          uniqueTickets.set(ticket.userId, ticket.user.churchId);
        }
      }

      for (const [userId, churchId] of uniqueTickets) {
        reminders.push({
          userId,
          type: 'event',
          originalDate: event.date,
          upcomingDate: eventDate,
          daysUntil,
          churchId,
          ministryAdminId,
          eventId: event.id,
          eventTitle: event.title,
        });
      }
    }
  }

  // ── Dedup in-memory before persisting ────────────────────────────────────────
  // Key: userId|type|upcomingDate|eventId — prevents duplicate objects built in
  // the same run (e.g. user appears in two query paths) from reaching the DB.
  const seen = new Set<string>();
  const uniqueReminders = (reminders as any[]).filter(r => {
    const key = `${r.userId}|${r.type}|${r.upcomingDate.getTime()}|${r.eventId ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // ── Persist reminders ────────────────────────────────────────────────────────
  // Strategy: clear-and-rebuild daily (full table wipe already done above).
  // Additionally guard per-user/per-event to be safe if called concurrently.

  const affectedUserIds = [...new Set(
    uniqueReminders.filter(r => r.type !== 'event').map(r => r.userId)
  )];
  const affectedEventIds = [...new Set(
    uniqueReminders.filter(r => r.type === 'event' && r.eventId).map(r => r.eventId)
  )];

  // Belt-and-suspenders: delete any stale rows that somehow survived the full wipe
  if (affectedUserIds.length > 0) {
    await prisma.reminderCache.deleteMany({
      where: { userId: { in: affectedUserIds }, type: { not: 'event' } },
    });
  }
  if (affectedEventIds.length > 0) {
    await prisma.reminderCache.deleteMany({
      where: { eventId: { in: affectedEventIds } },
    });
  }

  // Insert deduplicated reminders in batches
  const batchSize = 100;
  for (let i = 0; i < uniqueReminders.length; i += batchSize) {
    const batch = uniqueReminders.slice(i, i + batchSize);
    await prisma.reminderCache.createMany({
      data: batch.map(r => ({
        userId: r.userId,
        type: r.type,
        originalDate: r.originalDate,
        upcomingDate: r.upcomingDate,
        daysUntil: r.daysUntil,
        age: r.age ?? null,
        years: r.years ?? null,
        churchId: r.churchId,
        ministryAdminId: r.ministryAdminId ?? null,
        eventId: r.eventId ?? null,
        eventTitle: r.eventTitle ?? null,
      })),
    });
  }

  console.log(`[ReminderCache] Refreshed ${uniqueReminders.length} reminders (${reminders.length - uniqueReminders.length} duplicates removed)`);

  // Send push notifications for today's reminders
  try {
    const todayReminders = await prisma.reminderCache.findMany({
      where: { daysUntil: 0 },
      select: {
        userId: true,
        type: true,
        eventTitle: true,
        age: true,
        years: true,
        churchId: true,
      },
    });

    if (todayReminders.length > 0) {
      // Collect unique church IDs to fetch church names
      const churchIds = [...new Set(todayReminders.map(r => r.churchId).filter(Boolean))] as string[];
      const churches = churchIds.length > 0
        ? await prisma.church.findMany({
            where: { id: { in: churchIds } },
            select: { id: true, name: true },
          })
        : [];
      const churchNameMap = new Map(churches.map(c => [c.id, c.name]));

      // Build a map of userId -> churchId
      const userChurchMap = new Map<string, string>();
      for (const r of todayReminders) {
        if (r.churchId && !userChurchMap.has(r.userId)) {
          userChurchMap.set(r.userId, r.churchId);
        }
      }

      // Group reminders by userId
      const userRemindersMap = new Map<string, Array<{ type: string; eventTitle?: string | null; age?: number | null; years?: number | null }>>();
      for (const r of todayReminders) {
        if (!userRemindersMap.has(r.userId)) {
          userRemindersMap.set(r.userId, []);
        }
        userRemindersMap.get(r.userId)!.push({ type: r.type, eventTitle: r.eventTitle, age: r.age, years: r.years });
      }

      for (const [uid, remindersList] of userRemindersMap) {
        // Get church name for this user
        const userChurchId = userChurchMap.get(uid);
        const churchName = userChurchId ? churchNameMap.get(userChurchId) : undefined;

        // Compose a summary message for the user
        const lines = remindersList.map(r => {
          switch (r.type) {
            case 'birthday': return `Birthday — Age ${r.age}`;
            case 'wedding': return `Wedding Anniversary — ${r.years} year(s)`;
            case 'member_anniversary': return `Member Anniversary — ${r.years} year(s)`;
            case 'church_founded': return `Church Founded Anniversary — ${r.years} year(s)`;
            case 'event': return `Event Today: ${r.eventTitle || 'Upcoming event'}`;
            default: return `Reminder: ${r.type}`;
          }
        });

        const titlePrefix = churchName ? `${churchName} · ` : '';
        await sendPushNotification(
          uid,
          `${titlePrefix}Today's Reminders`,
          lines.join(' · '),
          { type: 'reminder' }
        );
      }
    }
  } catch (pushError) {
    console.error('[ReminderCache] Failed to send push notifications:', pushError);
  }

  // Send push notifications for today's cell meetings
  try {
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const todayDayName = dayNames[today.getDay()];

    const todayCells = await prisma.cell.findMany({
      where: {
        meetingDay: todayDayName,
        status: 'active',
      },
      select: {
        id: true,
        name: true,
        meetingTime: true,
        church: { select: { name: true } },
        members: {
          where: { status: 'active' },
          select: { userId: true },
        },
      },
    });

    for (const cell of todayCells) {
      const memberIds = cell.members.map(m => m.userId);
      if (memberIds.length === 0) continue;

      const timeStr = cell.meetingTime ? ` at ${cell.meetingTime}` : '';
      await sendPushToUsers(
        memberIds,
        `${cell.church.name} · Cell Meeting Today`,
        `${cell.name}${timeStr}`,
        { type: 'cell_meeting', cellId: cell.id }
      );
    }

    if (todayCells.length > 0) {
      console.log(`[ReminderCache] Sent cell meeting notifications for ${todayCells.length} cells`);
    }
  } catch (pushError) {
    console.error('[ReminderCache] Failed to send cell meeting push notifications:', pushError);
  }
}

function getNextOccurrence(date: Date, from: Date): Date {
  const thisYear = new Date(from.getFullYear(), date.getMonth(), date.getDate());
  thisYear.setHours(0, 0, 0, 0);
  
  if (thisYear >= from) {
    return thisYear;
  }
  
  const nextYear = new Date(thisYear);
  nextYear.setFullYear(nextYear.getFullYear() + 1);
  return nextYear;
}
