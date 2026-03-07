import { Router } from 'express';
import { initiatePackageSubscription, verifyPayment } from '../controllers/paymentController';
import { initiateTicketPurchase } from '../controllers/ticketPaymentController';
import { authenticate } from '../middleware/auth';

const router = Router();

router.post('/subscribe-package', authenticate, initiatePackageSubscription);
router.post('/purchase-ticket', authenticate, initiateTicketPurchase);
router.get('/verify', verifyPayment);

export default router;
