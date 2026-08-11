import prisma from '../lib/prisma';
import { queueEmail } from '../lib/emailQueue';
import { addBillingCycle, ensureInvoicePublicToken, generateInvoiceNumber, generateInvoicePublicToken } from '../services/packageInvoiceService';
import { convertUSDToLocal } from '../utils/currencyConversion';

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:8080';
const INVOICE_REMINDER_DAYS = (process.env.INVOICE_REMINDER_DAYS || '7,3,1')
  .split(',')
  .map(day => parseInt(day.trim(), 10))
  .filter(day => Number.isFinite(day) && day > 0);
const INVOICE_OVERDUE_REMINDER_DAYS = (process.env.INVOICE_OVERDUE_REMINDER_DAYS || '1,3,7')
  .split(',')
  .map(day => parseInt(day.trim(), 10))
  .filter(day => Number.isFinite(day) && day > 0);

/**
 * Check for expired subscriptions and mark them as expired
 * Runs every 24 hours via cron job
 */
export async function checkExpiredSubscriptions() {
  console.log('[Subscription Worker] Starting expired subscription check...');
  
  try {
    const now = new Date();
    
    // Find all active subscriptions that have expired
    const expiredSubscriptions = await prisma.subscription.updateMany({
      where: {
        status: 'active',
        expiresAt: { lt: now },
      },
      data: {
        status: 'expired',
      },
    });

    console.log(`[Subscription Worker] Marked ${expiredSubscriptions.count} subscriptions as expired`);
  } catch (error) {
    console.error('[Subscription Worker] Fatal error:', error);
  }
}

/**
 * Check for subscriptions expiring soon and send reminder emails.
 * Package invoices are sent before expiry and followed up after expiry.
 */
