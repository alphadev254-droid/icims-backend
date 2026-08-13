import prisma from './prisma';
import { queueEmail } from './emailQueue';
import { donationReceiptTemplate } from './emailTemplates';
import { generateReceiptPDF } from './receiptPDF';
import { creditChurchWallet } from '../utils/walletOperations';
import { getEffectiveDonationDonor } from './donationMemberMatching';

type DonationLine = {
  campaignId: string;
  campaignName?: string;
  churchId?: string | null;
  amount: number;
  cellId?: string | null;
  pledgeId?: string | null;
};

function getDonationLines(metadata: any): DonationLine[] {
  if (Array.isArray(metadata.items) && metadata.items.length > 0) {
    return metadata.items.map((item: any) => ({
      campaignId: item.campaignId,
      campaignName: item.campaignName,
      churchId: item.churchId ?? null,
      amount: Number(item.amount),
      cellId: item.cellId ?? null,
      pledgeId: item.pledgeId ?? null,
    }));
  }

  return [{
    campaignId: metadata.campaignId,
    campaignName: metadata.campaignName,
    churchId: metadata.churchId ?? null,
    amount: Number(metadata.baseAmount),
    cellId: metadata.cellId ?? null,
    pledgeId: metadata.pledgeId ?? null,
  }];
}

export function hasMultipleDonationLines(metadata: any): boolean {
  return Array.isArray(metadata.items) && metadata.items.length > 1;
}

export async function createDonationRecordsForTransaction(args: {
  pendingTx: any;
  metadata: any;
  transactionId: string;
  reference: string;
  currency: string;
  paymentMethod: string;
  paidAt?: Date;
  gatewayCustomerEmail?: string | null;
}) {
  const { pendingTx, metadata, transactionId, reference, currency, paymentMethod, gatewayCustomerEmail } = args;
  const lines = getDonationLines(metadata);
  const { effectiveUserId, effectiveIsGuest } = getEffectiveDonationDonor(pendingTx, metadata);
  const created: any[] = [];

  for (const line of lines) {
    const lineChurchId = line.churchId || pendingTx.churchId;
    const donationTx = await prisma.donationTransaction.create({
      data: {
        campaignId: line.campaignId,
        userId: effectiveUserId,
        churchId: lineChurchId,
        amount: line.amount,
        currency,
        transactionId,
        reference,
        paymentMethod,
        status: 'completed',
        isAnonymous: metadata.isAnonymous || false,
        isGuest: effectiveIsGuest,
        guestName: effectiveIsGuest ? metadata.guestName : null,
        guestEmail: effectiveIsGuest ? metadata.guestEmail : null,
        guestPhone: effectiveIsGuest ? metadata.guestPhone : null,
        donorName: metadata.donorName,
        donorEmail: metadata.donorEmail,
        donorPhone: metadata.donorPhone,
        notes: metadata.notes,
        cellId: line.cellId || null,
        pledgeId: line.pledgeId || null,
      },
    });

    let pledgeId = line.pledgeId || null;
    if (!pledgeId && !effectiveIsGuest && effectiveUserId && line.campaignId) {
      const activePledge = await prisma.pledge.findFirst({
        where: {
          userId: effectiveUserId,
          campaignId: line.campaignId,
          status: { in: ['pending', 'partial', 'overdue'] },
        },
      });
      pledgeId = activePledge?.id ?? null;
      if (pledgeId) {
        await prisma.donationTransaction.update({ where: { id: donationTx.id }, data: { pledgeId } });
      }
    }

    if (pledgeId) {
      const { recalculatePledgeStatus } = await import('../controllers/pledgeController');
      await recalculatePledgeStatus(pledgeId);
    }

    await creditChurchWallet(
      lineChurchId,
      line.amount,
      'donation',
      transactionId,
      `Donation - ${line.campaignName || line.campaignId}`,
    );

    created.push(donationTx);
  }

  const donor = effectiveIsGuest || !effectiveUserId
    ? null
    : await prisma.user.findUnique({ where: { id: effectiveUserId }, select: { email: true, firstName: true, lastName: true } });

  const guestFirstName = metadata.guestName?.split(' ')[0] || 'Donor';
  const donorEmail = effectiveIsGuest
    ? metadata.guestEmail
    : metadata.guestEmail || donor?.email || gatewayCustomerEmail || metadata.donorEmail;
  if (!donorEmail) return created;

  const campaigns = await prisma.givingCampaign.findMany({
    where: { id: { in: lines.map(line => line.campaignId) } },
    include: { church: { select: { name: true } } },
  });
  const campaignMap = new Map(campaigns.map(campaign => [campaign.id, campaign]));
  const firstCampaign = campaigns[0];
  if (!firstCampaign) return created;
  const receivingChurch = await prisma.church.findUnique({
    where: { id: pendingTx.churchId },
    select: { name: true },
  });
  const receivingChurchName = receivingChurch?.name || firstCampaign.church.name;

  const donorFirstName = effectiveIsGuest ? guestFirstName : donor?.firstName || guestFirstName;
  const donorFullName = effectiveIsGuest
    ? metadata.guestName || 'Donor'
    : `${donor?.firstName || ''} ${donor?.lastName || ''}`.trim() || metadata.guestName || donorFirstName;
  const totalBaseAmount = lines.reduce((sum, line) => sum + line.amount, 0);
  const isMultiple = lines.length > 1;
  const campaignName = isMultiple ? `${lines.length} giving items` : firstCampaign.name;

  const receiptPDF = await generateReceiptPDF({
    receiptNumber: reference,
    type: 'donation',
    customerName: donorFullName,
    customerEmail: donorEmail,
    amount: totalBaseAmount,
    currency,
    paidAt: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
    paymentMethod,
    description: isMultiple ? 'Multiple giving items' : `Donation to ${firstCampaign.name}`,
    itemDetails: [
      ...lines.map(line => ({
        label: campaignMap.get(line.campaignId)?.name || line.campaignName || 'Campaign',
        value: `${currency} ${line.amount.toLocaleString()}`,
      })),
      { label: 'Church', value: receivingChurchName },
      { label: 'Anonymous', value: metadata.isAnonymous ? 'Yes' : 'No' },
    ],
  });

  await queueEmail(
    donorEmail,
    isMultiple ? 'Donation Receipt - Multiple Gifts' : `Donation Receipt - ${firstCampaign.name}`,
    donationReceiptTemplate({
      firstName: donorFirstName,
      amount: totalBaseAmount,
      currency,
      campaignName,
      reference,
      isAnonymous: metadata.isAnonymous || false,
      isGuest: effectiveIsGuest,
      churchName: receivingChurchName,
    }),
    [{ filename: `donation-receipt-${reference}.pdf`, content: receiptPDF }],
  );

  return created;
}
