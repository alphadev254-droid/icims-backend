import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';

type SyncOptions = {
  churchIds?: string[];
  since?: Date;
  take?: number;
};

export async function syncFirstTimerAttendanceCandidates(options: SyncOptions = {}) {
  const participants = await prisma.attendanceParticipant.findMany({
    where: {
      attendance: options.churchIds?.length ? { churchId: { in: options.churchIds } } : undefined,
      OR: [{ guestFirstTime: true }, { isNewConvert: true }],
      ...(options.since ? { checkedInAt: { gte: options.since } } : {}),
    },
    include: { attendance: { select: { churchId: true } }, user: { select: { firstName: true, lastName: true, email: true, phone: true } } },
    orderBy: { checkedInAt: 'desc' },
    take: Math.min(options.take ?? 1000, 5000),
  });

  if (!participants.length) return { scanned: 0, created: 0 };

  const sourceIds = participants.map(participant => participant.id);
  const existing = await prisma.discipleshipBelongingPrompt.findMany({
    where: { sourceType: 'attendance', sourceRecordId: { in: sourceIds } },
    select: { sourceRecordId: true },
  });
  const existingIds = new Set(existing.map(item => item.sourceRecordId));
  const candidates: Prisma.DiscipleshipBelongingPromptCreateManyInput[] = participants
    .filter(participant => !existingIds.has(participant.id))
    .map(participant => ({
      churchId: participant.attendance.churchId,
      sourceType: 'attendance',
      sourceRecordId: participant.id,
      name: participant.guestName || (participant.user ? `${participant.user.firstName} ${participant.user.lastName}`.trim() : 'First-time visitor'),
      email: participant.guestEmail || participant.user?.email,
      phone: participant.guestPhone || participant.user?.phone,
      status: 'pending',
      notes: participant.isNewConvert ? 'Automatically added from service check-in as a new convert.' : 'Automatically added from service check-in as a First Timer.',
    }));

  const result = candidates.length
    ? await prisma.discipleshipBelongingPrompt.createMany({ data: candidates, skipDuplicates: true })
    : { count: 0 };
  return { scanned: participants.length, created: result.count };
}
