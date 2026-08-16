import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { convertUSDToLocal } from '../utils/currencyConversion';
import { queueEmail } from '../lib/emailQueue';
import { packageInvoiceTemplate } from '../lib/emailTemplates';
import { ICIMS_LOGO_CID, getIcimsLogoAttachment } from '../lib/emailAssets';
import { generatePackageInvoicePDF } from '../lib/packageInvoicePDF';
import {
  addBillingCycle,
  allowedPublicInvoicePaymentMonths,
  ensureInvoicePublicToken,
  generateInvoiceNumber,
  generateInvoicePublicToken,
  invoiceCoveredMonths,
  packageInvoiceInclude,
  packageInvoiceListInclude,
  parseNumber,
  publicInvoicePaymentQuote,
  recalculatePackageInvoice,
} from '../services/packageInvoiceService';

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:8080';

function getDiscountForCountry(country?: string | null) {
  const isMalawi = (country || 'Kenya') === 'Malawi';
  return parseFloat(process.env[isMalawi ? 'MALAWI_PACKAGE_DISCOUNT' : 'KENYA_PACKAGE_DISCOUNT'] || (isMalawi ? '0.5' : '1'));
}

function getCurrencyForCountry(country?: string | null) {
  return (country || 'Kenya') === 'Malawi' ? 'MWK' : 'KES';
}

function defaultPackageAmount(pkg: any, billingCycle: string, country?: string | null) {
  const currency = getCurrencyForCountry(country);
  const usdAmount = billingCycle === 'yearly' ? pkg.priceYearly : pkg.priceMonthly;
  return Math.round(convertUSDToLocal(usdAmount, currency as 'MWK' | 'KES') * getDiscountForCountry(country));
}

