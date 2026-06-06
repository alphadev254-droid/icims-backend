import { Router } from 'express';
import { authenticate, authorizeSystemAdmin } from '../middleware/auth';
import {
  getAdminStats,
  getAdminUsers,
  getAdminUser,
  updateAdminUser,
  deleteAdminUser,
  resetAdminUserPassword,
  sendEmailToUser,
  manageAdminSubscription,
  updateAdminSubscription,
  getAdminTransactions,
  getAdminSystemTransactions,
  getAdminSystemTransaction,
  getAdminChurch,
  updateAdminChurch,
  deleteAdminChurch,
  updateAdminChurchUser,
  getAdminMinistries,
  getAdminPendingTransactions,
} from '../controllers/adminController';
import {
  getPackages,
  getAllFeatures,
  createPackage,
  updatePackage,
  deletePackage,
  getConversionRates,
} from '../controllers/packageManagementController';

const router = Router();
router.use(authenticate, authorizeSystemAdmin);

router.get('/stats', getAdminStats);

router.get('/ministries', getAdminMinistries);

router.get('/users', getAdminUsers);
router.get('/users/:id', getAdminUser);
router.put('/users/:id', updateAdminUser);
router.delete('/users/:id', deleteAdminUser);
router.post('/users/:id/reset-password', resetAdminUserPassword);
router.post('/users/:id/send-email', sendEmailToUser);
router.post('/users/:id/subscription', manageAdminSubscription);
router.put('/users/:id/subscription/:subId', updateAdminSubscription);

router.get('/transactions', getAdminTransactions);
router.get('/system-transactions', getAdminSystemTransactions);
router.get('/system-transactions/:id', getAdminSystemTransaction);

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

// All churches list (for filter dropdowns)
router.get('/all-churches', async (req, res) => {
  const ministry = req.query.ministry as string | undefined;
  const churches = await (await import('../lib/prisma')).default.church.findMany({
    where: ministry ? { ministryAdminId: ministry } : {},
    select: { id: true, name: true, ministryAdminId: true },
    orderBy: { name: 'asc' },
    take: 500,
  });
  res.json({ success: true, data: churches });
});

export default router;
