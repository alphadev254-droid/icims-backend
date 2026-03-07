import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import axios from 'axios';
import { getPaymentGateway, getCurrency, getGatewayCountry } from '../utils/gatewayRouter';
import { calculatePaymentFees } from '../utils/feeCalculations';

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY!;
const PAYSTACK_BASE_URL = process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co';
const SYSTEM_SUBACCOUNT_CODE = process.env.SYSTEM_SUBACCOUNT_CODE!;
const BACKEND_URL = process.env.BACKEND_URL!;

const subscribeSchema = z.object({
  packageId: z.string().min(1, 'Package ID required'),
  billingCycle: z.enum(['monthly', 'yearly']),
});

export async function initiatePackageSubscription(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const role = req.user?.role;
  const traceId = `PKG-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  console.log(`[${traceId}] ========== PACKAGE SUBSCRIPTION INITIATED ==========`);
  console.log(`[${traceId}] User ID: ${userId}, Role: ${role}`);
  console.log(`[${traceId}] Request body:`, req.body);
  
  if (!userId) {
    console.log(`[${traceId}] ERROR: Not authenticated`);
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const parsed = subscribeSchema.safeParse(req.body);
  if (!parsed.success) {
    console.log(`[${traceId}] ERROR: Validation failed:`, parsed.error.errors);
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const { packageId, billingCycle } = parsed.data;
  console.log(`[${traceId}] Package ID: ${packageId}, Billing: ${billingCycle}`);

  // Get current user with nationalAdminId field
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    console.log(`[${traceId}] ERROR: User not found`);
    res.status(404).json({ success: false, message: 'User not found' });
    return;
  }
  console.log(`[${traceId}] User found: ${user.email}`);

  // Determine national admin
  let nationalAdminId: string;
  let nationalAdmin: any;
  
  if (role === 'national_admin') {
    nationalAdminId = userId;
    nationalAdmin = user;
    console.log(`[${traceId}] User is national admin`);
  } else {
    // Other roles: get national admin from nationalAdminId field
    if (!user.nationalAdminId) {
      console.log(`[${traceId}] ERROR: No national admin assigned`);
      res.status(400).json({ success: false, message: 'No national admin assigned to your account' });
      return;
    }
    nationalAdminId = user.nationalAdminId;
    nationalAdmin = await prisma.user.findUnique({ where: { id: nationalAdminId } });
    if (!nationalAdmin) {
      console.log(`[${traceId}] ERROR: National admin not found: ${nationalAdminId}`);
      res.status(404).json({ success: false, message: 'National admin not found' });
      return;
    }
    console.log(`[${traceId}] National admin found: ${nationalAdmin.email}`);
  }

  if (!nationalAdmin.email) {
    console.log(`[${traceId}] ERROR: National admin email missing`);
    res.status(400).json({ success: false, message: 'National admin email required for payment' });
    return;
  }

  const pkg = await prisma.package.findUnique({ where: { id: packageId } });
  if (!pkg) {
    console.log(`[${traceId}] ERROR: Package not found: ${packageId}`);
    res.status(404).json({ success: false, message: 'Package not found' });
    return;
  }
  console.log(`[${traceId}] Package: ${pkg.name} (${pkg.displayName})`);

  const baseAmount = billingCycle === 'monthly' ? pkg.priceMonthly : pkg.priceYearly;
  
  // Determine gateway
  console.log(`[${traceId}] Calling getPaymentGateway for nationalAdminId: ${nationalAdminId}`);
  const gateway = await getPaymentGateway(nationalAdminId);
  const currency = getCurrency(gateway);
  const gatewayCountry = getGatewayCountry(gateway);
  
  console.log(`[${traceId}] Gateway: ${gateway}, Country: ${gatewayCountry}, Currency: ${currency}`);
  console.log(`[${traceId}] National Admin accountCountry: ${nationalAdmin.accountCountry}`);
  
  // Calculate fees (Kenya has no tax, Malawi has 17.5% tax)
  const fees = calculatePaymentFees(baseAmount, gatewayCountry);
  
  console.log(`[${traceId}] Fees - Base: ${fees.baseAmount}, Convenience: ${fees.convenienceFee}, Tax: ${fees.taxAmount}, Total: ${fees.totalAmount}`);
  console.log(`[${traceId}] Routing to: ${gateway === 'paychangu' ? 'PAYCHANGU (Malawi)' : 'PAYSTACK (Kenya)'}`);
  
  const amountInKobo = Math.round(fees.totalAmount * 100);
  


  // Create pending transaction (expires in 1 hour)
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + 1);

  const pendingTx = await prisma.pendingTransaction.create({
    data: {
      amount: fees.totalAmount,
      currency,
      userId,
      churchId: user.churchId || '',
      type: 'package_subscription',
      expiresAt,
      metadata: JSON.stringify({
        traceId,
        nationalAdminId,
        packageId,
        packageName: pkg.name,
        billingCycle,
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
  console.log(`[${traceId}] Pending transaction metadata:`, JSON.parse(pendingTx.metadata));

  // Route to appropriate gateway
  if (gateway === 'paychangu') {
    console.log(`[${traceId}] ========== ROUTING TO PAYCHANGU ==========`);
    return await initiatePaychanguPayment(pendingTx, nationalAdmin, fees, traceId, res);
  } else {
    console.log(`[${traceId}] ========== ROUTING TO PAYSTACK ==========`);
    return await initiatePaystackPayment(pendingTx, nationalAdmin, fees, traceId, res);
  }
}

async function initiatePaystackPayment(
  pendingTx: any,
  nationalAdmin: any,
  fees: any,
  traceId: string,
  res: Response
): Promise<void> {
  console.log(`[${traceId}] initiatePaystackPayment called`);
  const amountInKobo = Math.round(fees.totalAmount * 100);
  console.log(`[${traceId}] Amount in kobo: ${amountInKobo}`);

  try {
    const metadata = JSON.parse(pendingTx.metadata);
    const paystackPayload = {
      email: nationalAdmin.email,
      amount: amountInKobo,
      callback_url: `${BACKEND_URL}/api/payments/verify`,
      metadata: {
        ...metadata,
        type: 'package_subscription',
        pendingTxId: pendingTx.id,
        initiatedBy: pendingTx.userId,
      },
      ...(SYSTEM_SUBACCOUNT_CODE && { subaccount: SYSTEM_SUBACCOUNT_CODE }),
    };
    
    console.log(`[${traceId}] Paystack request:`, JSON.stringify(paystackPayload, null, 2));
    console.log(`[${traceId}] Calling Paystack API: ${PAYSTACK_BASE_URL}/transaction/initialize`);
    
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

    console.log(`[${traceId}] Paystack API call successful`);
    console.log(`[${traceId}] Paystack response:`, JSON.stringify(response.data, null, 2));

    // Update pending transaction with reference
    console.log(`[${traceId}] Updating pending transaction with reference: ${response.data.data.reference}`);
    await prisma.pendingTransaction.update({
      where: { id: pendingTx.id },
      data: { reference: response.data.data.reference },
    });

    console.log(`[${traceId}] Paystack SUCCESS:`, {
      reference: response.data.data.reference,
      access_code: response.data.data.access_code,
    });

    console.log(`[${traceId}] Sending response to client`);
    res.json({
      success: true,
      data: {
        authorization_url: response.data.data.authorization_url,
        access_code: response.data.data.access_code,
        reference: response.data.data.reference,
      },
    });
  } catch (error: any) {
    console.log(`[${traceId}] Paystack error occurred, deleting pending transaction`);
    await prisma.pendingTransaction.delete({ where: { id: pendingTx.id } }).catch(() => {});
    
    console.error(`[${traceId}] ========== PAYSTACK ERROR ==========`);
    console.error(`[${traceId}] Status:`, error.response?.status);
    console.error(`[${traceId}] Response:`, JSON.stringify(error.response?.data, null, 2));
    console.error(`[${traceId}] Message:`, error.message);
    
    if (error.response?.data?.message?.includes('No active channel')) {
      res.status(400).json({ 
        success: false, 
        message: 'Payment channels not activated. Please ensure SYSTEM_SUBACCOUNT_CODE is properly configured in Paystack.' 
      });
    } else {
      res.status(500).json({
        success: false,
        message: error.response?.data?.message || 'Failed to initialize payment',
      });
    }
  }
}

async function initiatePaychanguPayment(
  pendingTx: any,
  nationalAdmin: any,
  fees: any,
  traceId: string,
  res: Response
): Promise<void> {
  console.log(`[${traceId}] initiatePaychanguPayment called`);
  const PAYCHANGU_SECRET_KEY = process.env.PAYCHANGU_SECRET_KEY!;
  console.log(`[${traceId}] Paychangu secret key exists: ${!!PAYCHANGU_SECRET_KEY}`);

  try {
    const tx_ref = pendingTx.reference || `PKG-${Date.now()}`;
    console.log(`[${traceId}] Transaction reference: ${tx_ref}`);
    
    const paychanguPayload = {
      amount: fees.totalAmount,
      currency: 'MWK',
      email: nationalAdmin.email,
      tx_ref,
      callback_url: `${BACKEND_URL}/api/webhooks/paychangu/callback`,
      return_url: `${process.env.FRONTEND_URL}/dashboard/packages?status=cancelled`,
      customization: {
        title: 'Package Subscription',
        description: 'ICIMS Package Subscription'
      }
    };
    
    console.log(`[${traceId}] Paychangu request:`, JSON.stringify(paychanguPayload, null, 2));
    console.log(`[${traceId}] Calling Paychangu API: https://api.paychangu.com/payment`);
    
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

    console.log(`[${traceId}] Paychangu API call successful`);
    console.log(`[${traceId}] Paychangu response:`, JSON.stringify(response.data, null, 2));

    // Update pending transaction with reference
    console.log(`[${traceId}] Updating pending transaction with reference: ${tx_ref}`);
    await prisma.pendingTransaction.update({
      where: { id: pendingTx.id },
      data: { reference: tx_ref },
    });

    console.log(`[${traceId}] Paychangu SUCCESS:`, {
      checkout_url: response.data.data?.checkout_url,
    });

    console.log(`[${traceId}] Sending response to client`);
    res.json({
      success: true,
      data: {
        authorization_url: response.data.data?.checkout_url,
        reference: tx_ref,
      },
    });
  } catch (error: any) {
    console.log(`[${traceId}] Paychangu error occurred, deleting pending transaction`);
    await prisma.pendingTransaction.delete({ where: { id: pendingTx.id } }).catch(() => {});
    
    console.error(`[${traceId}] ========== PAYCHANGU ERROR ==========`);
    console.error(`[${traceId}] Status:`, error.response?.status);
    console.error(`[${traceId}] Response:`, JSON.stringify(error.response?.data, null, 2));
    console.error(`[${traceId}] Message:`, error.message);
    
    res.status(500).json({
      success: false,
      message: error.response?.data?.message || 'Failed to initialize payment',
    });
  }
}

