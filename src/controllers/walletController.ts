import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { getAccessibleChurchIds } from '../lib/churchScope';
import { calculateWithdrawalFee } from '../utils/feeCalculations';
import { debitChurchWallet, refundWithdrawal } from '../utils/walletOperations';
import axios from 'axios';
import { queueEmail } from '../lib/emailQueue';
import { withdrawalRequestUserTemplate, withdrawalRequestAdminTemplate } from '../lib/emailTemplates';

const PAYCHANGU_SECRET_KEY = process.env.PAYCHANGU_SECRET_KEY!;

// Simple in-memory cache for Paychangu supported banks/operators
let paychanguBanksCache: any[] | null = null;
let paychanguBanksCacheAt: number | null = null;
const BANKS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function fetchPaychanguBanks(): Promise<any[]> {
  const now = Date.now();
  if (paychanguBanksCache && paychanguBanksCacheAt && now - paychanguBanksCacheAt < BANKS_CACHE_TTL_MS) {
    return paychanguBanksCache;
  }

  const response = await axios.get(
    'https://api.paychangu.com/direct-charge/payouts/supported-banks?currency=MWK',
    {
      headers: {
        Authorization: `Bearer ${PAYCHANGU_SECRET_KEY}`,
      },
    },
  );

  const payload = response.data;
  const banks = Array.isArray(payload?.data) ? payload.data : payload;

  paychanguBanksCache = banks;
  paychanguBanksCacheAt = now;

  return banks;
}

export async function getWalletBalance(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const churchId = req.user?.churchId;
  const roleName = req.user?.role ?? 'member';

  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  // Get accessible churches based on role
  let churchIds: string[] = [];
  
  if (roleName === 'ministry_admin') {
    const churches = await prisma.church.findMany({
      where: { ministryAdminId: userId },
      select: { id: true }
    });
    churchIds = churches.map(c => c.id);
  } else if (roleName === 'member') {
    churchIds = churchId ? [churchId] : [];
  } else {
    churchIds = await getAccessibleChurchIds(
      roleName,
      churchId,
      req.user?.districts,
      req.user?.traditionalAuthorities,
      req.user?.regions,
      userId
    );
  }

  if (churchIds.length === 0) {
    res.json({ success: true, data: { balance: 0, currency: 'MWK' } });
    return;
  }

  // Get total balance from all accessible wallets
  const wallets = await prisma.wallet.findMany({
    where: { churchId: { in: churchIds } },
    select: { balance: true, currency: true }
  });

  const totalBalance = wallets.reduce((sum, w) => sum + w.balance, 0);
  const currency = wallets[0]?.currency || 'MWK';

  res.json({
    success: true,
    data: {
      balance: totalBalance,
      currency
    }
  });
}

export async function getWalletTransactions(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const churchId = req.user?.churchId;
  const roleName = req.user?.role ?? 'member';
  const { page = 1, limit = 20 } = req.query;

  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  // Get accessible churches based on role
  let churchIds: string[] = [];
  
  if (roleName === 'ministry_admin') {
    const churches = await prisma.church.findMany({
      where: { ministryAdminId: userId },
      select: { id: true }
    });
    churchIds = churches.map(c => c.id);
  } else if (roleName === 'member') {
    churchIds = churchId ? [churchId] : [];
  } else {
    churchIds = await getAccessibleChurchIds(
      roleName,
      churchId,
      req.user?.districts,
      req.user?.traditionalAuthorities,
      req.user?.regions,
      userId
    );
  }

  if (churchIds.length === 0) {
    res.json({ success: true, data: [], total: 0 });
    return;
  }

  const walletIds = await prisma.wallet.findMany({
    where: { churchId: { in: churchIds } },
    select: { id: true }
  });

  const skip = (Number(page) - 1) * Number(limit);

  const [transactions, total] = await Promise.all([
    prisma.walletTransaction.findMany({
      where: { walletId: { in: walletIds.map(w => w.id) } },
      orderBy: { createdAt: 'desc' },
      skip,
      take: Number(limit)
    }),
    prisma.walletTransaction.count({
      where: { walletId: { in: walletIds.map(w => w.id) } }
    })
  ]);

  res.json({ success: true, data: transactions, total });
}

const withdrawalSchema = z.object({
  amount: z.number().positive(),
  method: z.enum(['mobile_money', 'bank_transfer']),
  mobileOperator: z.enum(['airtel', 'tnm']).optional(),
  mobileNumber: z.string().optional(),
  bankCode: z.string().optional(),
  accountName: z.string().optional(),
  accountNumber: z.string().optional(),
}).refine(
  (data) => {
    if (data.method === 'mobile_money') {
      return !!data.mobileOperator && !!data.mobileNumber;
    }
    if (data.method === 'bank_transfer') {
      return !!data.bankCode && !!data.accountName && !!data.accountNumber;
    }
    return true;
  },
  { message: 'Missing required fields for withdrawal method' }
);

