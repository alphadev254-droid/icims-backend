import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { queueEmail } from '../lib/emailQueue';
import { sendPushToUsers } from '../lib/fcm';
import { discipleshipReminderTemplate } from '../lib/emailTemplates';

type DispatchOptions = {
  churchIds?: string[];
  now?: Date;
};

type Recipient = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
};

type Delivery = {
  churchId: string;
  journeyId?: string;
  sessionId?: string;
  type: string;
  recipient: Recipient;
  title: string;
  message: string;
  key: string;
  data: Record<string, string>;
};

async function reserveDelivery(delivery: Delivery, channel: 'push' | 'email') {
  try {
    await prisma.discipleshipNotificationLog.create({
      data: {
        key: `${delivery.key}:${channel}`,
        churchId: delivery.churchId,
        journeyId: delivery.journeyId,
        sessionId: delivery.sessionId,
        type: delivery.type,
        channel,
        recipientId: delivery.recipient.id,
      },
    });
    return true;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return false;
    throw error;
  }
}

async function deliver(delivery: Delivery) {
  let sent = 0;
  if (await reserveDelivery(delivery, 'push')) {
    await sendPushToUsers([delivery.recipient.id], delivery.title, delivery.message, delivery.data);
    sent += 1;
  }
  if (delivery.recipient.email && await reserveDelivery(delivery, 'email')) {
    await queueEmail(
      delivery.recipient.email,
      delivery.title,
      discipleshipReminderTemplate({
        recipientName: `${delivery.recipient.firstName} ${delivery.recipient.lastName}`.trim(),
        title: delivery.title,
        message: delivery.message,
      }),
      'notification',
    );
    sent += 1;
  }
  return sent;
}

function userMap(users: Recipient[]) {
  return new Map(users.map(user => [user.id, user]));
}

export async function dispatchDiscipleshipNotifications(options: DispatchOptions = {}) {
  const now = options.now || new Date();
  const horizon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const churchFilter = options.churchIds?.length ? { in: options.churchIds } : undefined;

  const [sessions, missedAttendance, mentorAssignments] = await Promise.all([
    prisma.discipleshipClassSession.findMany({
      where: {
        startsAt: { gt: now, lte: horizon },
        status: { in: ['scheduled', 'open'] },
        class: { churchId: churchFilter, status: { in: ['scheduled', 'active'] } },
      },
      include: { class: { include: { enrollments: { where: { status: 'enrolled' } } } } },
    }),
    prisma.discipleshipSessionAttendance.findMany({
      where: {
        status: 'absent',
        session: { endsAt: { lt: now }, class: { churchId: churchFilter } },
      },
      include: { session: true, enrollment: true },
    }),
    prisma.discipleshipMentorAssignment.findMany({
      where: { status: 'active', nextFollowUpAt: { lte: now } },
    }),
  ]);

  const journeyIds = [...new Set([
    ...sessions.flatMap(session => session.class.enrollments.map(enrollment => enrollment.journeyId)),
    ...missedAttendance.map(record => record.enrollment.journeyId),
    ...mentorAssignments.map(assignment => assignment.journeyId),
  ])];
  const journeys = journeyIds.length ? await prisma.discipleshipJourney.findMany({
    where: { id: { in: journeyIds }, churchId: churchFilter },
    select: { id: true, churchId: true, candidateUserId: true, status: true },
  }) : [];
  const journeyById = new Map(journeys.map(journey => [journey.id, journey]));
  const recipientIds = [...new Set([
    ...journeys.map(journey => journey.candidateUserId),
    ...mentorAssignments.map(assignment => assignment.mentorUserId),
  ])];
  const recipients = recipientIds.length ? await prisma.user.findMany({
    where: { id: { in: recipientIds }, status: 'active' },
    select: { id: true, email: true, firstName: true, lastName: true },
  }) : [];
  const recipientById = userMap(recipients);

  let deliveries = 0;
  let notifications = 0;
  for (const session of sessions) {
    const reminderAt = new Date(session.startsAt.getTime() - session.class.reminderMinutes * 60 * 1000);
    if (reminderAt > now) continue;
    for (const enrollment of session.class.enrollments) {
      const journey = journeyById.get(enrollment.journeyId);
      const recipient = journey && recipientById.get(journey.candidateUserId);
      if (!journey || journey.status !== 'active' || !recipient) continue;
      deliveries += await deliver({
        key: `class:${session.id}:${recipient.id}`,
        churchId: journey.churchId,
        journeyId: journey.id,
        sessionId: session.id,
        type: 'class_reminder',
        recipient,
        title: `Class reminder: ${session.title}`,
        message: `Your class starts ${session.startsAt.toLocaleString()}${session.location ? ` at ${session.location}` : ''}.`,
        data: { type: 'discipleship_class', sessionId: session.id },
      });
      notifications += 1;
    }
  }

  for (const record of missedAttendance) {
    const journey = journeyById.get(record.enrollment.journeyId);
    const recipient = journey && recipientById.get(journey.candidateUserId);
    if (!journey || journey.status !== 'active' || !recipient) continue;
    deliveries += await deliver({
      key: `missed:${record.id}`,
      churchId: journey.churchId,
      journeyId: journey.id,
      sessionId: record.sessionId,
      type: 'missed_session',
      recipient,
      title: 'We missed you',
      message: `You were marked absent for ${record.session.title}. Please contact your mentor to arrange the next step.`,
      data: { type: 'discipleship_missed_session', journeyId: journey.id },
    });
    notifications += 1;
  }

  for (const assignment of mentorAssignments) {
    const journey = journeyById.get(assignment.journeyId);
    const recipient = recipientById.get(assignment.mentorUserId);
    if (!journey || journey.status !== 'active' || !recipient || !assignment.nextFollowUpAt) continue;
    deliveries += await deliver({
      key: `mentor:${assignment.id}:${assignment.nextFollowUpAt.toISOString()}`,
      churchId: journey.churchId,
      journeyId: journey.id,
      type: 'mentor_follow_up',
      recipient,
      title: 'Discipleship follow-up due',
      message: 'A scheduled candidate follow-up is now due. Open the journey to record your interaction and plan the next follow-up.',
      data: { type: 'discipleship_mentor_follow_up', journeyId: journey.id },
    });
    notifications += 1;
  }

  return { notifications, deliveries };
}
