import cron from 'node-cron';
import prisma from '../lib/prisma';
import { queueEmail } from '../lib/emailQueue';
import { sendPushNotification } from '../lib/fcm';

const SENT_LOG_RETENTION_DAYS = Number(process.env.SCHEDULED_REMINDER_SENT_LOG_RETENTION_DAYS || 180);
const FAILED_LOG_RETENTION_DAYS = Number(process.env.SCHEDULED_REMINDER_FAILED_LOG_RETENTION_DAYS || SENT_LOG_RETENTION_DAYS);

type ReminderRecipient = {
  userId?: string | null;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  pledgeId?: string | null;
  campaignName?: string | null;
  pledgedAmount?: number | null;
  amountPaid?: number | null;
  deadline?: Date | null;
};

function parseNumberList(value?: string | null): number[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : [];
  } catch {
    return [];
  }
}

function startOfDay(value: Date) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function endOfDay(value: Date) {
  const date = new Date(value);
  date.setHours(23, 59, 59, 999);
  return date;
}

function addDays(value: Date, days: number) {
  const date = new Date(value);
  date.setDate(date.getDate() + days);
  return date;
}

function dateKey(value: Date) {
  return value.toISOString().slice(0, 10);
}

function renderText(template: string, recipient: ReminderRecipient) {
  const balance = Math.max((recipient.pledgedAmount ?? 0) - (recipient.amountPaid ?? 0), 0);
  return template
    .replace(/\{firstName\}/g, recipient.firstName || 'there')
    .replace(/\{lastName\}/g, recipient.lastName || '')
    .replace(/\{campaignName\}/g, recipient.campaignName || 'the campaign')
    .replace(/\{pledgedAmount\}/g, String(recipient.pledgedAmount ?? ''))
    .replace(/\{amountPaid\}/g, String(recipient.amountPaid ?? ''))
    .replace(/\{balance\}/g, String(balance))
    .replace(/\{deadline\}/g, recipient.deadline ? recipient.deadline.toLocaleDateString() : '');
}

