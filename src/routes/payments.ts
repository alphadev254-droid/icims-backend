import { Router } from 'express';
import { initiatePackageSubscription, initiatePublicInvoicePayment, verifyPayment } from '../controllers/paymentController';
import { initiateTicketPurchase } from '../controllers/ticketPaymentController';
import { initiateGuestTicketPurchase, getGuestTicketFees, getTransactionByReference } from '../controllers/guestTicketController';
import { getGuestDonationFees } from '../controllers/givingController';
import { authenticate } from '../middleware/auth';
import { requireFeature } from '../middleware/packageCheck';

const router = Router();

router.post('/subscribe-package', authenticate, initiatePackageSubscription);
router.post('/invoice/:token/pay', initiatePublicInvoicePayment);
router.post('/purchase-ticket', authenticate, requireFeature('event_online_payments'), initiateTicketPurchase);
router.post('/guest-ticket', initiateGuestTicketPurchase);
router.get('/guest-ticket/fees', getGuestTicketFees);
router.get('/guest-donation/fees', getGuestDonationFees);
router.get('/transaction/:reference', getTransactionByReference);
router.get('/verify', verifyPayment);

export default router;