export async function requestWithdrawal(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const churchId = req.user?.churchId;
  const roleName = req.user?.role ?? 'member';

  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  // Block members from accessing withdrawals
  if (roleName === 'member') {
    res.status(403).json({ success: false, message: 'Members do not have access to withdrawals' });
    return;
  }

  console.log('=== WITHDRAWAL REQUEST ===');
  console.log('User ID:', userId);
  console.log('Role:', roleName);
  console.log('Church ID:', churchId);

  // Check permission
  const userPermissions = req.user?.permissions || [];
  if (!userPermissions.includes('withdrawals:create')) {
    res.status(403).json({ success: false, message: 'You do not have permission to create withdrawals' });
    return;
  }

  const parsed = withdrawalSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const { amount, method, mobileOperator, mobileNumber, bankCode, accountName, accountNumber } = parsed.data;

  // Get national admin to check account country
  let ministryAdminId: string;
  if (roleName === 'ministry_admin') {
    ministryAdminId = userId;
  } else {
    const currentUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { ministryAdminId: true }
    });
    ministryAdminId = currentUser?.ministryAdminId || '';
  }

  if (!ministryAdminId) {
    res.status(400).json({ success: false, message: 'No national admin found' });
    return;
  }

  const ministryAdmin = await prisma.user.findUnique({
    where: { id: ministryAdminId },
    select: { accountCountry: true }
  });

  if (ministryAdmin?.accountCountry !== 'Malawi') {
    res.status(403).json({ success: false, message: 'Withdrawals are only available for Malawi accounts' });
    return;
  }

  // Get accessible churches based on role
  let churchIds: string[] = [];
  
  if (roleName === 'ministry_admin') {
    const churches = await prisma.church.findMany({
      where: { ministryAdminId: userId },
      select: { id: true }
    });
    churchIds = churches.map(c => c.id);
    console.log('National admin churches:', churchIds);
  } else {
    churchIds = await getAccessibleChurchIds(
      roleName,
      churchId,
      req.user?.districts,
      req.user?.traditionalAuthorities,
      req.user?.regions,
      userId
    );
  }

  if (churchIds.length === 0) {
    console.error('ERROR: No accessible churches found');
    res.status(400).json({ success: false, message: 'No churches found' });
    return;
  }

  // Get all wallets from accessible churches
  const wallets = await prisma.wallet.findMany({
    where: { churchId: { in: churchIds } },
    include: { church: { select: { name: true, ministryAdminId: true } } }
  });

  console.log('Wallets found:', wallets.length);
  wallets.forEach(w => console.log('  -', w.church.name, ':', w.balance, w.currency));

  if (wallets.length === 0) {
    console.error('ERROR: No wallets found for accessible churches');
    res.status(400).json({ success: false, message: 'No wallet found. Please contact support.' });
    return;
  }

  // Calculate total available balance
  const totalBalance = wallets.reduce((sum, w) => sum + w.balance, 0);
  console.log('Total balance:', totalBalance);

  if (totalBalance < amount) {
    console.error('ERROR: Insufficient balance. Total:', totalBalance, 'Requested:', amount);
    res.status(400).json({ success: false, message: `Insufficient balance. Available: ${totalBalance}` });
    return;
  }

  // Use the first wallet with sufficient balance, or the one with highest balance
  let selectedWallet = wallets.find(w => w.balance >= amount) || wallets.sort((a, b) => b.balance - a.balance)[0];
  console.log('Selected wallet:', selectedWallet.id, 'Balance:', selectedWallet.balance);

  const fees = calculateWithdrawalFee(amount, method);
  console.log('Fees calculated:', fees);

  const withdrawal = await prisma.withdrawal.create({
    data: {
      walletId: selectedWallet.id,
      ministryAdminId: userId,
      amount: fees.amount,
      fee: fees.fee,
      netAmount: fees.netAmount,
      method,
      mobileOperator,
      mobileNumber,
      bankCode,
      accountName,
      accountNumber,
      status: 'pending',
      initiatedBy: userId,
    }
  });

  console.log('Withdrawal created:', withdrawal.id);

  await debitChurchWallet(
    selectedWallet.id,
    amount,
    'withdrawal',
    withdrawal.id,
    `Withdrawal request - ${method}`
  );

  console.log('Wallet debited successfully');

  // Get user details for email
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { firstName: true, lastName: true, email: true, ministryAdminId: true }
  });

  // Send email to user
 // Send email to user
