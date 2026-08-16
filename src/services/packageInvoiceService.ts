import prisma from '../lib/prisma';
import crypto from 'crypto';

export type PackageInvoiceStatus = 'draft' | 'sent' | 'partially_paid' | 'paid' | 'overdue' | 'cancelled';
const PUBLIC_INVOICE_PAYMENT_MONTHS = [1, 3, 6, 12];

export function parseNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function addBillingCycle(start: Date, billingCycle: string): Date {
  const end = new Date(start);
  if (billingCycle === 'yearly') end.setFullYear(end.getFullYear() + 1);
  else end.setMonth(end.getMonth() + 1);
  end.setDate(end.getDate() - 1);
  return end;
}

export function allowedPublicInvoicePaymentMonths(invoice?: { billingCycle?: string | null; servicePeriodStart?: Date; servicePeriodEnd?: Date }) {
  if (invoice?.billingCycle === 'yearly') return [12];
  const invoiceMonths = invoice?.servicePeriodStart && invoice?.servicePeriodEnd
    ? invoiceCoveredMonths(invoice as { billingCycle?: string | null; servicePeriodStart: Date; servicePeriodEnd: Date })
    : 1;
  return Array.from(new Set([...PUBLIC_INVOICE_PAYMENT_MONTHS, invoiceMonths]))
    .filter(months => months >= invoiceMonths)
    .sort((a, b) => a - b);
}

export function invoiceCoveredMonths(invoice: { billingCycle?: string | null; servicePeriodStart: Date; servicePeriodEnd: Date }) {
  if (invoice.billingCycle === 'yearly') return 12;
  const start = new Date(invoice.servicePeriodStart);
  const end = new Date(invoice.servicePeriodEnd);
  const monthDiff = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()) + 1;
  return Math.max(1, monthDiff);
}

export function addMonthsPeriod(start: Date, months: number) {
  const periodStart = new Date(start);
  const periodEnd = new Date(periodStart);
  periodEnd.setMonth(periodEnd.getMonth() + months);
  periodEnd.setDate(periodEnd.getDate() - 1);
  return { periodStart, periodEnd };
}

export function publicInvoicePaymentQuote(invoice: {
  amount: number;
  balanceDue: number;
  billingCycle?: string | null;
  servicePeriodStart: Date;
  servicePeriodEnd: Date;
}, selectedMonths: number) {
  const allowedMonths = allowedPublicInvoicePaymentMonths(invoice);
  if (!allowedMonths.includes(selectedMonths)) {
    throw new Error(`Payment months must be one of: ${allowedMonths.join(', ')}`);
  }

  const originalInvoiceMonths = invoiceCoveredMonths(invoice);
  if (selectedMonths < originalInvoiceMonths) {
    throw new Error(`This invoice covers ${originalInvoiceMonths} month${originalInvoiceMonths === 1 ? '' : 's'}, so payment cannot be less than that period`);
  }

  const monthlyAmount = parseNumber(invoice.amount) / originalInvoiceMonths;
  const extraMonths = Math.max(0, selectedMonths - originalInvoiceMonths);
  const originalAmountDue = Math.max(0, parseNumber(invoice.balanceDue, invoice.amount));
  const extraAmount = Math.round(monthlyAmount * extraMonths * 100) / 100;
  const baseAmount = Math.round((originalAmountDue + extraAmount) * 100) / 100;
  const extraPeriodStart = new Date(invoice.servicePeriodEnd);
  extraPeriodStart.setDate(extraPeriodStart.getDate() + 1);
  const extraPeriod = extraMonths > 0 ? addMonthsPeriod(extraPeriodStart, extraMonths) : null;

  return {
    selectedMonths,
    originalInvoiceMonths,
    extraMonths,
    monthlyAmount: Math.round(monthlyAmount * 100) / 100,
    originalAmountDue,
    extraAmount,
    baseAmount,
    extraPeriodStart: extraPeriod?.periodStart ?? null,
    extraPeriodEnd: extraPeriod?.periodEnd ?? null,
  };
}

export async function generateInvoiceNumber(): Promise<string> {
  const prefix = `INV-${new Date().getFullYear()}`;
  const count = await prisma.packageInvoice.count({
    where: { invoiceNumber: { startsWith: prefix } },
  });
  return `${prefix}-${String(count + 1).padStart(5, '0')}`;
}

