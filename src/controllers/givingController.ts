import { Request, Response } from 'express';
import { z } from 'zod';
import axios from 'axios';
import prisma from '../lib/prisma';

const createCampaignSchema = z.object({
  churchId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  category: z.enum(['tithe', 'offering', 'partnership', 'welfare', 'missions']),
  subcategory: z.string().optional(),
  targetAmount: z.number().positive().optional(),
  currency: z.enum(['MWK', 'KSH']).default('MWK'),
  endDate: z.string().optional(),
  imageUrl: z.string().optional(),
});

const updateCampaignSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  subcategory: z.string().optional(),
  targetAmount: z.number().positive().optional(),
  currency: z.enum(['MWK', 'KSH']).optional(),
  status: z.enum(['active', 'completed', 'cancelled']).optional(),
  endDate: z.string().optional(),
  imageUrl: z.string().optional(),
});

export async function createCampaign(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const roleName = req.user?.role;

  // Check if user has giving_tracking feature
  const { hasFeature } = await import('../lib/packageChecker');
  if (!(await hasFeature(userId!, 'giving_tracking'))) {
    res.status(403).json({ success: false, message: 'Your package does not include Giving & Donations. Please upgrade to access this feature.' });
    return;
  }

  const parsed = createCampaignSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const { churchId, endDate, ...data } = parsed.data;

  // Check if Kenya account has subaccount for receiving donations
  const { getPaymentGateway } = await import('../utils/gatewayRouter');
  const gateway = await getPaymentGateway(userId!);
  
  if (gateway === 'paystack') {
    // Kenya account - check for subaccount
    const subaccount = await prisma.subaccount.findUnique({
      where: { churchId }
    });
    
    if (!subaccount) {
      res.status(400).json({ 
        success: false, 
        message: 'To create giving campaigns, you need to set up a Paystack subaccount first. Please go to Branches > Finance account management to create your finance account.' 
      });
      return;
    }
  }

  // Verify user has access to this church
  let hasAccess = false;
  if (roleName === 'national_admin') {
    const church = await prisma.church.findUnique({ where: { id: churchId }, select: { nationalAdminId: true } });
    hasAccess = church?.nationalAdminId === userId;
  } else if (roleName === 'local_admin') {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { traditionalAuthorities: true } });
    const church = await prisma.church.findUnique({ where: { id: churchId }, select: { traditionalAuthority: true } });
    if (user?.traditionalAuthorities && church) {
      const tas = JSON.parse(user.traditionalAuthorities);
      hasAccess = tas.includes(church.traditionalAuthority);
    }
  } else if (roleName === 'district_overseer') {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { districts: true } });
    const church = await prisma.church.findUnique({ where: { id: churchId }, select: { district: true } });
    if (user?.districts && church) {
      const districts = JSON.parse(user.districts);
      hasAccess = districts.includes(church.district);
    }
  } else if (roleName === 'regional_leader') {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { regions: true } });
    const church = await prisma.church.findUnique({ where: { id: churchId }, select: { region: true } });
    if (user?.regions && church) {
      const regions = JSON.parse(user.regions);
      hasAccess = regions.includes(church.region);
    }
  }

  if (!hasAccess) {
    res.status(403).json({ success: false, message: 'Access denied to this church' });
    return;
  }

  const campaign = await prisma.givingCampaign.create({
    data: {
      ...data,
      churchId,
      endDate: endDate ? new Date(endDate) : null,
    },
  });

  res.status(201).json({ success: true, data: campaign });
}

