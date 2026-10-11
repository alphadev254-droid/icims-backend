import { createHash } from 'crypto';
import prisma from '../lib/prisma';
import { queueProgramEmail } from '../lib/bullQueue';
import { programAssignmentTemplate } from '../lib/emailTemplates';

export type ProgramEmailContext = {
  targetType: 'services' | 'events';
  targetId: string;
  targetTitle: string;
  churchName: string;
  churchId: string;
  location: string | null;
  startsAt: Date;
  timeZone: string;
};

export type ProgramAssignment = {
  id: string;
  title: string;
  description: string | null;
  startsAt: Date;
  endsAt: Date;
  userId: string | null;
  guestName: string | null;
  guestEmail: string | null;
  user?: { firstName: string; lastName: string; email: string } | null;
};

export function assignmentRecipient(item: ProgramAssignment) {
  if (item.userId && item.user?.email)
    return { email: item.user.email.trim().toLowerCase(), name: `${item.user.firstName} ${item.user.lastName}`.trim() };
  if (!item.userId && item.guestEmail)
    return { email: item.guestEmail.trim().toLowerCase(), name: item.guestName || 'Guest' };
  return null;
}

export function assignmentFingerprint(item: ProgramAssignment, context: ProgramEmailContext) {
  return createHash('sha256').update(JSON.stringify({
    targetTitle: context.targetTitle,
    churchName: context.churchName,
    location: context.location,
    title: item.title,
    description: item.description,
    startsAt: item.startsAt.toISOString(),
    endsAt: item.endsAt.toISOString(),
  })).digest('hex');
}

export async function queueAssignmentNotification(input: {
  programId: string;
  item: ProgramAssignment;
  context: ProgramEmailContext;
  kind: 'assignment' | 'removal';
}) {
  const recipient = assignmentRecipient(input.item);
  if (!recipient) throw new Error('This assignee has no email address');
  const notification = await prisma.programNotification.create({
    data: {
      programId: input.programId,
      itemId: input.item.id,
      targetType: input.context.targetType,
      targetId: input.context.targetId,
      kind: input.kind,
      recipient: recipient.email,
      name: recipient.name,
      itemTitle: input.item.title,
      startsAt: input.item.startsAt,
      endsAt: input.item.endsAt,
      fingerprint: assignmentFingerprint(input.item, input.context),
    },
  });
  try {
    await queueProgramEmail(
      notification.id,
      recipient.email,
      input.kind === 'removal' ? `Assignment update: ${input.context.targetTitle}` : `Your assignment: ${input.context.targetTitle}`,
      programAssignmentTemplate({
        kind: input.kind,
        recipientName: recipient.name,
        targetTitle: input.context.targetTitle,
        churchName: input.context.churchName,
        location: input.context.location,
        itemTitle: input.item.title,
        itemDescription: input.item.description,
        startsAt: input.item.startsAt,
        endsAt: input.item.endsAt,
        timeZone: input.context.timeZone,
      }),
    );
  } catch (error) {
    await prisma.programNotification.update({
      where: { id: notification.id },
      data: { status: 'failed', error: error instanceof Error ? error.message : 'Could not queue email' },
    });
    throw error;
  }
  return notification;
}
