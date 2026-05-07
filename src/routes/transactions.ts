import { Router } from 'express';
import { getTransactions, getTransaction, updateTransactionStatus, exportTransactions, getGivingByMember } from '../controllers/transactionController';
import { authenticate, authorizePermission } from '../middleware/auth';

const router = Router();

router.use(authenticate);

router.get('/export', authorizePermission('transactions:read'), exportTransactions);
router.get('/giving-by-member', authorizePermission('donations:read'), getGivingByMember);
router.get('/', authorizePermission('transactions:read'), getTransactions);
router.get('/:id', authorizePermission('transactions:read'), getTransaction);
router.patch('/:id/status', authorizePermission('transactions:update'), updateTransactionStatus);

export default router;
