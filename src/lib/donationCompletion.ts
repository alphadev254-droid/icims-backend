import prisma from './prisma';
import { queueEmail } from './emailQueue';
import { donationReceiptTemplate } from './emailTemplates';
import { generateReceiptPDF } from './receiptPDF';
import { creditChurchWallet } from '../utils/walletOperations';

type DonationLine = {
  campaignId: string;
  campaignName?: string;
  amount: number;
  cellId?: string | null;
  pledgeId?: string | null;
};

function getDonationLines(metadata: any): DonationLine[] {
  if (Array.isArray(metadata.items) && metadata.items.length > 0) {
    return metadata.items.map((item: any) => ({
      campaignId: item.campaignId,
      campaignName: item.campaignName,
      amount: Number(item.amount),
      cellId: item.cellId ?? null,
      pledgeId: item.pledgeId ?? null,
    }));
  }

  return [{
    campaignId: metadata.campaignId,
    campaignName: metadata.campaignName,
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
  const isGuest = metadata.isGuest === true;
  const created: any[] = [];

  for (const line of lines) {
    const donationTx = await prisma.donationTransaction.create({
      data: {
        campaignId: line.campaignId,
        userId: isGuest ? null : pendingTx.userId,
        churchId: pendingTx.churchId,
        amount: line.amount,
        currency,
        transactionId,
        reference,
        paymentMethod,
        status: 'completed',
        isAnonymous: metadata.isAnonymous || false,
        isGuest,
        guestName: isGuest ? metadata.guestName : null,
        guestEmail: isGuest ? metadata.guestEmail : null,
        guestPhone: isGuest ? metadata.guestPhone : null,
        donorName: metadata.donorName,
        donorEmail: metadata.donorEmail,
        donorPhone: metadata.donorPhone,
        notes: metadata.notes,
        cellId: line.cellId || null,
        pledgeId: line.pledgeId || null,
      },
    });

    let pledgeId = line.pledgeId || null;
    if (!pledgeId && !isGuest && pendingTx.userId && line.campaignId) {
      const activePledge = await prisma.pledge.findFirst({
        where: {
          userId: pendingTx.userId,
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
      pendingTx.churchId,
      line.amount,
      'donation',
      transactionId,
      `Donation - ${line.campaignName || line.campaignId}`,
    );

    created.push(donationTx);
  }

  const donor = isGuest
    ? null
    : await prisma.user.findUnique({ where: { id: pendingTx.userId }, select: { email: true, firstName: true, lastName: true } });

  const guestFirstName = metadata.guestName?.split(' ')[0] || 'Donor';
  const donorEmail = isGuest ? metadata.guestEmail : donor?.email || gatewayCustomerEmail || metadata.donorEmail;
  if (!donorEmail) return created;

  const campaigns = await prisma.givingCampaign.findMany({
    where: { id: { in: lines.map(line => line.campaignId) } },
    include: { church: { select: { name: true } } },
  });
  const campaignMap = new Map(campaigns.map(campaign => [campaign.id, campaign]));
  const firstCampaign = campaigns[0];
  if (!firstCampaign) return created;

  const donorFirstName = isGuest ? guestFirstName : donor?.firstName || 'Donor';
  const donorFullName = isGuest
    ? metadata.guestName || 'Donor'
    : `${donor?.firstName || ''} ${donor?.lastName || ''}`.trim() || donorFirstName;
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
      { label: 'Church', value: firstCampaign.church.name },
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
      isGuest,
      churchName: firstCampaign.church.name,
    }),
    [{ filename: `donation-receipt-${reference}.pdf`, content: receiptPDF }],
  );

  return created;
}
