/**
 * Payment Status Polling Endpoint
 * For callback page to check payment status
 */

import { Router } from 'express';
import prisma from '../lib/prisma';

const router = Router();

// GET /api/payment-status/:reference
router.get('/:reference', async (req, res) => {
  const { reference } = req.params;

  try {
    // 1. Check payments (package subscriptions)
    const payment = await prisma.payment.findFirst({
      where: { reference },
      select: { id: true, status: true, amount: true, currency: true, paidAt: true }
    });

    if (payment) {
      return res.json({
        found: true,
        status: payment.status,
        type: 'subscription',
        amount: payment.amount,
        currency: payment.currency,
        paidAt: payment.paidAt,
      });
    }

    // 2. Check transactions (event tickets)
    const transaction = await prisma.transaction.findFirst({
      where: { reference },
      select: { id: true, status: true, amount: true, currency: true, paidAt: true, type: true }
    });

    if (transaction) {
      return res.json({
        found: true,
        status: transaction.status,
        type: transaction.type,
        amount: transaction.amount,
        currency: transaction.currency,
        paidAt: transaction.paidAt,
      });
    }

    // 3. Check donation transactions (DON-xxx references)
    const donation = await prisma.donationTransaction.findFirst({
      where: { reference },
      select: { id: true, status: true, amount: true, currency: true, createdAt: true }
    });

    if (donation) {
      return res.json({
        found: true,
        status: donation.status,
        type: 'donation',
        amount: donation.amount,
        currency: donation.currency,
        paidAt: donation.createdAt,
      });
    }

    // Not found yet — still processing
    return res.json({
      found: false,
      status: 'pending',
    });

  } catch (error) {
    console.error('[PaymentStatus] Error:', error);
    res.status(500).json({ error: 'Failed to check status' });
  }
});

export default router;
