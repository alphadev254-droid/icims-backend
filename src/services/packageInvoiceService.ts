import prisma from '../lib/prisma';
import crypto from 'crypto';

export type PackageInvoiceStatus = 'draft' | 'sent' | 'partially_paid' | 'paid' | 'overdue' | 'cancelled';

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

  const paidAgg = await prisma.payment.aggregate({
    where: { invoiceId, status: 'completed' },
    _sum: { baseAmount: true, amount: true },
  });

  const amountPaid = parseNumber(paidAgg._sum?.baseAmount, parseNumber(paidAgg._sum?.amount));
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
};

export const packageInvoiceListInclude = {
  ministryAdmin: packageInvoiceInclude.ministryAdmin,
  package: packageInvoiceInclude.package,
};