export async function verifyPayment(req: Request, res: Response): Promise<void> {
  const { reference } = req.query;
  const traceId = `VERIFY-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  console.log(`[${traceId}] ========== PAYMENT VERIFICATION ==========`);
  console.log(`[${traceId}] Reference: ${reference}`);

  if (!reference) {
    console.log(`[${traceId}] ERROR: Missing reference`);
    res.status(400).json({ success: false, message: 'Reference required' });
    return;
  }

  try {
    console.log(`[${traceId}] Verifying with Paystack...`);
    
    const response = await axios.get(
      `${PAYSTACK_BASE_URL}/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        },
      }
    );

    const { data } = response.data;
    console.log(`[${traceId}] Paystack response:`, {
      status: data.status,
      amount: data.amount,
      currency: data.currency,
      paid_at: data.paid_at,
      metadata: data.metadata,
    });

    if (data.status === 'success') {
      const { metadata } = data;
      const amount = data.amount / 100;
      const type = metadata.type || 'event_ticket';
      const originalTraceId = metadata.traceId || 'UNKNOWN';

      console.log(`[${traceId}] Payment successful - Type: ${type}, Amount: ${amount}`);
      console.log(`[${traceId}] Original trace ID: ${originalTraceId}`);

      // Handle package subscription
      if (type === 'package_subscription') {
        console.log(`[${traceId}] Processing package subscription...`);
        
        const pkg = await prisma.package.findUnique({ where: { id: metadata.packageId } });
        console.log(`[${traceId}] Package: ${pkg?.name} (${pkg?.displayName})`);
        console.log(`[${traceId}] National Admin ID: ${metadata.nationalAdminId}`);

        // Get pending transaction
        const pendingTx = await prisma.pendingTransaction.findUnique({
          where: { id: metadata.pendingTxId },
        });
        console.log(`[${traceId}] Pending transaction: ${pendingTx?.id}`);

        // Parse metadata from pending transaction
        const pendingMetadata = pendingTx?.metadata ? JSON.parse(pendingTx.metadata) : {};
        const baseAmount = pendingMetadata.baseAmount || amount;
        const convenienceFee = pendingMetadata.convenienceFee || 0;
        const taxAmount = pendingMetadata.taxAmount || 0;
        const totalAmount = pendingMetadata.totalAmount || amount;
        const gateway = pendingMetadata.gateway || 'paystack';
        const gatewayCountry = pendingMetadata.gatewayCountry || 'Kenya';

        // Create full transaction record with all Paystack data
        const transaction = await prisma.transaction.create({
          data: {
            amount,
            currency: data.currency,
            status: 'completed',
            paymentMethod: data.channel || 'card',
            reference: data.reference,
            userId: metadata.initiatedBy,
            churchId: pendingTx?.churchId || null,
            type: 'package_subscription',
            paidAt: new Date(data.paid_at),
            channel: data.channel,
            customerEmail: data.customer?.email,
            customerPhone: data.customer?.phone,
            cardLast4: data.authorization?.last4,
            cardBank: data.authorization?.bank,
            baseAmount,
            convenienceFee,
            taxAmount,
            totalAmount,
            gateway,
            gatewayCountry,
            systemFeeAmount: data.fees || 0,
            gatewayResponse: JSON.stringify(data),
            subaccountName: 'ICIMS System',
          },
        });
        console.log(`[${traceId}] Transaction record created: ${transaction.id}`);

        // Create payment record
        const startsAt = new Date(data.paid_at);
        const expiresAt = new Date(startsAt);
        if (metadata.billingCycle === 'monthly') {
          expiresAt.setMonth(expiresAt.getMonth() + 1);
        } else {
          expiresAt.setFullYear(expiresAt.getFullYear() + 1);
        }

        const payment = await prisma.payment.create({
          data: {
            nationalAdminId: metadata.nationalAdminId,
            packageId: metadata.packageId,
            amount,
            currency: data.currency,
            type: 'package_subscription',
            status: 'completed',
            packageName: pkg?.name || 'Unknown',
            reference: data.reference,
            createdById: metadata.initiatedBy,
            billingCycle: metadata.billingCycle,
            baseAmount,
            convenienceFee,
            taxAmount,
            totalAmount,
            gateway,
            paymentMethod: data.channel || 'card',
            channel: data.channel,
            paidAt: new Date(data.paid_at),
            customerEmail: data.customer?.email,
            customerPhone: data.customer?.phone,
            cardLast4: data.authorization?.last4,
            cardBank: data.authorization?.bank,
            subaccountCode: data.subaccount?.subaccount_code || SYSTEM_SUBACCOUNT_CODE,
            subaccountName: data.subaccount?.business_name || 'ICIMS System',
            gatewayResponse: JSON.stringify(data),
            expiresAt,
          },
        });
        console.log(`[${traceId}] Payment record created: ${payment.id}`);

        // Create or update subscription
        await prisma.subscription.upsert({
          where: { nationalAdminId: metadata.nationalAdminId },
          create: {
            nationalAdminId: metadata.nationalAdminId,
            packageId: metadata.packageId,
            status: 'active',
            startsAt,
            expiresAt,
          },
          update: {
            packageId: metadata.packageId,
            status: 'active',
            startsAt,
            expiresAt,
          },
        });
        console.log(`[${traceId}] Subscription record created/updated`);

        // Delete pending transaction
        if (pendingTx) {
          await prisma.pendingTransaction.delete({ where: { id: pendingTx.id } });
          console.log(`[${traceId}] Pending transaction deleted`);
        }

        console.log(`[${traceId}] Redirecting to: /payment/callback?reference=${reference}&status=success&type=package_subscription`);

        res.redirect(`${process.env.FRONTEND_URL}/payment/callback?reference=${reference}&status=success&type=package_subscription`);
      } else if (type === 'event_ticket') {
        console.log(`[${traceId}] Processing event ticket...`);
        
        const pendingTx = await prisma.pendingTransaction.findUnique({
          where: { reference: String(reference) }
        });
        
        if (!pendingTx) {
          console.log(`[${traceId}] Pending transaction not found`);
          res.redirect(`${process.env.FRONTEND_URL}/payment/callback?reference=${reference}&status=failed`);
          return;
        }
        
        const pendingMetadata = JSON.parse(pendingTx.metadata);
        console.log(`[${traceId}] Fee breakdown - Base: ${pendingMetadata.baseAmount}, Convenience: ${pendingMetadata.convenienceFee}, Tax: ${pendingMetadata.taxAmount}, Total: ${pendingMetadata.totalAmount}`);
        
        // Create transaction
        const transaction = await prisma.transaction.create({
          data: {
            userId: metadata.userId || pendingTx.userId,
            churchId: pendingTx.churchId,
            eventId: pendingMetadata.eventId,
            type: 'event_ticket',
            amount: data.amount / 100,
            baseAmount: pendingMetadata.baseAmount,
            convenienceFee: pendingMetadata.convenienceFee,
            taxAmount: pendingMetadata.taxAmount,
            totalAmount: pendingMetadata.totalAmount,
            currency: data.currency,
            status: 'completed',
            gateway: pendingMetadata.gateway,
            gatewayCountry: pendingMetadata.gatewayCountry,
            reference: data.reference,
            paymentMethod: data.channel || 'card',
            channel: data.channel,
            paidAt: new Date(data.paid_at),
            customerEmail: data.customer?.email,
            customerPhone: data.customer?.phone,
            cardLast4: data.authorization?.last4,
            cardBank: data.authorization?.bank,
            systemFeeAmount: data.fees || 0,
            subaccountCode: metadata.subaccountCode || data.subaccount?.subaccount_code,
            subaccountName: metadata.subaccountName || data.subaccount?.business_name,
            gatewayResponse: JSON.stringify(data),
          }
        });
        
        console.log(`[${traceId}] Transaction created: ${transaction.id}`);
        console.log(`[${traceId}] Subaccount: ${transaction.subaccountCode} - ${transaction.subaccountName}`);
        console.log(`[${traceId}] Transaction saved with fees - Base: ${transaction.baseAmount}, Convenience: ${transaction.convenienceFee}, Tax: ${transaction.taxAmount}`);
        console.log(`[${traceId}] Tax applied: ${pendingMetadata.taxAmount > 0 ? 'YES' : 'NO'} (${pendingMetadata.gatewayCountry})`);
        
        // Create tickets
        const quantity = pendingMetadata.quantity || 1;
        const event = await prisma.event.findUnique({ where: { id: pendingMetadata.eventId } });
        
        for (let i = 0; i < quantity; i++) {
          const eventDate = new Date(event!.date).toISOString().slice(0, 10).replace(/-/g, '');
          const ticketCount = await prisma.eventTicket.count({ where: { eventId: pendingMetadata.eventId } });
          const eventPrefix = event!.title.replace(/\s+/g, '').substring(0, 6).toUpperCase();
          const ticketNumber = `${eventPrefix}-${eventDate}-${String(ticketCount + i + 1).padStart(4, '0')}`;
          
          await prisma.eventTicket.create({
            data: {
              ticketNumber,
              eventId: pendingMetadata.eventId,
              userId: pendingTx.userId,
              transactionId: transaction.id,
              status: 'confirmed'
            }
          });
        }
        
        // Update event
        await prisma.event.update({
          where: { id: pendingMetadata.eventId },
          data: { ticketsSold: { increment: quantity } }
        });
        
        // Delete pending transaction
        await prisma.pendingTransaction.delete({ where: { id: pendingTx.id } });
        
        console.log(`[${traceId}] ${quantity} ticket(s) created`);
        res.redirect(`${process.env.FRONTEND_URL}/payment/callback?reference=${reference}&status=success&type=event_ticket`);
      } else if (type === 'donation') {
        console.log(`[${traceId}] Processing donation...`);
        
        const pendingTx = await prisma.pendingTransaction.findUnique({
          where: { reference: String(reference) }
        });
        
        if (!pendingTx) {
          console.log(`[${traceId}] Pending transaction not found`);
          res.redirect(`${process.env.FRONTEND_URL}/payment/callback?reference=${reference}&status=failed`);
          return;
        }
        
        const pendingMetadata = JSON.parse(pendingTx.metadata);
        console.log(`[${traceId}] Fee breakdown - Base: ${pendingMetadata.baseAmount}, Convenience: ${pendingMetadata.convenienceFee}, Tax: ${pendingMetadata.taxAmount}, Total: ${pendingMetadata.totalAmount}`);
        
        // Create transaction
        const transaction = await prisma.transaction.create({
          data: {
            userId: metadata.userId || pendingTx.userId,
            churchId: pendingTx.churchId,
            type: 'donation',
            amount: data.amount / 100,
            baseAmount: pendingMetadata.baseAmount,
            convenienceFee: pendingMetadata.convenienceFee,
            taxAmount: pendingMetadata.taxAmount,
            totalAmount: pendingMetadata.totalAmount,
            currency: data.currency,
            status: 'completed',
            gateway: pendingMetadata.gateway,
            gatewayCountry: pendingMetadata.gatewayCountry,
            reference: data.reference,
            paymentMethod: data.channel || 'card',
            channel: data.channel,
            paidAt: new Date(data.paid_at),
            customerEmail: data.customer?.email,
            customerPhone: data.customer?.phone,
            cardLast4: data.authorization?.last4,
            cardBank: data.authorization?.bank,
            systemFeeAmount: data.fees || 0,
            subaccountCode: metadata.subaccountCode || data.subaccount?.subaccount_code,
            subaccountName: metadata.subaccountName || data.subaccount?.business_name,
            gatewayResponse: JSON.stringify(data),
          }
        });
        
        console.log(`[${traceId}] Transaction created: ${transaction.id}`);
        console.log(`[${traceId}] Subaccount: ${transaction.subaccountCode} - ${transaction.subaccountName}`);
        console.log(`[${traceId}] Transaction saved with fees - Base: ${transaction.baseAmount}, Convenience: ${transaction.convenienceFee}, Tax: ${transaction.taxAmount}`);
        console.log(`[${traceId}] Paystack gateway fee (data.fees): ${data.fees || 0} (currency: ${data.currency})`);
        console.log(`[${traceId}] Tax applied: ${pendingMetadata.taxAmount > 0 ? 'YES' : 'NO'} (${pendingMetadata.gatewayCountry})`);
        
        // Create donation record
        await prisma.donationTransaction.create({
          data: {
            campaignId: pendingMetadata.campaignId,
            userId: pendingTx.userId,
            churchId: pendingTx.churchId,
            amount: pendingMetadata.baseAmount,
            currency: data.currency,
            transactionId: transaction.id,
            reference: data.reference,
            status: 'completed',
            isAnonymous: pendingMetadata.isAnonymous || false,
            donorName: pendingMetadata.donorName,
            donorPhone: pendingMetadata.donorPhone,
            notes: pendingMetadata.notes,
          }
        });
        
        // Delete pending transaction
        await prisma.pendingTransaction.delete({ where: { id: pendingTx.id } });
        
        console.log(`[${traceId}] Donation created`);
        res.redirect(`${process.env.FRONTEND_URL}/payment/callback?reference=${reference}&status=success&type=donation`);
      } else {
        // Handle other payment types (event tickets, donations, etc.)
        console.log(`[${traceId}] Other payment type, redirecting to callback`);
        res.redirect(`${process.env.FRONTEND_URL}/payment/callback?reference=${reference}`);
      }
    } else {
      console.log(`[${traceId}] Payment NOT successful - Status: ${data.status}`);
      res.redirect(`${process.env.FRONTEND_URL}/dashboard/packages?reference=${reference}&status=failed`);
    }
  } catch (error: any) {
    console.error(`[${traceId}] ========== VERIFICATION ERROR ==========`);
    console.error(`[${traceId}] Status:`, error.response?.status);
    console.error(`[${traceId}] Response:`, JSON.stringify(error.response?.data, null, 2));
    console.error(`[${traceId}] Message:`, error.message);
    res.redirect(`${process.env.FRONTEND_URL}/dashboard/packages?reference=${reference}&status=error`);
  }
}
