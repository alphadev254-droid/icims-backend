import prisma from '../src/lib/prisma';

type CampaignRow = {
  id: string;
  name: string;
  category: string;
  currency: string;
  status: string;
  churchId: string;
  createdAt: Date;
  church: {
    id: string;
    name: string;
    ministryAdminId: string;
    ministryAdmin: {
      firstName: string;
      lastName: string;
      ministryName: string | null;
    } | null;
  };
  linkedChurches: Array<{ churchId: string; church: { id: string; name: string } }>;
};

type MergePlan = {
  key: string;
  normalizedName: string;
  ministryName: string;
  ministryAdminId: string;
  category: string;
  currency: string;
  main: CampaignRow;
  duplicates: CampaignRow[];
  finalChurches: Array<{ id: string; name: string }>;
  counts: {
    donations: number;
    pledges: number;
    scheduledReminders: number;
    pendingTransactions: number;
  };
};

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const includeInactive = args.has('--include-inactive');

function normalizeName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function ministryDisplayName(campaign: CampaignRow): string {
  return campaign.church.ministryAdmin?.ministryName
    || `${campaign.church.ministryAdmin?.firstName || ''} ${campaign.church.ministryAdmin?.lastName || ''}`.trim()
    || campaign.church.ministryAdminId;
}

function campaignChurches(campaign: CampaignRow): Array<{ id: string; name: string }> {
  const churches = campaign.linkedChurches.length > 0
    ? campaign.linkedChurches.map(link => ({ id: link.churchId, name: link.church.name }))
    : [{ id: campaign.churchId, name: campaign.church.name }];

  const seen = new Set<string>();
  return churches.filter(church => {
    if (seen.has(church.id)) return false;
    seen.add(church.id);
    return true;
  });
}

function chooseMainCampaign(campaigns: CampaignRow[]): CampaignRow {
  return [...campaigns].sort((a, b) => {
    const activeWeight = Number(b.status === 'active') - Number(a.status === 'active');
    if (activeWeight !== 0) return activeWeight;
    const donationReadyWeight = Number(b.linkedChurches.length > 0) - Number(a.linkedChurches.length > 0);
    if (donationReadyWeight !== 0) return donationReadyWeight;
    return a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);
  })[0];
}

function updatePendingMetadata(metadata: string | null, duplicateToMain: Map<string, string>, mainNames: Map<string, string>): string | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata);
    let changed = false;

    if (typeof parsed.campaignId === 'string' && duplicateToMain.has(parsed.campaignId)) {
      const mainId = duplicateToMain.get(parsed.campaignId)!;
      parsed.campaignId = mainId;
      parsed.campaignName = mainNames.get(mainId) || parsed.campaignName;
      changed = true;
    }

    if (Array.isArray(parsed.items)) {
      parsed.items = parsed.items.map((item: any) => {
        if (typeof item?.campaignId === 'string' && duplicateToMain.has(item.campaignId)) {
          const mainId = duplicateToMain.get(item.campaignId)!;
          changed = true;
          return {
            ...item,
            campaignId: mainId,
            campaignName: mainNames.get(mainId) || item.campaignName,
          };
        }
        return item;
      });
    }

    return changed ? JSON.stringify(parsed) : null;
  } catch {
    return null;
  }
}