if (user?.email) {
  const userEmailHtml = withdrawalRequestUserTemplate({
    firstName: user.firstName,
    amount,
    fee: fees.fee,
    netAmount: fees.netAmount,
    currency: selectedWallet.currency,
    method,
    withdrawalId: withdrawal.id,
    churchName: selectedWallet.church.name,
    mobileOperator,
    mobileNumber,
    bankCode,
    accountName,
    accountNumber,
  });
  await queueEmail(
    user.email,
    'Withdrawal Request Received',
    userEmailHtml,
    'withdrawal_request_user',
  );
}

  // Send email to national admin (only if requester is not the national admin)
  const adminId = roleName === 'ministry_admin' ? userId : (user?.ministryAdminId || selectedWallet.church.ministryAdminId);
  if (adminId && adminId !== userId) {
    const ministryAdmin = await prisma.user.findUnique({
      where: { id: adminId },
      select: { email: true }
    });

    if (ministryAdmin?.email && user) {
      const adminEmailHtml = withdrawalRequestAdminTemplate({
        userName: `${user.firstName} ${user.lastName}`,
        userEmail: user.email,
        amount,
        fee: fees.fee,
        netAmount: fees.netAmount,
        currency: selectedWallet.currency,
        method,
        withdrawalId: withdrawal.id,
        mobileOperator,
        mobileNumber,
        bankCode,
        accountName,
        accountNumber,
        churchName: selectedWallet.church.name,
      });
      await queueEmail(ministryAdmin.email, 'New Withdrawal Request', adminEmailHtml, 'withdrawal_request_admin');
    }
  }

  try {
    await processPaychanguPayout(withdrawal);
    
    // Fetch updated withdrawal status
    const updatedWithdrawal = await prisma.withdrawal.findUnique({
      where: { id: withdrawal.id }
    });

    res.json({
      success: true,
      data: {
        id: updatedWithdrawal!.id,
        amount: updatedWithdrawal!.amount,
        fee: updatedWithdrawal!.fee,
        netAmount: updatedWithdrawal!.netAmount,
        status: updatedWithdrawal!.status
      }
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      message: error.message || 'Withdrawal processing failed'
    });
  }
}

