import { Router } from 'express';
import { authenticate, authenticateOptional } from '../middleware/auth';
import { authorizePermission } from '../middleware/auth';
import {
  getPackages, getCurrentPackage,
  getFeatures, createFeature, deleteFeature,
  setPackageFeatures,
  calculateFees,
  getPayments, createPayment, updatePayment,
} from '../controllers/packageController';
import { getMyPackageInvoice, getMyPackageInvoices, getPublicPackageInvoice } from '../controllers/packageInvoiceController';
import { Request, Response } from 'express';

// Public rates handler — reads from env, no DB needed
function getRates(_req: Request, res: Response): void {
  res.json({
    success: true,
    data: {
      kesRate:        parseFloat(process.env.USD_TO_KSH_RATE   || '129'),
      mwkRate:        parseFloat(process.env.USD_TO_MWK_RATE   || '1730'),
      kenyaDiscount:  parseFloat(process.env.KENYA_PACKAGE_DISCOUNT  || '1'),
      malawiDiscount: parseFloat(process.env.MALAWI_PACKAGE_DISCOUNT || '0.5'),
    },
  });
}

const router = Router();

// ─── Public routes (no auth required, but attach user if token present) ──────
router.get('/',         authenticateOptional, getPackages);   // Public pricing page + dashboard
router.get('/features', authenticateOptional, getFeatures);  // Public feature list
router.get('/rates',    getRates);                           // Public conversion rates
router.get('/invoices/public/:token', getPublicPackageInvoice);

// All other routes require authentication
router.use(authenticate);

// ─── Package tiers ────────────────────────────────────────────────────────────
router.get('/current',         getCurrentPackage);
router.get('/calculate-fees',  calculateFees);

// ─── Package features ─────────────────────────────────────────────────────────
router.post('/features',          authorizePermission('packages:manage'), createFeature);
router.delete('/features/:id',    authorizePermission('packages:manage'), deleteFeature);
router.put('/:id/features',       authorizePermission('packages:manage'), setPackageFeatures);

// ─── Payments ─────────────────────────────────────────────────────────────────
router.get('/payments',           authorizePermission('system_payments:view'), getPayments);
router.get('/invoices',           getMyPackageInvoices);
router.get('/invoices/:id',        getMyPackageInvoice);
router.post('/payments',          authorizePermission('payments:create'), createPayment);
router.put('/payments/:id',       authorizePermission('payments:create'), updatePayment);

export default router;