export async function generateInvoicePublicToken(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const token = crypto.randomBytes(24).toString('hex');
    const existing = await prisma.packageInvoice.findUnique({ where: { publicToken: token } });
    if (!existing) return token;
  }
  throw new Error('Failed to generate unique invoice payment token');
}

export async function ensureInvoicePublicToken(invoiceId: string): Promise<string> {
  const invoice = await prisma.packageInvoice.findUnique({
    where: { id: invoiceId },
    select: { publicToken: true },
  });
  if (!invoice) throw new Error('Invoice not found');
  if (invoice.publicToken) return invoice.publicToken;

  const publicToken = await generateInvoicePublicToken();
  await prisma.packageInvoice.update({
    where: { id: invoiceId },
    data: { publicToken },
  });
  return publicToken;
}

export async function recalculatePackageInvoice(invoiceId: string) {
  const invoice = await prisma.packageInvoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) return null;

  const [legacyPaidAgg, linkedPaidAgg] = await Promise.all([
    prisma.payment.aggregate({
      where: { invoiceId, status: 'completed' },
      _sum: { baseAmount: true, amount: true },
    }),
    prisma.packagePaymentInvoice.aggregate({
      where: { invoiceId, payment: { status: 'completed' } },
      _sum: { amount: true },
    }),
  ]);

  const amountPaid = Math.max(
    parseNumber(legacyPaidAgg._sum?.baseAmount, parseNumber(legacyPaidAgg._sum?.amount)),
    parseNumber(linkedPaidAgg._sum?.amount),
  );
  const balanceDue = Math.max(0, invoice.amount - amountPaid);
  const now = new Date();
  const status: PackageInvoiceStatus = invoice.status === 'cancelled'
    ? 'cancelled'
    : balanceDue <= 0
      ? 'paid'
      : amountPaid > 0
        ? 'partially_paid'
        : invoice.status === 'draft'
          ? 'draft'
          : invoice.dueDate < now
            ? 'overdue'
            : 'sent';

  const updated = await prisma.packageInvoice.update({
    where: { id: invoiceId },
    data: {
      amountPaid,
      balanceDue,
      status,
      paidAt: status === 'paid' ? now : null,
    },
    include: packageInvoiceInclude,
  });

  if (status === 'paid') {
    await activateSubscriptionFromInvoice(updated);
  }

  return updated;
}