function reminderEmailHtml(title: string, message: string) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;padding:24px;color:#111827">
      <h2 style="margin:0 0 12px">${title}</h2>
      <p style="line-height:1.6;white-space:pre-line">${message}</p>
      <p style="margin-top:24px;color:#6b7280;font-size:12px">This reminder was sent by your church through ICIMS.</p>
    </div>
  `;
}

async function resolveMonthlyRecipients(reminder: any, today: Date): Promise<ReminderRecipient[]> {
  if (reminder.audience === 'all_members') {
    return prisma.user.findMany({
      where: { churchId: reminder.churchId, status: 'active', role: { name: 'member' } },
      select: { id: true, email: true, firstName: true, lastName: true },
    }).then(users => users.map(user => ({ userId: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName })));
  }

  if (reminder.audience === 'not_given_this_month') {
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const donorRows = await prisma.donationTransaction.findMany({
      where: {
        churchId: reminder.churchId,
        status: 'completed',
        createdAt: { gte: monthStart, lte: endOfDay(today) },
        ...(reminder.campaignId ? { campaignId: reminder.campaignId } : {}),
        userId: { not: null },
      },
      select: { userId: true },
      distinct: ['userId'],
    });
    const donorIds = donorRows.map(row => row.userId).filter(Boolean) as string[];
    const users = await prisma.user.findMany({
      where: {
        churchId: reminder.churchId,
        status: 'active',
        role: { name: 'member' },
        ...(donorIds.length ? { id: { notIn: donorIds } } : {}),
      },
      select: { id: true, email: true, firstName: true, lastName: true },
    });
    return users.map(user => ({ userId: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName }));
  }

  const pledgeWhere: any = {
    churchId: reminder.churchId,
    userId: { not: null },
    ...(reminder.campaignId ? { campaignId: reminder.campaignId } : {}),
  };
  if (reminder.audience === 'overdue_pledges') {
    pledgeWhere.OR = [
      { status: 'overdue' },
      { fulfillmentDeadline: { lt: today }, pledgedAmount: { gt: prisma.pledge.fields.amountPaid } },
    ];
  } else {
    pledgeWhere.status = { not: 'fulfilled' };
  }

  const pledges = await prisma.pledge.findMany({
    where: pledgeWhere,
    include: {
      user: { select: { id: true, email: true, firstName: true, lastName: true } },
      campaign: { select: { name: true } },
    },
  });

  return pledges
    .filter(pledge => pledge.user)
    .map(pledge => ({
      userId: pledge.user!.id,
      email: pledge.user!.email,
      firstName: pledge.user!.firstName,
      lastName: pledge.user!.lastName,
      pledgeId: pledge.id,
      campaignName: pledge.campaign.name,
      pledgedAmount: pledge.pledgedAmount,
      amountPaid: pledge.amountPaid,
      deadline: pledge.fulfillmentDeadline,
    }));
}

async function resolveDeadlineRecipients(reminder: any, today: Date): Promise<ReminderRecipient[]> {
  const recipients: ReminderRecipient[] = [];
  const offsets = parseNumberList(reminder.deadlineOffsets);
  for (const offset of offsets) {
    const deadlineDate = addDays(today, -offset);
    const pledges = await prisma.pledge.findMany({
      where: {
        churchId: reminder.churchId,
        userId: { not: null },
        status: { not: 'fulfilled' },
        fulfillmentDeadline: { gte: startOfDay(deadlineDate), lte: endOfDay(deadlineDate) },
        ...(reminder.campaignId ? { campaignId: reminder.campaignId } : {}),
      },
      include: {
        user: { select: { id: true, email: true, firstName: true, lastName: true } },
        campaign: { select: { name: true } },
      },
    });

    recipients.push(...pledges.filter(pledge => pledge.user).map(pledge => ({
      userId: pledge.user!.id,
      email: pledge.user!.email,
      firstName: pledge.user!.firstName,
      lastName: pledge.user!.lastName,
      pledgeId: pledge.id,
      campaignName: pledge.campaign.name,
      pledgedAmount: pledge.pledgedAmount,
      amountPaid: pledge.amountPaid,
      deadline: pledge.fulfillmentDeadline,
    })));
  }
  return recipients;
}

async function createLogIfNew(reminderId: string, recipient: ReminderRecipient, channel: string, scheduledFor: Date) {
  const keyRecipient = recipient.userId || recipient.email || 'unknown';
  const dedupeKey = `${reminderId}:${recipient.pledgeId || 'general'}:${keyRecipient}:${channel}:${dateKey(scheduledFor)}`;
  try {
    return await prisma.scheduledReminderLog.create({
      data: {
        reminderId,
        userId: recipient.userId || null,
        recipientEmail: recipient.email || null,
        channel,
        status: 'pending',
        scheduledFor,
        dedupeKey,
      },
    });
  } catch (error: any) {
    if (error.code === 'P2002') return null;
    throw error;
  }
}

async function sendToRecipient(reminder: any, recipient: ReminderRecipient, scheduledFor: Date) {
  const title = renderText(reminder.title, recipient);
  const message = renderText(reminder.message, recipient);

  if (reminder.channelEmail && recipient.email) {
    const log = await createLogIfNew(reminder.id, recipient, 'email', scheduledFor);
    if (log) {
      try {
        await queueEmail(recipient.email, title, reminderEmailHtml(title, message), 'notification');
        await prisma.scheduledReminderLog.update({ where: { id: log.id }, data: { status: 'queued', sentAt: new Date() } });
      } catch (error: any) {
        await prisma.scheduledReminderLog.update({ where: { id: log.id }, data: { status: 'failed', error: error.message } });
      }
    }
  }

  if (reminder.channelPush && recipient.userId) {
    const log = await createLogIfNew(reminder.id, recipient, 'push', scheduledFor);
    if (log) {
      try {
        await sendPushNotification(recipient.userId, title, message, { type: 'scheduled_reminder', reminderId: reminder.id });
        await prisma.scheduledReminderLog.update({ where: { id: log.id }, data: { status: 'sent', sentAt: new Date() } });
      } catch (error: any) {
        await prisma.scheduledReminderLog.update({ where: { id: log.id }, data: { status: 'failed', error: error.message } });
      }
    }
  }
}

export async function processScheduledReminders(runDate = new Date()) {
  const today = startOfDay(runDate);
  const reminders = await prisma.scheduledReminder.findMany({ where: { isActive: true } });
  let sentTargets = 0;

  for (const reminder of reminders) {
    const isMonthlyDue = reminder.scheduleKind === 'monthly_days' && parseNumberList(reminder.scheduleDays).includes(today.getDate());
    const isDeadlineDue = reminder.scheduleKind === 'pledge_deadline' && reminder.type === 'pledge';
    if (!isMonthlyDue && !isDeadlineDue) continue;

    const recipients = isDeadlineDue
      ? await resolveDeadlineRecipients(reminder, today)
      : await resolveMonthlyRecipients(reminder, today);

    for (const recipient of recipients) {
      await sendToRecipient(reminder, recipient, today);
      sentTargets += 1;
    }

    await prisma.scheduledReminder.update({ where: { id: reminder.id }, data: { lastRunAt: new Date() } });
  }

  if (sentTargets > 0) {
    console.log(`[ScheduledReminders] Processed ${sentTargets} recipient reminder target(s)`);
  }
}

export async function cleanupScheduledReminderLogs(runDate = new Date()) {
  const sentCutoff = new Date(runDate);
  sentCutoff.setDate(sentCutoff.getDate() - SENT_LOG_RETENTION_DAYS);

  const failedCutoff = new Date(runDate);
  failedCutoff.setDate(failedCutoff.getDate() - FAILED_LOG_RETENTION_DAYS);

  const [sentCleanup, failedCleanup] = await Promise.all([
    prisma.scheduledReminderLog.deleteMany({
      where: {
        createdAt: { lt: sentCutoff },
        status: { in: ['queued', 'sent'] },
      },
    }),
    prisma.scheduledReminderLog.deleteMany({
      where: {
        createdAt: { lt: failedCutoff },
        status: 'failed',
      },
    }),
  ]);

  const deleted = sentCleanup.count + failedCleanup.count;
  if (deleted > 0) {
    console.log(`[ScheduledReminders] Cleaned ${deleted} old log(s) | sent=${SENT_LOG_RETENTION_DAYS}d failed=${FAILED_LOG_RETENTION_DAYS}d`);
  }
}

cron.schedule('0 8 * * *', async () => {
  console.log('[ScheduledReminders] Starting daily processing...');
  await processScheduledReminders();
});

cron.schedule('30 3 * * 0', async () => {
  console.log('[ScheduledReminders] Starting weekly log cleanup...');
  await cleanupScheduledReminderLogs();
});

console.log('[ScheduledReminders] Running startup processing...');
processScheduledReminders().catch(err => {
  console.error('[ScheduledReminders] Startup processing failed:', err.message);
});
