import { Request, Response } from 'express';
import prisma from '../lib/prisma';

export async function paychanguCallback(req: Request, res: Response): Promise<void> {
  const { tx_ref, status } = req.query;
  const traceId = `CALLBACK-${Date.now()}`;
  
  console.log(`[${traceId}] ========== PAYCHANGU CALLBACK ==========`);
  console.log(`[${traceId}] Query params:`, req.query);
  console.log(`[${traceId}] tx_ref: ${tx_ref}, status: ${status}`);
  
  const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:8080';
  
   // Get transaction type from completed transaction or pending transaction
  let transactionType = 'package_subscription';
  try {
    // First check completed transaction (webhook may have already processed)
    const completedTx = await prisma.transaction.findFirst({
      where: { reference: String(tx_ref) },
      select: { type: true }
    });
    
    if (completedTx) {
      transactionType = completedTx.type;
      console.log(`[${traceId}] Transaction type from completed: ${transactionType}`);
    } else {
      // Fallback to pending transaction
      const pendingTx = await prisma.pendingTransaction.findUnique({
        where: { reference: String(tx_ref) },
        select: { type: true }
      });
      if (pendingTx) {
        transactionType = pendingTx.type;
        console.log(`[${traceId}] Transaction type from pending: ${transactionType}`);
      }
    }
  } catch (error) {
    console.error(`[${traceId}] Error fetching transaction type:`, error);
  }
  
  // Redirect user to frontend with transaction reference
  if (status === 'success' || !status) {
    console.log(`[${traceId}] Redirecting to success page`);
    res.redirect(`${FRONTEND_URL}/payment/callback?reference=${tx_ref}&status=success&type=${transactionType}`);
  } else {
    console.log(`[${traceId}] Redirecting to failure page`);
    res.redirect(`${FRONTEND_URL}/payment/callback?reference=${tx_ref}&status=failed&type=${transactionType}`);
  }
}
