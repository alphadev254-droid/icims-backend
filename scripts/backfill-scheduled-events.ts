import prisma from '../src/lib/prisma';
import { syncCellMeetingToSchedule, syncEventToSchedule } from '../src/services/schedulerService';

const APPLY = process.argv.includes('--apply');

async function main() {
  console.log(APPLY ? 'Applying scheduled event backfill...' : 'Dry run only. No scheduled_events changes will be made.');

  const [events, cellMeetings] = await Promise.all([
    prisma.event.findMany({
      where: { status: { not: 'cancelled' } },
      include: { church: { select: { ministryAdminId: true } } },
      orderBy: { date: 'asc' },
    }),
    prisma.cellMeeting.findMany({
      include: {
        cell: {
          select: {
            id: true,
            name: true,
            zone: true,
            meetingTime: true,
            churchId: true,
            church: { select: { ministryAdminId: true } },
          },
        },
      },
      orderBy: { date: 'asc' },
    }),
  ]);

  console.log(`Events found: ${events.length}`);
  console.log(`Cell meetings found: ${cellMeetings.length}`);

  if (!APPLY) {
    console.log('Run with --apply to create or update scheduled_events rows for these records.');
    return;
  }

  for (const event of events) {
    await syncEventToSchedule(event);
  }

  for (const meeting of cellMeetings) {
    await syncCellMeetingToSchedule(meeting);
  }

  console.log(`Backfill complete. Synced ${events.length + cellMeetings.length} scheduled events.`);
}

main()
  .catch(error => {
    console.error('Scheduled event backfill failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