export async function checkExpiringSubscriptions() {
  console.log('[Subscription Worker] Checking for expiring subscriptions...');
  
  try {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    
    const overdueLookbackDays = Math.max(...INVOICE_OVERDUE_REMINDER_DAYS, 0);
    const subscriptions = await prisma.subscription.findMany({
      where: {
        OR: [
          { status: 'active' },
          { status: 'expired', expiresAt: { gte: new Date(now.getTime() - overdueLookbackDays * 24 * 60 * 60 * 1000) } }
        ]
      },
      include: {
        package: true,
      },
    });

    console.log(`[Subscription Worker] Found ${subscriptions.length} subscriptions to check`);

    for (const subscription of subscriptions) {
      try {
        const daysUntilExpiry = Math.ceil((subscription.expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        const daysAfterExpiry = Math.ceil((now.getTime() - subscription.expiresAt.getTime()) / (1000 * 60 * 60 * 24));

        if (subscription.status === 'active' && INVOICE_REMINDER_DAYS.includes(daysUntilExpiry)) {
          await ensureRenewalInvoice(subscription, daysUntilExpiry, 'before_expiry');
        }

        if (subscription.status === 'expired' && INVOICE_OVERDUE_REMINDER_DAYS.includes(daysAfterExpiry)) {
          await ensureRenewalInvoice(subscription, daysAfterExpiry, 'after_expiry');
        }
      } catch (error) {
        console.error(`[Subscription Worker] Error processing subscription ${subscription.id}:`, error);
      }
    }

    console.log('[Subscription Worker] Expiring subscriptions check completed.');
  } catch (error) {
    console.error('[Subscription Worker] Fatal error:', error);
  }
}

async function ensureRenewalInvoice(subscription: any, reminderDay: number, phase: 'before_expiry' | 'after_expiry') {
  const user = await prisma.user.findUnique({
    where: { id: subscription.ministryAdminId },
    select: { id: true, firstName: true, email: true, accountCountry: true },
  });
  const pkg = subscription.package;
  if (!user || !pkg) return;

  const latestPayment = await prisma.payment.findFirst({
    where: { ministryAdminId: user.id, packageId: pkg.id, status: 'completed' },
    orderBy: { paidAt: 'desc' },
    select: { billingCycle: true },
  });
  const billingCycle = latestPayment?.billingCycle === 'yearly' ? 'yearly' : 'monthly';
  const servicePeriodStart = new Date(subscription.expiresAt);
  servicePeriodStart.setDate(servicePeriodStart.getDate() + 1);
  const servicePeriodEnd = addBillingCycle(servicePeriodStart, billingCycle);
  const existing = await prisma.packageInvoice.findFirst({
    where: {
      ministryAdminId: user.id,
      packageId: pkg.id,
      servicePeriodStart,
      servicePeriodEnd,
      status: { not: 'cancelled' },
    },
  });

  if (existing) {
    const publicToken = await ensureInvoicePublicToken(existing.id);
    if (phase === 'after_expiry' && existing.status === 'sent') {
      await prisma.packageInvoice.update({
        where: { id: existing.id },
        data: { status: 'overdue' },
      });
    }
    await sendInvoiceReminderEmail({
      invoice: existing,
      user,
      pkg,
      amount: existing.balanceDue || existing.amount,
      currency: existing.currency,
      servicePeriodStart,
      servicePeriodEnd,
      dueDate: subscription.expiresAt,
      reminderDay,
      phase,
      publicToken,
    });
    return;
  }

  const currency = user.accountCountry === 'Malawi' ? 'MWK' : 'KES';
  const discount = parseFloat(process.env[user.accountCountry === 'Malawi' ? 'MALAWI_PACKAGE_DISCOUNT' : 'KENYA_PACKAGE_DISCOUNT'] || (user.accountCountry === 'Malawi' ? '0.5' : '1'));
  const usdAmount = billingCycle === 'yearly' ? pkg.priceYearly : pkg.priceMonthly;
  const amount = Math.round(convertUSDToLocal(usdAmount, currency as 'MWK' | 'KES') * discount);

  const invoice = await prisma.packageInvoice.create({
    data: {
      invoiceNumber: await generateInvoiceNumber(),
      ministryAdminId: user.id,
      packageId: pkg.id,
      packageName: pkg.displayName,
      billingCycle,
      currency,
      amount,
      amountPaid: 0,
      balanceDue: amount,
      status: phase === 'after_expiry' ? 'overdue' : 'sent',
      publicToken: await generateInvoicePublicToken(),
      invoiceDate: new Date(),
      dueDate: subscription.expiresAt,
      servicePeriodStart,
      servicePeriodEnd,
      terms: 'Payment is due by the due date shown on this invoice.',
      sentAt: new Date(),
      lastReminderAt: new Date(),
    },
  });

  await sendInvoiceReminderEmail({
    invoice,
    user,
    pkg,
    amount,
    currency,
    servicePeriodStart,
    servicePeriodEnd,
    dueDate: subscription.expiresAt,
    reminderDay,
    phase,
    force: true,
    publicToken: invoice.publicToken!,
  });
}

async function sendInvoiceReminderEmail({
  invoice,
  user,
  pkg,
  amount,
  currency,
  servicePeriodStart,
  servicePeriodEnd,
  dueDate,
  reminderDay,
  phase,
  publicToken,
  force = false,
}: {
  invoice: any;
  user: any;
  pkg: any;
  amount: number;
  currency: string;
  servicePeriodStart: Date;
  servicePeriodEnd: Date;
  dueDate: Date;
  reminderDay: number;
  phase: 'before_expiry' | 'after_expiry';
  publicToken: string;
  force?: boolean;
}) {
  if (!user.email) return;
  if (!force && invoice.lastReminderAt) {
    const last = new Date(invoice.lastReminderAt);
    const today = new Date();
    if (
      last.getFullYear() === today.getFullYear()
      && last.getMonth() === today.getMonth()
      && last.getDate() === today.getDate()
    ) {
      return;
    }
  }

  const isOverdue = phase === 'after_expiry';
  await queueEmail(
    user.email,
    isOverdue
      ? `Invoice ${invoice.invoiceNumber} overdue - ${pkg.displayName}`
      : `Invoice ${invoice.invoiceNumber} - ${pkg.displayName}`,
    `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111827">
        <h2>${isOverdue ? 'Package Invoice Overdue' : 'Package Renewal Invoice'}</h2>
        <p>Hello ${user.firstName || 'there'},</p>
        <p>
          ${isOverdue
            ? `Your ${pkg.displayName} subscription expired ${reminderDay} day(s) ago.`
            : `Your ${pkg.displayName} subscription expires in ${reminderDay} day(s).`
          }
          Invoice <strong>${invoice.invoiceNumber}</strong> is ready for the next service period.
        </p>
        <p><strong>Amount due:</strong> ${currency} ${amount.toLocaleString()}</p>
        <p><strong>Due date:</strong> ${dueDate.toLocaleDateString()}</p>
        <p><strong>Service period:</strong> ${servicePeriodStart.toLocaleDateString()} - ${servicePeriodEnd.toLocaleDateString()}</p>
        <p><a href="${FRONTEND_URL}/invoice/pay/${publicToken}" style="display:inline-block;background:#d29a35;color:#111827;padding:10px 14px;border-radius:6px;text-decoration:none">Pay Invoice</a></p>
      </div>
    `,
    'package_subscription',
  );

  await prisma.packageInvoice.update({
    where: { id: invoice.id },
    data: { lastReminderAt: new Date(), sentAt: invoice.sentAt || new Date() },
  });
}

// Run both checks
export async function runSubscriptionChecks() {
  await checkExpiredSubscriptions();
  await checkExpiringSubscriptions();
}

// If running directly
if (require.main === module) {
  runSubscriptionChecks()
    .then(() => {
      console.log('[Subscription Worker] All checks completed');
      process.exit(0);
    })
    .catch((error) => {
      console.error('[Subscription Worker] Failed:', error);
      process.exit(1);
    });
}