export async function getCampaigns(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const roleName = req.user?.role;
  const { churchId, category, status } = req.query;

  // Get user's accessible churches based on role
  let accessibleChurchIds: string[] = [];

  if (roleName === 'member') {
    // Members see only their church's campaigns
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { churchId: true } });
    if (user?.churchId) accessibleChurchIds = [user.churchId];
  } else if (roleName === 'local_admin') {
    // Local admin sees churches in their traditional authorities
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { traditionalAuthorities: true } });
    if (user?.traditionalAuthorities) {
      const tas = JSON.parse(user.traditionalAuthorities);
      const churches = await prisma.church.findMany({
        where: { traditionalAuthority: { in: tas } },
        select: { id: true },
      });
      accessibleChurchIds = churches.map(c => c.id);
    }
  } else if (roleName === 'district_overseer') {
    // District overseer sees churches in their district
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { districts: true } });
    if (user?.districts) {
      const districts = JSON.parse(user.districts);
      const churches = await prisma.church.findMany({
        where: { district: { in: districts } },
        select: { id: true },
      });
      accessibleChurchIds = churches.map(c => c.id);
    }
  } else if (roleName === 'regional_leader') {
    // Regional leader sees churches in their region
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { regions: true } });
    if (user?.regions) {
      const regions = JSON.parse(user.regions);
      const churches = await prisma.church.findMany({
        where: { region: { in: regions } },
        select: { id: true },
      });
      accessibleChurchIds = churches.map(c => c.id);
    }
  }
  // national_admin sees all churches (no filter)

  const campaigns = await prisma.givingCampaign.findMany({
    where: {
      ...(churchId && { churchId: String(churchId) }),
      ...(accessibleChurchIds.length > 0 && { churchId: { in: accessibleChurchIds } }),
      ...(category && { category: String(category) }),
      ...(status && { status: String(status) }),
      ...(roleName === 'member' && { status: 'active' }),
    },
    include: {
      church: { select: { name: true } },
      _count: { select: { donations: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  // Calculate total raised for each campaign
  const campaignsWithStats = await Promise.all(
    campaigns.map(async (campaign) => {
      const stats = await prisma.donationTransaction.aggregate({
        where: { campaignId: campaign.id, status: 'completed' },
        _sum: { amount: true },
      });

      // Count unique donors
      const uniqueDonors = await prisma.donationTransaction.findMany({
        where: { campaignId: campaign.id, status: 'completed' },
        select: { userId: true },
        distinct: ['userId'],
      });

      // Check if member has donated to this campaign
      let userHasDonated = false;
      if (roleName === 'member') {
        const userDonation = await prisma.donationTransaction.findFirst({
          where: { campaignId: campaign.id, userId, status: 'completed' },
        });
        userHasDonated = !!userDonation;
      }

      return {
        ...campaign,
        totalRaised: stats._sum.amount || 0,
        donorCount: uniqueDonors.length,
        userHasDonated,
      };
    })
  );

  res.json({ success: true, data: campaignsWithStats });
}

export async function getCampaign(req: Request, res: Response): Promise<void> {
  const { id } = req.params;

  const campaign = await prisma.givingCampaign.findUnique({
    where: { id: String(id) },
    include: {
      church: { select: { name: true } },
      _count: { select: { donations: true } },
    },
  });

  if (!campaign) {
    res.status(404).json({ success: false, message: 'Campaign not found' });
    return;
  }

  const stats = await prisma.donationTransaction.aggregate({
    where: { campaignId: String(id), status: 'completed' },
    _sum: { amount: true },
  });

  // Count unique donors
  const uniqueDonors = await prisma.donationTransaction.findMany({
    where: { campaignId: String(id), status: 'completed' },
    select: { userId: true },
    distinct: ['userId'],
  });

  res.json({
    success: true,
    data: {
      ...campaign,
      totalRaised: stats._sum?.amount || 0,
      donorCount: uniqueDonors.length,
    },
  });
}

export async function updateCampaign(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const userId = req.user?.userId;
  const roleName = req.user?.role;

  const parsed = updateCampaignSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  // Check if campaign exists and user has access
  const existingCampaign = await prisma.givingCampaign.findUnique({ 
    where: { id: String(id) }, 
    include: { church: true } 
  });
  if (!existingCampaign) {
    res.status(404).json({ success: false, message: 'Campaign not found' });
    return;
  }

  let hasAccess = false;
  if (roleName === 'national_admin') {
    hasAccess = existingCampaign.church.nationalAdminId === userId;
  } else if (roleName === 'local_admin') {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { traditionalAuthorities: true } });
    if (user?.traditionalAuthorities) {
      const tas = JSON.parse(user.traditionalAuthorities);
      hasAccess = tas.includes(existingCampaign.church.traditionalAuthority);
    }
  } else if (roleName === 'district_overseer') {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { districts: true } });
    if (user?.districts) {
      const districts = JSON.parse(user.districts);
      hasAccess = districts.includes(existingCampaign.church.district);
    }
  } else if (roleName === 'regional_leader') {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { regions: true } });
    if (user?.regions) {
      const regions = JSON.parse(user.regions);
      hasAccess = regions.includes(existingCampaign.church.region);
    }
  }

  if (!hasAccess) {
    res.status(403).json({ success: false, message: 'Access denied' });
    return;
  }

  const { endDate, ...data } = parsed.data;

  const campaign = await prisma.givingCampaign.update({
    where: { id: String(id) },
    data: {
      ...data,
      ...(endDate && { endDate: new Date(endDate) }),
    },
  });

  res.json({ success: true, data: campaign });
}