export async function applyPackagePaymentToInvoices(paymentId: string, metadata: any = {}) {
  const invoiceId = metadata.invoiceId;
  if (!invoiceId) {
    return null;
  }

  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  const invoice = await prisma.packageInvoice.findUnique({ where: { id: invoiceId } });
  if (!payment || !invoice) return null;

  const selectedMonths = parseNumber(metadata.invoicePaymentMonths, invoiceCoveredMonths(invoice));
  const originalInvoiceMonths = parseNumber(metadata.originalInvoiceMonths, invoiceCoveredMonths(invoice));
  const extraMonths = Math.max(0, parseNumber(metadata.extraInvoiceMonths, selectedMonths - originalInvoiceMonths));
  const originalAmount = Math.min(invoice.amount, parseNumber(metadata.originalInvoiceAmountDue, invoice.balanceDue || invoice.amount));
  const extraAmount = parseNumber(metadata.extraInvoiceAmount, 0);

  await prisma.packagePaymentInvoice.upsert({
    where: { paymentId_invoiceId: { paymentId, invoiceId: invoice.id } },
    create: {
      paymentId,
      invoiceId: invoice.id,
      amount: originalAmount,
      currency: invoice.currency,
      role: 'primary',
      months: originalInvoiceMonths,
    },
    update: {
      amount: originalAmount,
      currency: invoice.currency,
      role: 'primary',
      months: originalInvoiceMonths,
    },
  });

  let extensionInvoice: any = null;
  if (extraMonths > 0 && extraAmount > 0) {
    const extensionPeriodStart = metadata.extraInvoiceServicePeriodStart
      ? new Date(metadata.extraInvoiceServicePeriodStart)
      : new Date(invoice.servicePeriodEnd);
    if (!metadata.extraInvoiceServicePeriodStart) extensionPeriodStart.setDate(extensionPeriodStart.getDate() + 1);
    const extensionPeriodEnd = metadata.extraInvoiceServicePeriodEnd
      ? new Date(metadata.extraInvoiceServicePeriodEnd)
      : addMonthsPeriod(extensionPeriodStart, extraMonths).periodEnd;

    extensionInvoice = await prisma.packageInvoice.create({
      data: {
        invoiceNumber: await generateInvoiceNumber(),
        ministryAdminId: invoice.ministryAdminId,
        packageId: invoice.packageId,
        packageName: invoice.packageName,
        billingCycle: 'custom',
        currency: invoice.currency,
        amount: extraAmount,
        amountPaid: extraAmount,
        balanceDue: 0,
        status: 'paid',
        invoiceDate: new Date(),
        dueDate: invoice.dueDate,
        servicePeriodStart: extensionPeriodStart,
        servicePeriodEnd: extensionPeriodEnd,
        notes: `Subscription extension paid together with invoice ${invoice.invoiceNumber}.`,
        terms: invoice.terms,
        lineItems: JSON.stringify([{
          description: `${invoice.packageName} subscription extension`,
          months: extraMonths,
          amount: extraAmount,
          parentInvoiceId: invoice.id,
          parentInvoiceNumber: invoice.invoiceNumber,
        }]),
        paidAt: payment.paidAt || new Date(),
        createdById: invoice.createdById,
      },
    });

    await prisma.packagePaymentInvoice.upsert({
      where: { paymentId_invoiceId: { paymentId, invoiceId: extensionInvoice.id } },
      create: {
        paymentId,
        invoiceId: extensionInvoice.id,
        amount: extraAmount,
        currency: invoice.currency,
        role: 'extension',
        months: extraMonths,
      },
      update: {
        amount: extraAmount,
        currency: invoice.currency,
        role: 'extension',
        months: extraMonths,
      },
    });
  }

  const updatedPrimary = await recalculatePackageInvoice(invoice.id);
  const subscriptionEnd = extensionInvoice?.servicePeriodEnd || updatedPrimary?.servicePeriodEnd || invoice.servicePeriodEnd;
  await activateSubscriptionFromInvoice({
    ministryAdminId: invoice.ministryAdminId,
    packageId: invoice.packageId,
    servicePeriodStart: invoice.servicePeriodStart,
    servicePeriodEnd: subscriptionEnd,
  });

  return { invoice: updatedPrimary, extensionInvoice };
}

export async function activateSubscriptionFromInvoice(invoice: {
  ministryAdminId: string;
  packageId: string;
  servicePeriodStart: Date;
  servicePeriodEnd: Date;
}) {
  await prisma.subscription.upsert({
    where: { ministryAdminId: invoice.ministryAdminId },
    create: {
      ministryAdminId: invoice.ministryAdminId,
      packageId: invoice.packageId,
      status: 'active',
      startsAt: invoice.servicePeriodStart,
      expiresAt: invoice.servicePeriodEnd,
      lastEmailDay: null,
    },
    update: {
      packageId: invoice.packageId,
      status: 'active',
      startsAt: invoice.servicePeriodStart,
      expiresAt: invoice.servicePeriodEnd,
      lastEmailDay: null,
    },
  });
}

export const packageInvoiceInclude = {
  ministryAdmin: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      ministryName: true,
      accountCountry: true,
    },
  },
  package: { select: { id: true, name: true, displayName: true } },
  payments: {
    orderBy: { paidAt: 'desc' as const },
    select: {
      id: true,
      amount: true,
      baseAmount: true,
      currency: true,
      status: true,
      paymentMethod: true,
      reference: true,
      notes: true,
      paidAt: true,
      createdAt: true,
      gateway: true,
    },
  },
  paymentLinks: {
    include: {
      payment: {
        select: {
          id: true,
          amount: true,
          baseAmount: true,
          currency: true,
          status: true,
          paymentMethod: true,
          reference: true,
          notes: true,
          paidAt: true,
          createdAt: true,
          gateway: true,
        },
      },
    },
  },
};

export const packageInvoiceListInclude = {
  ministryAdmin: packageInvoiceInclude.ministryAdmin,
  package: packageInvoiceInclude.package,
};