async function buildPlans(): Promise<MergePlan[]> {
  const campaigns = await prisma.givingCampaign.findMany({
    where: includeInactive ? {} : { status: { not: 'cancelled' } },
    include: {
      church: {
        select: {
          id: true,
          name: true,
          ministryAdminId: true,
          ministryAdmin: { select: { firstName: true, lastName: true, ministryName: true } },
        },
      },
      linkedChurches: {
        include: { church: { select: { id: true, name: true } } },
      },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  }) as CampaignRow[];

  const groups = new Map<string, CampaignRow[]>();
  for (const campaign of campaigns) {
    const normalizedName = normalizeName(campaign.name);
    if (!normalizedName) continue;
    const key = [
      campaign.church.ministryAdminId,
      campaign.category,
      campaign.currency,
      normalizedName,
    ].join('|');
    groups.set(key, [...(groups.get(key) ?? []), campaign]);
  }

  const plans: MergePlan[] = [];
  for (const [key, group] of groups) {
    if (group.length < 2) continue;

    const main = chooseMainCampaign(group);
    const duplicates = group.filter(campaign => campaign.id !== main.id);
    const duplicateIds = duplicates.map(campaign => campaign.id);
    const finalChurchMap = new Map<string, string>();
    for (const campaign of group) {
      for (const church of campaignChurches(campaign)) {
        finalChurchMap.set(church.id, church.name);
      }
    }

    const [donations, pledges, scheduledReminders, pendingTransactions] = await Promise.all([
      prisma.donationTransaction.count({ where: { campaignId: { in: duplicateIds } } }),
      prisma.pledge.count({ where: { campaignId: { in: duplicateIds } } }),
      prisma.scheduledReminder.count({ where: { campaignId: { in: duplicateIds } } }),
      prisma.pendingTransaction.count({
        where: {
          status: 'pending',
          type: 'donation',
          OR: duplicateIds.map(id => ({ metadata: { contains: id } })),
        },
      }),
    ]);

    plans.push({
      key,
      normalizedName: normalizeName(main.name),
      ministryName: ministryDisplayName(main),
      ministryAdminId: main.church.ministryAdminId,
      category: main.category,
      currency: main.currency,
      main,
      duplicates,
      finalChurches: [...finalChurchMap.entries()].map(([id, name]) => ({ id, name })),
      counts: { donations, pledges, scheduledReminders, pendingTransactions },
    });
  }

  return plans;
}

function printPlan(plan: MergePlan, index: number): void {
  console.log(`\n[${index}] GROUP: "${plan.main.name}" | normalized="${plan.normalizedName}" | category=${plan.category} | currency=${plan.currency}`);
  console.log(`    Ministry: ${plan.ministryName} (${plan.ministryAdminId})`);
  console.log('    Main campaign:');
  console.log(`    - ${plan.main.id} | ${plan.main.name} | ${plan.main.church.name} | status=${plan.main.status} | created=${plan.main.createdAt.toISOString()}`);
  console.log('    Will merge into main:');
  for (const duplicate of plan.duplicates) {
    console.log(`    - ${duplicate.id} | ${duplicate.name} | ${duplicate.church.name} | status=${duplicate.status} | created=${duplicate.createdAt.toISOString()}`);
  }
  console.log('    Final linked churches:');
  for (const church of plan.finalChurches) {
    console.log(`    - ${church.name} (${church.id})`);
  }
  console.log('    Records that would be touched:');
  console.log(`    - donation_transactions campaignId: ${plan.counts.donations}`);
  console.log(`    - pledges campaignId: ${plan.counts.pledges}`);
  console.log(`    - scheduled_reminders campaignId: ${plan.counts.scheduledReminders}`);
  console.log(`    - pending_transactions metadata: ${plan.counts.pendingTransactions}`);
  console.log('    Duplicate campaigns would be marked cancelled after merge.');
}

async function applyPlan(plan: MergePlan): Promise<void> {
  const duplicateIds = plan.duplicates.map(campaign => campaign.id);
  const duplicateToMain = new Map(duplicateIds.map(id => [id, plan.main.id]));
  const mainNames = new Map([[plan.main.id, plan.main.name]]);

  await prisma.$transaction(async tx => {
    for (const church of plan.finalChurches) {
      await tx.givingCampaignChurch.upsert({
        where: { campaignId_churchId: { campaignId: plan.main.id, churchId: church.id } },
        create: { campaignId: plan.main.id, churchId: church.id },
        update: {},
      });
    }

    await tx.donationTransaction.updateMany({
      where: { campaignId: { in: duplicateIds } },
      data: { campaignId: plan.main.id },
    });

    await tx.pledge.updateMany({
      where: { campaignId: { in: duplicateIds } },
      data: { campaignId: plan.main.id },
    });

    await tx.scheduledReminder.updateMany({
      where: { campaignId: { in: duplicateIds } },
      data: { campaignId: plan.main.id },
    });

    const pendingTransactions = await tx.pendingTransaction.findMany({
      where: {
        status: 'pending',
        type: 'donation',
        OR: duplicateIds.map(id => ({ metadata: { contains: id } })),
      },
      select: { id: true, metadata: true },
    });

    for (const pending of pendingTransactions) {
      const metadata = updatePendingMetadata(pending.metadata, duplicateToMain, mainNames);
      if (metadata) {
        await tx.pendingTransaction.update({
          where: { id: pending.id },
          data: { metadata },
        });
      }
    }

    await tx.givingCampaign.updateMany({
      where: { id: { in: duplicateIds } },
      data: { status: 'cancelled' },
    });

    await tx.givingCampaign.update({
      where: { id: plan.main.id },
      data: {
        scopeType: plan.finalChurches.length > 1 ? 'selected_churches' : 'one_church',
      },
    });
  });
}

async function main() {
  const plans = await buildPlans();

  if (plans.length === 0) {
    console.log('No duplicate giving campaigns found for the current matching rules.');
    return;
  }

  console.log(`Found ${plans.length} duplicate giving campaign group(s).`);
  plans.forEach(printPlan);

  if (!apply) {
    console.log('\nDry run only. No database changes made.');
    console.log('Run with --apply to execute these merges.');
    console.log('Optional: add --include-inactive if you also want cancelled campaigns considered in the grouping.');
    return;
  }

  console.log('\nApplying merge plans...');
  for (const plan of plans) {
    await applyPlan(plan);
    console.log(`Merged group "${plan.main.name}" into ${plan.main.id}`);
  }
  console.log('Done.');
}

main()
  .catch(error => {
    if (error?.code === 'P2022' && String(error?.meta?.column || '').includes('giving_campaigns.scopeType')) {
      console.error('The giving campaign scope migration has not been applied to this database yet.');
      console.error('Run this first: npx prisma migrate deploy');
      console.error('Then rerun: npm run giving:merge-duplicates');
      process.exitCode = 1;
      return;
    }
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
