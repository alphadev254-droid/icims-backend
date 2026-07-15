import prisma from '../src/lib/prisma';

type AgeBucket = 'children' | 'youth' | 'youngAdults' | 'adults' | 'seniors';

type Summary = {
  totalAttendees: number;
  maleCount: number;
  femaleCount: number;
  children: number;
  youth: number;
  youngAdults: number;
  adults: number;
  seniors: number;
  newVisitors: number;
};

const summaryKeys: Array<keyof Summary> = [
  'totalAttendees',
  'maleCount',
  'femaleCount',
  'children',
  'youth',
  'youngAdults',
  'adults',
  'seniors',
  'newVisitors',
];

function parseArgs() {
  const args = process.argv.slice(2);
  const valueFor = (name: string) => {
    const prefix = `--${name}=`;
    return args.find(arg => arg.startsWith(prefix))?.slice(prefix.length);
  };
  return {
    dryRun: !args.includes('--apply'),
    attendanceId: valueFor('attendance-id'),
    churchId: valueFor('church-id'),
  };
}

function getAge(dateOfBirth?: Date | string | null) {
  if (!dateOfBirth) return null;
  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const monthDelta = today.getMonth() - dob.getMonth();
  if (monthDelta < 0 || (monthDelta === 0 && today.getDate() < dob.getDate())) age -= 1;
  if (age < 0 || age > 130) return null;
  return age;
}

function ageBucketFromAge(age: number | null): AgeBucket | null {
  if (age === null) return null;
  if (age <= 12) return 'children';
  if (age <= 17) return 'youth';
  if (age <= 35) return 'youngAdults';
  if (age <= 59) return 'adults';
  return 'seniors';
}

function ageBucketForMember(member: { memberType?: string | null; dateOfBirth?: Date | string | null }): AgeBucket | null {
  const memberType = String(member.memberType || '').toLowerCase();
  const age = getAge(member.dateOfBirth);
  if (age === null) {
    if (memberType === 'child') return 'children';
    if (memberType === 'adult') return 'adults';
    return null;
  }
  if (memberType === 'adult' && age < 18) return 'adults';
  if (memberType === 'child' && age >= 18) return 'children';
  return ageBucketFromAge(age);
}

function ageBucketFromBracket(ageBracket?: string | null): AgeBucket | null {
  if (!ageBracket) return null;
  if (ageBracket === '0-12') return 'children';
  if (ageBracket === '13-17') return 'youth';
  if (ageBracket === '18-35') return 'youngAdults';
  if (ageBracket === '36-59') return 'adults';
  if (ageBracket === '60+') return 'seniors';
  const numericAge = Number.parseInt(ageBracket, 10);
  return Number.isFinite(numericAge) ? ageBucketFromAge(numericAge) : null;
}

function increment(summary: Summary, gender?: string | null, bucket?: AgeBucket | null, isGuest = false) {
  summary.totalAttendees += 1;
  const normalizedGender = String(gender || '').toLowerCase();
  if (normalizedGender === 'male') summary.maleCount += 1;
  if (normalizedGender === 'female') summary.femaleCount += 1;
  if (bucket) summary[bucket] += 1;
  if (isGuest) summary.newVisitors += 1;
}

function emptySummary(): Summary {
  return {
    totalAttendees: 0,
    maleCount: 0,
    femaleCount: 0,
    children: 0,
    youth: 0,
    youngAdults: 0,
    adults: 0,
    seniors: 0,
    newVisitors: 0,
  };
}

function hasChanges(record: Summary, next: Summary) {
  return summaryKeys.some(key => record[key] !== next[key]);
}

function formatDiff(record: Summary, next: Summary) {
  return summaryKeys
    .filter(key => record[key] !== next[key])
    .map(key => `${key}: ${record[key]} -> ${next[key]}`)
    .join(', ');
}

async function main() {
  const { dryRun, attendanceId, churchId } = parseArgs();
  const where: any = {
    participants: { some: {} },
  };
  if (attendanceId) where.id = attendanceId;
  if (churchId) where.churchId = churchId;

  const records = await prisma.attendance.findMany({
    where,
    select: {
      id: true,
      churchId: true,
      date: true,
      serviceType: true,
      totalAttendees: true,
      maleCount: true,
      femaleCount: true,
      children: true,
      youth: true,
      youngAdults: true,
      adults: true,
      seniors: true,
      newVisitors: true,
      participants: {
        select: {
          userId: true,
          guestGender: true,
          guestAgeBracket: true,
          user: {
            select: {
              memberType: true,
              gender: true,
              dateOfBirth: true,
            },
          },
        },
      },
      visitors: {
        select: {
          gender: true,
          ageBracket: true,
        },
      },
    },
    orderBy: { date: 'asc' },
  });

  let changed = 0;
  let unchanged = 0;

  for (const record of records) {
    const next = emptySummary();

    for (const participant of record.participants) {
      if (participant.userId && participant.user) {
        increment(next, participant.user.gender, ageBucketForMember(participant.user), false);
      } else {
        increment(next, participant.guestGender, ageBucketFromBracket(participant.guestAgeBracket), true);
      }
    }

    for (const visitor of record.visitors) {
      increment(next, visitor.gender, ageBucketFromBracket(visitor.ageBracket), true);
    }

    const current: Summary = {
      totalAttendees: record.totalAttendees,
      maleCount: record.maleCount,
      femaleCount: record.femaleCount,
      children: record.children,
      youth: record.youth,
      youngAdults: record.youngAdults,
      adults: record.adults,
      seniors: record.seniors,
      newVisitors: record.newVisitors,
    };

    if (!hasChanges(current, next)) {
      unchanged += 1;
      continue;
    }

    changed += 1;
    console.log(`[${dryRun ? 'DRY RUN' : 'UPDATE'}] ${record.id} | ${record.serviceType} | ${record.date.toISOString()} | ${formatDiff(current, next)}`);

    if (!dryRun) {
      await prisma.attendance.update({
        where: { id: record.id },
        data: next,
      });
    }
  }

  console.log(`${dryRun ? 'Previewed' : 'Recalculated'} ${records.length} participant-based attendance record(s).`);
  console.log(`Changed: ${changed}. Unchanged: ${unchanged}.`);
  if (dryRun) console.log('Run with --apply to apply these changes.');
}

main()
  .catch(error => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