export async function deleteCampaign(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const userId = req.user?.userId;
  const roleName = req.user?.role;

  // Check if campaign exists and user has access
  const existingCampaign = await prisma.givingCampaign.findUnique({ 
    where: { id: String(id) }, 
    include: { church: true } 
  });
  if (!existingCampaign) {
    res.status(404).json({ success: false, message: 'Campaign not found' });
    return;
  }

  let hasAccess = false;
  if (roleName === 'national_admin') {
    hasAccess = existingCampaign.church.nationalAdminId === userId;
  } else if (roleName === 'local_admin') {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { traditionalAuthorities: true } });
    if (user?.traditionalAuthorities) {
      const tas = JSON.parse(user.traditionalAuthorities);
      hasAccess = tas.includes(existingCampaign.church.traditionalAuthority);
    }
  } else if (roleName === 'district_overseer') {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { districts: true } });
    if (user?.districts) {
      const districts = JSON.parse(user.districts);
      hasAccess = districts.includes(existingCampaign.church.district);
    }
  } else if (roleName === 'regional_leader') {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { regions: true } });
    if (user?.regions) {
      const regions = JSON.parse(user.regions);
      hasAccess = regions.includes(existingCampaign.church.region);
    }
  }

  if (!hasAccess) {
    res.status(403).json({ success: false, message: 'Access denied' });
    return;
  }

  await prisma.givingCampaign.delete({ where: { id: String(id) } });

  res.json({ success: true, message: 'Campaign deleted' });
}

