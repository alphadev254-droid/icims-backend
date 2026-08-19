import { Router } from 'express';
import { authenticate, authorizeSystemAdmin } from '../middleware/auth';
import {
  getAdminStats,
  getAdminUsers,
  getAdminUser,
  getAdminUserRoleOptions,
  updateAdminUser,
  deleteAdminUser,
  resetAdminUserPassword,
  sendEmailToUser,
  manageAdminSubscription,
  updateAdminSubscription,
  getAdminTransactions,
  getAdminSystemTransactions,
  getAdminSystemTransaction,
  getAdminWithdrawals,
  getAdminChurch,
  updateAdminChurch,
  deleteAdminChurch,
  updateAdminChurchUser,
  getAdminMinistries,
  getAdminPendingTransactions,
  reconcileAdminPendingTransaction,
} from '../controllers/adminController';
import {
  getPackages,
  getAllFeatures,
  createPackage,
  updatePackage,
  deletePackage,
  getConversionRates,
} from '../controllers/packageManagementController';
import {
  getAdminTreasuryBanks,
  getAdminTreasuryMinistryWallets,
  getAdminTreasurySummary,
  getAdminTreasuryWithdrawals,
  reconcileAdminWithdrawal,
  requestAdminTreasuryWithdrawal,
  sendAdminTreasuryOtp,
} from '../controllers/adminTreasuryController';
import {
  cancelAdminPackageInvoice,
  createAdminPackageInvoice,
  getAdminPackageInvoice,
  getAdminPackageInvoices,
  recordAdminPackageInvoicePayment,
  sendAdminPackageInvoice,
  updateAdminPackageInvoice,
} from '../controllers/packageInvoiceController';

const router = Router();
router.use(authenticate, authorizeSystemAdmin);

router.get('/stats', getAdminStats);

router.get('/ministries', getAdminMinistries);

router.get('/users', getAdminUsers);
router.get('/users/:id', getAdminUser);
router.get('/users/:id/role-options', getAdminUserRoleOptions);
router.put('/users/:id', updateAdminUser);
router.delete('/users/:id', deleteAdminUser);
router.post('/users/:id/reset-password', resetAdminUserPassword);
router.post('/users/:id/send-email', sendEmailToUser);
router.post('/users/:id/subscription', manageAdminSubscription);
router.put('/users/:id/subscription/:subId', updateAdminSubscription);

router.get('/transactions', getAdminTransactions);
router.get('/system-transactions', getAdminSystemTransactions);
router.get('/system-transactions/:id', getAdminSystemTransaction);
router.get('/withdrawals', getAdminWithdrawals);
router.get('/treasury/summary', getAdminTreasurySummary);
router.get('/treasury/ministry-wallets', getAdminTreasuryMinistryWallets);
router.get('/treasury/withdrawals', getAdminTreasuryWithdrawals);
router.get('/treasury/banks', getAdminTreasuryBanks);
router.post('/treasury/withdraw/otp', sendAdminTreasuryOtp);
router.post('/treasury/withdraw', requestAdminTreasuryWithdrawal);
router.post('/treasury/withdrawals/:kind/:id/reconcile', reconcileAdminWithdrawal);

router.get('/churches/:id', getAdminChurch);
router.put('/churches/:id', updateAdminChurch);
router.delete('/churches/:id', deleteAdminChurch);

router.put('/church-users/:id', updateAdminChurchUser);

// Package management
router.get('/packages/rates', getConversionRates);
router.get('/packages', getPackages);
router.post('/packages', createPackage);
router.put('/packages/:id', updatePackage);
router.delete('/packages/:id', deletePackage);

// Feature management (read-only — features are seeded, not created via UI)
router.get('/packages/features', getAllFeatures);

// Pending transaction metadata (superadmin debug tool)
router.get('/pending-transactions', getAdminPendingTransactions);
router.post('/pending-transactions/:id/reconcile', reconcileAdminPendingTransaction);

// Package invoices
router.get('/invoices', getAdminPackageInvoices);
router.post('/invoices', createAdminPackageInvoice);
router.get('/invoices/:id', getAdminPackageInvoice);
router.put('/invoices/:id', updateAdminPackageInvoice);
router.post('/invoices/:id/send', sendAdminPackageInvoice);
router.post('/invoices/:id/payments', recordAdminPackageInvoicePayment);
router.post('/invoices/:id/cancel', cancelAdminPackageInvoice);

// All churches list (for filter dropdowns)
router.get('/all-churches', async (req, res) => {
  const ministry = req.query.ministry as string | undefined;
  const q = String(req.query.q || '').trim();
  const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
  const limit = Math.min(100, Math.max(10, parseInt(String(req.query.limit || '30'), 10) || 30));
  const skip = (page - 1) * limit;
  const where: any = {
    status: 'active',
    ...(ministry ? { ministryAdminId: ministry } : {}),
    ...(q ? {
      OR: [
        { name: { contains: q } },
        { location: { contains: q } },
        { region: { contains: q } },
        { district: { contains: q } },
      ],
    } : {}),
  };
  const churches = await (await import('../lib/prisma')).default.church.findMany({
    where,
    select: { id: true, name: true, ministryAdminId: true, location: true, region: true, district: true },
    orderBy: { name: 'asc' },
    skip,
    take: limit,
  });
  const total = await (await import('../lib/prisma')).default.church.count({ where });
  res.json({ success: true, data: churches, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
});

export default router;