function parseDate(value: string, field: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${field} is invalid`);
  return date;
}

const listSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
  search: z.string().optional(),
  status: z.string().optional(),
  ministry: z.string().optional(),
  package: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

function serializeInvoice(invoice: any) {
  const linkedPayments = (invoice.paymentLinks || []).map((link: any) => ({
    ...link.payment,
    amount: link.amount,
    baseAmount: link.amount,
    currency: link.currency,
    invoiceLinkRole: link.role,
    invoiceLinkMonths: link.months,
  }));
  const directPayments = invoice.payments || [];
  const paymentsById = new Map<string, any>();
  [...directPayments, ...linkedPayments].forEach(payment => {
    if (payment?.id) paymentsById.set(payment.id, payment);
  });
  return {
    ...invoice,
    lineItems: invoice.lineItems ? JSON.parse(invoice.lineItems) : null,
    payments: Array.from(paymentsById.values()).sort((a, b) =>
      new Date(b.paidAt || b.createdAt || 0).getTime() - new Date(a.paidAt || a.createdAt || 0).getTime()
    ),
    paymentLinks: undefined,
  };
}

async function withPublicInvoiceTokens<T extends { id: string; publicToken?: string | null; status?: string }>(invoices: T[]): Promise<T[]> {
  return Promise.all(invoices.map(async invoice => {
    if (invoice.publicToken || invoice.status === 'cancelled') return invoice;
    const publicToken = await ensureInvoicePublicToken(invoice.id);
    return { ...invoice, publicToken };
  }));
}

export async function getAdminPackageInvoices(req: Request, res: Response): Promise<void> {
  const params = listSchema.parse(req.query);
  const where: any = {};

  if (params.status && params.status !== 'all') where.status = params.status;
  if (params.package && params.package !== 'all') where.packageId = params.package;
  if (params.ministry && params.ministry !== 'all') where.ministryAdminId = params.ministry;
  if (params.dateFrom || params.dateTo) {
    where.dueDate = {};
    if (params.dateFrom) where.dueDate.gte = parseDate(params.dateFrom, 'dateFrom');
    if (params.dateTo) where.dueDate.lte = parseDate(params.dateTo, 'dateTo');
  }
  if (params.search?.trim()) {
    const search = params.search.trim();
    where.OR = [
      { invoiceNumber: { contains: search } },
      { packageName: { contains: search } },
      { ministryAdmin: { firstName: { contains: search } } },
      { ministryAdmin: { lastName: { contains: search } } },
      { ministryAdmin: { email: { contains: search } } },
      { ministryAdmin: { ministryName: { contains: search } } },
    ];
  }

  const skip = (params.page - 1) * params.limit;
  const [invoices, total, statusCounts, amountAgg] = await Promise.all([
    prisma.packageInvoice.findMany({
      where,
      include: packageInvoiceListInclude,
      orderBy: { createdAt: 'desc' },
      skip,
      take: params.limit,
    }),
    prisma.packageInvoice.count({ where }),
    prisma.packageInvoice.groupBy({ by: ['status'], where, _count: { _all: true } }),
    prisma.packageInvoice.aggregate({ where, _sum: { amount: true, amountPaid: true, balanceDue: true } }),
  ]);

  const invoicesWithLinks = await withPublicInvoiceTokens(invoices);

  res.json({
    success: true,
    data: invoicesWithLinks.map(serializeInvoice),
    pagination: { page: params.page, limit: params.limit, total, totalPages: Math.ceil(total / params.limit) },
    summary: {
      totalAmount: amountAgg._sum.amount ?? 0,
      amountPaid: amountAgg._sum.amountPaid ?? 0,
      balanceDue: amountAgg._sum.balanceDue ?? 0,
      byStatus: Object.fromEntries(statusCounts.map(row => [row.status, row._count._all])),
    },
  });
}

export async function getAdminPackageInvoice(req: Request, res: Response): Promise<void> {
  const invoice = await prisma.packageInvoice.findUnique({
    where: { id: String(req.params.id) },
    include: packageInvoiceInclude,
  });
  if (!invoice) { res.status(404).json({ success: false, message: 'Invoice not found' }); return; }
  const [invoiceWithLink] = await withPublicInvoiceTokens([invoice]);
  res.json({ success: true, data: serializeInvoice(invoiceWithLink) });
}

export async function getPublicPackageInvoice(req: Request, res: Response): Promise<void> {
  const token = String(req.params.token || '');
  if (!token || token.length < 24) {
    res.status(404).json({ success: false, message: 'Invoice not found' });
    return;
  }

  const invoice = await prisma.packageInvoice.findUnique({
    where: { publicToken: token },
    include: packageInvoiceInclude,
  });
  if (!invoice || invoice.status === 'cancelled') {
    res.status(404).json({ success: false, message: 'Invoice not found or no longer available' });
    return;
  }

  const data = serializeInvoice(invoice);
  const invoiceMonths = invoiceCoveredMonths(invoice);
  data.paymentOptions = {
    allowedMonths: allowedPublicInvoicePaymentMonths(invoice),
    invoiceMonths,
    defaultMonths: invoiceMonths,
    monthlyAmount: publicInvoicePaymentQuote(invoice, invoiceMonths).monthlyAmount,
  };
  delete data.publicToken;
  res.json({ success: true, data });
}

const invoiceSchema = z.object({
  ministryAdminId: z.string().min(1),
  packageId: z.string().min(1),
  billingCycle: z.enum(['monthly', 'yearly', 'custom']).default('monthly'),
  months: z.coerce.number().int().positive().optional(),
  amount: z.number().positive().optional(),
  currency: z.enum(['MWK', 'KES']).optional(),
  invoiceDate: z.string().optional(),
  dueDate: z.string().min(1),
  servicePeriodStart: z.string().min(1),
  servicePeriodEnd: z.string().optional(),
  notes: z.string().optional(),
  terms: z.string().optional(),
  lineItems: z.array(z.record(z.any())).optional(),
  status: z.enum(['draft', 'sent']).default('draft'),
});

export async function createAdminPackageInvoice(req: Request, res: Response): Promise<void> {
  const parsed = invoiceSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const admin = await prisma.user.findUnique({ where: { id: parsed.data.ministryAdminId }, include: { role: true } });
  if (!admin || admin.role?.name !== 'ministry_admin') {
    res.status(400).json({ success: false, message: 'Invoice can only be created for a ministry admin' });
    return;
  }

  const pkg = await prisma.package.findUnique({ where: { id: parsed.data.packageId } });
  if (!pkg) { res.status(404).json({ success: false, message: 'Package not found' }); return; }

  const servicePeriodStart = parseDate(parsed.data.servicePeriodStart, 'servicePeriodStart');
  const invoiceMonths = parsed.data.billingCycle === 'yearly' ? 12 : Math.max(1, parsed.data.months || 1);
  const servicePeriodEnd = addBillingCycle(servicePeriodStart, parsed.data.billingCycle === 'yearly' ? 'yearly' : 'monthly');
  if (parsed.data.billingCycle !== 'yearly') {
    servicePeriodEnd.setTime(servicePeriodStart.getTime());
    servicePeriodEnd.setMonth(servicePeriodEnd.getMonth() + invoiceMonths);
    servicePeriodEnd.setDate(servicePeriodEnd.getDate() - 1);
  }
  const invoiceDate = parsed.data.invoiceDate ? parseDate(parsed.data.invoiceDate, 'invoiceDate') : new Date();
  const dueDate = parseDate(parsed.data.dueDate, 'dueDate');
  const currency = parsed.data.currency || getCurrencyForCountry(admin.accountCountry);
  const amount = defaultPackageAmount(pkg, parsed.data.billingCycle === 'yearly' ? 'yearly' : 'monthly', admin.accountCountry) * (parsed.data.billingCycle === 'yearly' ? 1 : invoiceMonths);

  const invoice = await prisma.packageInvoice.create({
    data: {
      invoiceNumber: await generateInvoiceNumber(),
      ministryAdminId: admin.id,
      packageId: pkg.id,
      packageName: pkg.displayName,
      billingCycle: parsed.data.billingCycle,
      currency,
      amount,
      amountPaid: 0,
      balanceDue: amount,
      status: parsed.data.status,
      publicToken: await generateInvoicePublicToken(),
      invoiceDate,
      dueDate,
      servicePeriodStart,
      servicePeriodEnd,
      notes: parsed.data.notes,
      terms: parsed.data.terms,
      lineItems: parsed.data.lineItems ? JSON.stringify(parsed.data.lineItems) : null,
      sentAt: parsed.data.status === 'sent' ? new Date() : null,
      createdById: req.user?.userId,
    },
    include: packageInvoiceInclude,
  });

  res.status(201).json({ success: true, data: serializeInvoice(invoice) });
}

const invoiceUpdateSchema = invoiceSchema.partial().omit({ ministryAdminId: true });

export async function updateAdminPackageInvoice(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id);
  const current = await prisma.packageInvoice.findUnique({ where: { id } });
  if (!current) { res.status(404).json({ success: false, message: 'Invoice not found' }); return; }
  if (!['draft', 'sent', 'overdue'].includes(current.status)) {
    res.status(400).json({ success: false, message: 'Only unpaid invoices can be edited' });
    return;
  }

  const parsed = invoiceUpdateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const data: any = { ...parsed.data };
  if (parsed.data.packageId) {
    const pkg = await prisma.package.findUnique({ where: { id: parsed.data.packageId } });
    if (!pkg) { res.status(404).json({ success: false, message: 'Package not found' }); return; }
    data.packageName = pkg.displayName;
  }
  for (const key of ['invoiceDate', 'dueDate', 'servicePeriodStart', 'servicePeriodEnd'] as const) {
    if (data[key]) data[key] = parseDate(data[key], key);
  }
  if (parsed.data.lineItems) data.lineItems = JSON.stringify(parsed.data.lineItems);
  if (parsed.data.status === 'sent' && current.status !== 'sent') data.sentAt = new Date();
  if (parsed.data.amount !== undefined) data.balanceDue = Math.max(0, parsed.data.amount - current.amountPaid);

  await prisma.packageInvoice.update({ where: { id }, data });
  const invoice = await recalculatePackageInvoice(id);
  res.json({ success: true, data: serializeInvoice(invoice) });
}

export async function sendAdminPackageInvoice(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id);
  const publicToken = await ensureInvoicePublicToken(id);
  const invoice = await prisma.packageInvoice.update({
    where: { id },
    data: { status: 'sent', sentAt: new Date(), lastReminderAt: new Date() },
    include: packageInvoiceInclude,
  });
  if (invoice.ministryAdmin?.email) {
    const payUrl = `${FRONTEND_URL}/invoice/pay/${publicToken}`;
    const packageName = invoice.package?.displayName || invoice.packageName;
    const billedToName = invoice.ministryAdmin.ministryName
      || `${invoice.ministryAdmin.firstName || ''} ${invoice.ministryAdmin.lastName || ''}`.trim()
      || invoice.ministryAdmin.email;
    const invoicePDF = await generatePackageInvoicePDF({
      invoiceNumber: invoice.invoiceNumber,
      status: invoice.status,
      packageName,
      billedToName,
      billedToEmail: invoice.ministryAdmin.email,
      billingCycle: invoice.billingCycle,
      currency: invoice.currency,
      amount: invoice.amount,
      amountPaid: invoice.amountPaid,
      balanceDue: invoice.balanceDue,
      invoiceDate: invoice.invoiceDate,
      dueDate: invoice.dueDate,
      servicePeriodStart: invoice.servicePeriodStart,
      servicePeriodEnd: invoice.servicePeriodEnd,
      notes: invoice.notes,
      terms: invoice.terms,
      payUrl,
    });
    const logoAttachment = getIcimsLogoAttachment();
    await queueEmail(
      invoice.ministryAdmin.email,
      `Invoice ${invoice.invoiceNumber} - ${packageName}`,
      packageInvoiceTemplate({
        firstName: invoice.ministryAdmin.firstName,
        ministryName: invoice.ministryAdmin.ministryName,
        invoiceNumber: invoice.invoiceNumber,
        packageName,
        billingCycle: invoice.billingCycle,
        currency: invoice.currency,
        amount: invoice.amount,
        amountPaid: invoice.amountPaid,
        balanceDue: invoice.balanceDue,
        invoiceDate: invoice.invoiceDate,
        dueDate: invoice.dueDate,
        servicePeriodStart: invoice.servicePeriodStart,
        servicePeriodEnd: invoice.servicePeriodEnd,
        notes: invoice.notes,
        terms: invoice.terms,
        payUrl,
        logoCid: logoAttachment ? ICIMS_LOGO_CID : undefined,
      }),
      [
        ...(logoAttachment ? [logoAttachment] : []),
        { filename: `invoice-${invoice.invoiceNumber}.pdf`, content: invoicePDF },
      ],
      'package_subscription',
    );
  }
  res.json({ success: true, data: serializeInvoice(invoice), message: 'Invoice marked as sent' });
}

export async function cancelAdminPackageInvoice(req: Request, res: Response): Promise<void> {
  const current = await prisma.packageInvoice.findUnique({
    where: { id: String(req.params.id) },
    select: { id: true, status: true, amountPaid: true },
  });
  if (!current) { res.status(404).json({ success: false, message: 'Invoice not found' }); return; }
  if (current.status === 'paid' || current.status === 'partially_paid' || current.amountPaid > 0) {
    res.status(400).json({ success: false, message: 'Invoices with recorded payments cannot be cancelled. Record a refund or adjustment instead.' });
    return;
  }

  const invoice = await prisma.packageInvoice.update({
    where: { id: String(req.params.id) },
    data: { status: 'cancelled' },
    include: packageInvoiceInclude,
  });
  res.json({ success: true, data: serializeInvoice(invoice) });
}

const recordPaymentSchema = z.object({
  amount: z.number().positive(),
  paymentMethod: z.enum(['cash', 'bank_transfer', 'mobile_money', 'other']).default('cash'),
  reference: z.string().optional(),
  notes: z.string().optional(),
  paidAt: z.string().optional(),
});

export async function recordAdminPackageInvoicePayment(req: Request, res: Response): Promise<void> {
  const invoice = await prisma.packageInvoice.findUnique({ where: { id: String(req.params.id) } });
  if (!invoice) { res.status(404).json({ success: false, message: 'Invoice not found' }); return; }
  if (invoice.status === 'cancelled') { res.status(400).json({ success: false, message: 'Cannot record payment for a cancelled invoice' }); return; }

  const parsed = recordPaymentSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.errors[0].message }); return; }

  const payment = await prisma.payment.create({
    data: {
      invoiceId: invoice.id,
      ministryAdminId: invoice.ministryAdminId,
      packageId: invoice.packageId,
      packageName: invoice.packageName,
      amount: parsed.data.amount,
      baseAmount: parsed.data.amount,
      totalAmount: parsed.data.amount,
      currency: invoice.currency,
      type: 'package_invoice',
      status: 'completed',
      paymentMethod: parsed.data.paymentMethod,
      reference: parsed.data.reference,
      notes: parsed.data.notes,
      paidAt: parsed.data.paidAt ? parseDate(parsed.data.paidAt, 'paidAt') : new Date(),
      createdById: req.user!.userId,
    },
  });

  await prisma.packagePaymentInvoice.upsert({
    where: { paymentId_invoiceId: { paymentId: payment.id, invoiceId: invoice.id } },
    create: {
      paymentId: payment.id,
      invoiceId: invoice.id,
      amount: parsed.data.amount,
      currency: invoice.currency,
      role: 'primary',
      months: 1,
    },
    update: {
      amount: parsed.data.amount,
      currency: invoice.currency,
      role: 'primary',
      months: 1,
    },
  });

  const updated = await recalculatePackageInvoice(invoice.id);
  res.status(201).json({ success: true, data: serializeInvoice(updated) });
}

export async function getMyPackageInvoices(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  if (!userId) { res.status(401).json({ success: false, message: 'Not authenticated' }); return; }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: { select: { name: true } }, ministryAdminId: true } });
  const ministryAdminId = user?.role?.name === 'ministry_admin' ? userId : user?.ministryAdminId;
  if (!ministryAdminId) { res.status(400).json({ success: false, message: 'No ministry admin assigned' }); return; }

  const invoices = await prisma.packageInvoice.findMany({
    where: { ministryAdminId, status: { not: 'cancelled' } },
    include: packageInvoiceListInclude,
    orderBy: { createdAt: 'desc' },
  });
  const invoicesWithLinks = await withPublicInvoiceTokens(invoices);
  res.json({ success: true, data: invoicesWithLinks.map(serializeInvoice) });
}

export async function getMyPackageInvoice(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  if (!userId) { res.status(401).json({ success: false, message: 'Not authenticated' }); return; }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: { select: { name: true } }, ministryAdminId: true } });
  const ministryAdminId = user?.role?.name === 'ministry_admin' ? userId : user?.ministryAdminId;
  if (!ministryAdminId) { res.status(400).json({ success: false, message: 'No ministry admin assigned' }); return; }

  const invoice = await prisma.packageInvoice.findFirst({
    where: { id: String(req.params.id), ministryAdminId, status: { not: 'cancelled' } },
    include: packageInvoiceInclude,
  });
  if (!invoice) { res.status(404).json({ success: false, message: 'Invoice not found' }); return; }

  const [invoiceWithLink] = await withPublicInvoiceTokens([invoice]);
  res.json({ success: true, data: serializeInvoice(invoiceWithLink) });
}