export async function getDonations(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const roleName = req.user?.role;
  const { campaignId } = req.query;

  // Get user's accessible churches based on role
  let accessibleChurchIds: string[] = [];

  if (roleName === 'member') {
    // Members see only their own donations
    const donations = await prisma.donationTransaction.findMany({
      where: {
        userId,
        ...(campaignId && { campaignId: String(campaignId) }),
      },
      include: {
        campaign: { select: { name: true, category: true } },
        user: { select: { firstName: true, lastName: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, data: donations });
    return;
  }

  if (roleName === 'local_admin') {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { traditionalAuthorities: true } });
    if (user?.traditionalAuthorities) {
      const tas = JSON.parse(user.traditionalAuthorities);
      const churches = await prisma.church.findMany({
        where: { traditionalAuthority: { in: tas } },
        select: { id: true },
      });
      accessibleChurchIds = churches.map(c => c.id);
    }
  } else if (roleName === 'district_overseer') {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { districts: true } });
    if (user?.districts) {
      const districts = JSON.parse(user.districts);
      const churches = await prisma.church.findMany({
        where: { district: { in: districts } },
        select: { id: true },
      });
      accessibleChurchIds = churches.map(c => c.id);
    }
  } else if (roleName === 'regional_leader') {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { regions: true } });
    if (user?.regions) {
      const regions = JSON.parse(user.regions);
      const churches = await prisma.church.findMany({
        where: { region: { in: regions } },
        select: { id: true },
      });
      accessibleChurchIds = churches.map(c => c.id);
    }
  }
  // national_admin sees all donations (no filter)

  const donations = await prisma.donationTransaction.findMany({
    where: {
      ...(campaignId && { campaignId: String(campaignId) }),
      ...(accessibleChurchIds.length > 0 && { churchId: { in: accessibleChurchIds } }),
    },
    include: {
      campaign: { select: { name: true, category: true } },
      user: { select: { firstName: true, lastName: true, email: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  res.json({ success: true, data: donations });
}

const createDonationSchema = z.object({
  campaignId: z.string().min(1),
  amount: z.number().positive(),
  isAnonymous: z.boolean().optional().default(false),
  donorName: z.string().optional(),
  donorEmail: z.string().email().optional(),
  donorPhone: z.string().optional(),
  notes: z.string().optional(),
});

export async function createDonation(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const userEmail = req.user?.email;
  const traceId = `DON-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  console.log(`[${traceId}] ========== DONATION INITIATED ==========`);
  console.log(`[${traceId}] User ID: ${userId}`);

  const parsed = createDonationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const { campaignId, amount, isAnonymous, donorName, donorEmail, donorPhone, notes } = parsed.data;

  const campaign = await prisma.givingCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign) {
    res.status(404).json({ success: false, message: 'Campaign not found' });
    return;
  }

  if (campaign.status !== 'active') {
    res.status(400).json({ success: false, message: 'Campaign is not active' });
    return;
  }

  // Determine gateway using existing function
  const { getPaymentGateway, getCurrency, getGatewayCountry } = await import('../utils/gatewayRouter');
  const { calculatePaymentFees } = await import('../utils/feeCalculations');
  
  const gateway = await getPaymentGateway(userId!);
  const currency = getCurrency(gateway);
  const gatewayCountry = getGatewayCountry(gateway);
  
  console.log(`[${traceId}] Gateway: ${gateway}, Country: ${gatewayCountry}, Currency: ${currency}`);
  
  // Calculate fees
  const fees = calculatePaymentFees(amount, gatewayCountry);
  
  console.log(`[${traceId}] Fees - Base: ${fees.baseAmount}, Convenience: ${fees.convenienceFee}, Tax: ${fees.taxAmount}, Total: ${fees.totalAmount}`);

  // Create pending transaction
  const expiresAt = new Date();
  expiresAt.setMinutes(expiresAt.getMinutes() + 30);

  const pendingTx = await prisma.pendingTransaction.create({
    data: {
      amount: fees.totalAmount,
      currency,
      userId: userId!,
      churchId: campaign.churchId,
      type: 'donation',
      expiresAt,
      metadata: JSON.stringify({
        traceId,
        campaignId,
        campaignName: campaign.name,
        isAnonymous,
        donorName,
        donorPhone,
        notes,
        baseAmount: fees.baseAmount,
        convenienceFee: fees.convenienceFee,
        taxAmount: fees.taxAmount,
        totalAmount: fees.totalAmount,
        gateway,
        gatewayCountry,
      }),
    },
  });

  console.log(`[${traceId}] Pending transaction created: ${pendingTx.id}`);

  // Route to gateway
  if (gateway === 'paychangu') {
    return await initiatePaychanguDonation(pendingTx, userEmail!, donorEmail, fees, traceId, res);
  } else {
    return await initiatePaystackDonation(pendingTx, userEmail!, donorEmail, campaign, fees, currency, traceId, res);
  }
}

async function initiatePaystackDonation(
  pendingTx: any,
  userEmail: string,
  donorEmail: string | undefined,
  campaign: any,
  fees: any,
  currency: string,
  traceId: string,
  res: Response
): Promise<void> {
  console.log(`[${traceId}] Routing to Paystack`);
  
  const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY!;
  const PAYSTACK_BASE_URL = process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co';
  const BACKEND_URL = process.env.BACKEND_URL!;

  try {
    const metadata = JSON.parse(pendingTx.metadata);
    const amountInKobo = Math.round(fees.totalAmount * 100);
    
    // Get church subaccount
    const subaccount = await prisma.subaccount.findUnique({
      where: { churchId: campaign.churchId }
    });

    console.log(`[${traceId}] Subaccount found: ${subaccount ? subaccount.subaccountCode : 'NONE'}`);
    console.log(`[${traceId}] Subaccount name: ${subaccount ? subaccount.businessName : 'NONE'}`);

    const paystackPayload = {
      email: donorEmail || userEmail,
      amount: amountInKobo,
      currency: 'KES',
      callback_url: `${BACKEND_URL}/api/payments/verify`,
      metadata: {
        ...metadata,
        type: 'donation',
        pendingTxId: pendingTx.id,
        userId: pendingTx.userId,
        subaccountCode: subaccount?.subaccountCode,
        subaccountName: subaccount?.businessName,
      },
      ...(subaccount && {
        subaccount: subaccount.subaccountCode,
        transaction_charge: Math.round(fees.convenienceFee * 100),
        bearer: 'account',
      }),
    };

    const response = await axios.post(
      `${PAYSTACK_BASE_URL}/transaction/initialize`,
      paystackPayload,
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    await prisma.pendingTransaction.update({
      where: { id: pendingTx.id },
      data: { reference: response.data.data.reference },
    });

    console.log(`[${traceId}] Paystack SUCCESS`);
    res.json({
      success: true,
      data: {
        authorization_url: response.data.data.authorization_url,
        reference: response.data.data.reference,
        baseAmount: fees.baseAmount,
        convenienceFee: fees.convenienceFee,
        taxAmount: fees.taxAmount,
        totalAmount: fees.totalAmount,
        currency,
      },
    });
  } catch (error: any) {
    await prisma.pendingTransaction.delete({ where: { id: pendingTx.id } }).catch(() => {});
    console.error(`[${traceId}] Paystack error:`, error.message);
    res.status(500).json({
      success: false,
      message: error.response?.data?.message || 'Failed to initialize payment',
    });
  }
}

async function initiatePaychanguDonation(
  pendingTx: any,
  userEmail: string,
  donorEmail: string | undefined,
  fees: any,
  traceId: string,
  res: Response
): Promise<void> {
  console.log(`[${traceId}] Routing to Paychangu`);
  
  const PAYCHANGU_SECRET_KEY = process.env.PAYCHANGU_SECRET_KEY!;
  const BACKEND_URL = process.env.BACKEND_URL!;
  const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:8080';
  const tx_ref = `DON-${Date.now()}`;

  try {
    const metadata = JSON.parse(pendingTx.metadata);
    
    const paychanguPayload = {
      amount: fees.totalAmount,
      currency: 'MWK',
      email: donorEmail || userEmail,
      tx_ref,
      callback_url: `${BACKEND_URL}/api/webhooks/paychangu/callback`,
      return_url: `${BACKEND_URL}/api/webhooks/paychangu/callback`,
      customization: {
        title: `Donation: ${metadata.campaignName}`,
        description: 'Campaign donation'
      }
    };

    const response = await axios.post(
      'https://api.paychangu.com/payment',
      paychanguPayload,
      {
        headers: {
          Authorization: `Bearer ${PAYCHANGU_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    await prisma.pendingTransaction.update({
      where: { id: pendingTx.id },
      data: { reference: tx_ref },
    });

    console.log(`[${traceId}] Paychangu SUCCESS`);
    res.json({
      success: true,
      data: {
        authorization_url: response.data.data?.checkout_url,
        reference: tx_ref,
        baseAmount: fees.baseAmount,
        convenienceFee: fees.convenienceFee,
        taxAmount: fees.taxAmount,
        totalAmount: fees.totalAmount,
        currency: 'MWK',
      },
    });
  } catch (error: any) {
    await prisma.pendingTransaction.delete({ where: { id: pendingTx.id } }).catch(() => {});
    console.error(`[${traceId}] Paychangu error:`, error.message);
    res.status(500).json({
      success: false,
      message: error.response?.data?.message || 'Failed to initialize payment',
    });
  }
}

export async function getDonationTransaction(req: Request, res: Response): Promise<void> {
  const donationId = String(req.params.id);
  const userId = req.user?.userId;
  const roleName = req.user?.role ?? 'member';

  const donation = await prisma.donationTransaction.findUnique({
    where: { id: donationId },
    select: { userId: true, transactionId: true },
  });

  if (!donation) {
    res.status(404).json({ success: false, message: 'Donation not found' });
    return;
  }

  // Members can only see their own donation transactions
  if (roleName === 'member' && donation.userId !== userId) {
    res.status(403).json({ success: false, message: 'Access denied' });
    return;
  }

  if (!donation.transactionId) {
    res.status(404).json({ success: false, message: 'No transaction found' });
    return;
  }

  // Fetch transaction with role-based fields
  if (roleName === 'member') {
    // Members see limited fields (no totalFees)
    const transaction = await prisma.transaction.findUnique({
      where: { id: donation.transactionId },
      select: {
        amount: true,
        currency: true,
        paymentMethod: true,
        status: true,
        reference: true,
        paidAt: true,
        channel: true,
        baseAmount: true,
        convenienceFee: true,
        taxAmount: true,
        totalAmount: true,
        gateway: true,
      },
    });
    res.json({ success: true, data: transaction });
  } else {
    // Admins see all fields including totalFees
    const transaction = await prisma.transaction.findUnique({
      where: { id: donation.transactionId },
      select: {
        amount: true,
        currency: true,
        paymentMethod: true,
        status: true,
        reference: true,
        paidAt: true,
        channel: true,
        gatewayResponse: true,
        customerEmail: true,
        customerPhone: true,
        type: true,
        isManual: true,
        notes: true,
        createdAt: true,
        subaccountName: true,
        feeRate: true,
        baseAmount: true,
        convenienceFee: true,
        taxAmount: true,
        totalAmount: true,
        gateway: true,
      },
    });
    res.json({ success: true, data: transaction });
  }
}