export async function getWithdrawals(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const churchId = req.user?.churchId;
  const roleName = req.user?.role ?? 'member';
  const { page = 1, limit = 20, startDate, endDate } = req.query;

  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  // Block members from accessing withdrawals
  if (roleName === 'member') {
    res.status(403).json({ success: false, message: 'Members do not have access to withdrawals' });
    return;
  }

  // Check permission
  const userPermissions = req.user?.permissions || [];
  if (!userPermissions.includes('withdrawals:read')) {
    res.status(403).json({ success: false, message: 'You do not have permission to view withdrawals' });
    return;
  }

  // Get accessible churches based on role
  let churchIds: string[] = [];
  
  if (roleName === 'ministry_admin') {
    const churches = await prisma.church.findMany({
      where: { ministryAdminId: userId },
      select: { id: true }
    });
    churchIds = churches.map(c => c.id);
  } else {
    churchIds = await getAccessibleChurchIds(
      roleName,
      churchId,
      req.user?.districts,
      req.user?.traditionalAuthorities,
      req.user?.regions,
      userId
    );
  }

  if (churchIds.length === 0) {
    res.json({ success: true, data: [], total: 0 });
    return;
  }

  const walletIds = await prisma.wallet.findMany({
    where: { churchId: { in: churchIds } },
    select: { id: true }
  });

  const skip = (Number(page) - 1) * Number(limit);

  // Build date filter
  const dateFilter: any = {};
  if (startDate) {
    dateFilter.gte = new Date(String(startDate));
  }
  if (endDate) {
    const endDateTime = new Date(String(endDate));
    endDateTime.setHours(23, 59, 59, 999);
    dateFilter.lte = endDateTime;
  }

  const [withdrawals, total] = await Promise.all([
    prisma.withdrawal.findMany({
      where: {
        walletId: { in: walletIds.map(w => w.id) },
        ...(Object.keys(dateFilter).length > 0 && { createdAt: dateFilter }),
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: Number(limit)
    }),
    prisma.withdrawal.count({
      where: {
        walletId: { in: walletIds.map(w => w.id) },
        ...(Object.keys(dateFilter).length > 0 && { createdAt: dateFilter }),
      }
    })
  ]);

  res.json({ success: true, data: withdrawals, total });
}

export async function getSupportedBanks(req: Request, res: Response): Promise<void> {
  try {
    const banks = await fetchPaychanguBanks();
    res.json({ success: true, data: banks });
  } catch (error: any) {
    console.error('❌ Failed to fetch Paychangu supported banks', error.response?.data || error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch supported banks' });
  }
}

async function processPaychanguPayout(withdrawal: any) {
  try {
    console.log('=== PAYCHANGU PAYOUT ===');
    console.log('Withdrawal ID:', withdrawal.id);
    console.log('Method:', withdrawal.method);
    console.log('Net Amount:', withdrawal.netAmount);

    // Map withdrawal details to Paychangu direct-charge payout payload
    let bankUuid: string;
    let accountNumber: string;
    let accountName: string | undefined = withdrawal.accountName || undefined;

    if (withdrawal.method === 'mobile_money') {
      // Dynamically resolve operator UUID from supported-banks list
      const banks = await fetchPaychanguBanks();
      const op = String(withdrawal.mobileOperator || '').toLowerCase();

      const match = banks.find((b: any) => {
        const name: string = String(b.name || '').toLowerCase();
        if (op === 'airtel') return name.includes('airtel');
        if (op === 'tnm') return name.includes('tnm') || name.includes('mpamba');
        return false;
      });

      const uuid = match?.uuid || match?.id || match?.bank_uuid;
      if (!uuid) {
        throw new Error(`Unable to resolve Paychangu bank UUID for mobile operator: ${withdrawal.mobileOperator}`);
      }
      bankUuid = uuid;

      // Normalise MSISDN to international format 265XXXXXXXXX
      if (!withdrawal.mobileNumber) {
        throw new Error('Missing mobileNumber for mobile money withdrawal');
      }
      let msisdn = String(withdrawal.mobileNumber).replace(/\D/g, '');
      if (msisdn.startsWith('0')) {
        msisdn = `265${msisdn.slice(1)}`;
      } else if (!msisdn.startsWith('265')) {
        msisdn = `265${msisdn}`;
      }
      accountNumber = msisdn;
      if (!accountName) accountName = 'Mobile Money Withdrawal';
    } else {
      // Bank transfer — bankCode is expected to hold the Paychangu bank_uuid
      if (!withdrawal.bankCode || !withdrawal.accountNumber) {
        throw new Error('Missing bank details for bank transfer withdrawal');
      }
      bankUuid = withdrawal.bankCode;
      accountNumber = String(withdrawal.accountNumber);
      if (!accountName) accountName = 'Bank Withdrawal';
    }

    const payoutPayload = {
      payout_method: 'bank_transfer',
      bank_uuid: bankUuid,
      amount: String(Math.round(withdrawal.netAmount)),
      charge_id: `PAYOUT-${withdrawal.id}`,
      bank_account_name: accountName,
      bank_account_number: accountNumber,
    };

    console.log('Paychangu Payout Payload:', payoutPayload);

    const response = await axios.post(
      'https://api.paychangu.com/direct-charge/payouts/initialize',
      payoutPayload,
      {
        headers: {
          Authorization: `Bearer ${PAYCHANGU_SECRET_KEY}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      },
    );

    console.log('✅ Paychangu Response Status:', response.status);
    console.log('✅ Paychangu Response Data:', JSON.stringify(response.data, null, 2));

    // Check if webhook already updated the status
    const currentWithdrawal = await prisma.withdrawal.findUnique({
      where: { id: withdrawal.id }
    });

    if (currentWithdrawal?.status === 'completed') {
      console.log('✅ Withdrawal already marked as completed by webhook');
      return;
    }

    await prisma.withdrawal.update({
      where: { id: withdrawal.id },
      data: {
        status: 'processing',
        chargeId: `PAYOUT-${withdrawal.id}`,
        gatewayResponse: JSON.stringify(response.data),
      },
    });

    console.log('✅ Withdrawal status updated to processing');
  } catch (error: any) {
    // Re-throw error to be caught by requestWithdrawal
    console.error('❌ PAYCHANGU PAYOUT FAILED');
    console.error('Error Message:', error.message);
    console.error('Error Response:', error.response?.data);
    console.error('Error Status:', error.response?.status);

    await refundWithdrawal(withdrawal.id);
    console.log('✅ Refund processed');
    
    // Convert error response to string for storage
    const fullReason = error.response?.data 
      ? JSON.stringify(error.response.data) 
      : error.message;
    
    // failureReason is TEXT in DB — keep full detail; truncate only as safety net
    const failureReason = fullReason.substring(0, 2000);
    
    await prisma.withdrawal.update({
      where: { id: withdrawal.id },
      data: {
        status: 'failed',
        failureReason,
        gatewayResponse: fullReason.length > 2000 ? fullReason : undefined,
      }
    });

    console.log('✅ Withdrawal status updated to failed');
    
    throw new Error(failureReason);
  }
}
