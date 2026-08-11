import puppeteer, { type Browser } from 'puppeteer';

let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }

  try {
    const browser = await browserPromise;
    if (!browser.isConnected()) {
      browserPromise = null;
      return getBrowser();
    }
    return browser;
  } catch (error) {
    browserPromise = null;
    throw error;
  }
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(value: Date | string | null | undefined): string {
  if (!value) return '-';
  return new Date(value).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatMoney(currency: string, amount: number): string {
  return `${currency} ${Number(amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export async function generatePackageInvoicePDF(invoiceData: {
  invoiceNumber: string;
  status: string;
  packageName: string;
  billedToName: string;
  billedToEmail?: string | null;
  billingCycle: string;
  currency: string;
  amount: number;
  amountPaid: number;
  balanceDue: number;
  invoiceDate: Date | string;
  dueDate: Date | string;
  servicePeriodStart: Date | string;
  servicePeriodEnd: Date | string;
  notes?: string | null;
  terms?: string | null;
  payUrl?: string;
}): Promise<Buffer> {
  const rows = [
    ['Package', invoiceData.packageName],
    ['Billing cycle', invoiceData.billingCycle],
    ['Invoice date', formatDate(invoiceData.invoiceDate)],
    ['Due date', formatDate(invoiceData.dueDate)],
    ['Service period', `${formatDate(invoiceData.servicePeriodStart)} - ${formatDate(invoiceData.servicePeriodEnd)}`],
    ['Amount', formatMoney(invoiceData.currency, invoiceData.amount)],
    ['Paid', formatMoney(invoiceData.currency, invoiceData.amountPaid)],
    ['Balance due', formatMoney(invoiceData.currency, invoiceData.balanceDue)],
  ];

  const html = `
<!DOCTYPE html>
<html>
<head>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Arial, sans-serif; padding: 36px; background: #f9fafb; color: #111827; }
    .invoice { background: white; max-width: 760px; margin: 0 auto; border-radius: 10px; overflow: hidden; border: 1px solid #e5e7eb; box-shadow: 0 2px 8px rgba(17,24,39,0.08); }
    .header { background: #111827; color: white; padding: 34px 40px; border-bottom: 5px solid #d4a574; }
    .brand { font-size: 13px; letter-spacing: 3px; text-transform: uppercase; color: #d4a574; font-weight: 700; margin-bottom: 10px; }
    .header h1 { font-size: 30px; margin-bottom: 8px; }
    .header p { opacity: 0.9; font-size: 14px; }
    .content { padding: 34px 40px; }
    .top { display: flex; justify-content: space-between; gap: 24px; margin-bottom: 26px; }
    .box { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 18px; flex: 1; }
    .box h3 { font-size: 13px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 10px; }
    .box p { font-size: 14px; margin: 5px 0; }
    .status { display: inline-block; background: #fff7e6; color: #8a5a13; border: 1px solid #f0d7a4; border-radius: 999px; padding: 5px 12px; font-size: 12px; font-weight: 700; text-transform: uppercase; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    th { background: #111827; color: white; font-size: 12px; text-align: left; padding: 12px; }
    td { border-bottom: 1px solid #e5e7eb; padding: 12px; font-size: 13px; vertical-align: top; }
    td:first-child { color: #6b7280; font-weight: 700; width: 34%; }
    .amount { color: #111827; font-size: 28px; font-weight: 800; }
    .note { margin-top: 22px; background: #fffaf0; border-left: 4px solid #d4a574; padding: 16px; border-radius: 6px; }
    .note h3 { font-size: 13px; margin-bottom: 8px; color: #8a5a13; }
    .note p { white-space: pre-line; color: #374151; font-size: 13px; line-height: 1.5; }
    .footer { background: #f9fafb; padding: 22px 40px; text-align: center; color: #6b7280; font-size: 12px; border-top: 1px solid #e5e7eb; }
  </style>
</head>
<body>
  <div class="invoice">
    <div class="header">
      <div class="brand">ICIMS</div>
      <h1>Package Invoice</h1>
      <p>Invoice ${escapeHtml(invoiceData.invoiceNumber)}</p>
    </div>
    <div class="content">
      <div class="top">
        <div class="box">
          <h3>Billed To</h3>
          <p><strong>${escapeHtml(invoiceData.billedToName)}</strong></p>
          ${invoiceData.billedToEmail ? `<p>${escapeHtml(invoiceData.billedToEmail)}</p>` : ''}
        </div>
        <div class="box">
          <h3>Balance Due</h3>
          <p class="amount">${escapeHtml(formatMoney(invoiceData.currency, invoiceData.balanceDue))}</p>
          <p><span class="status">${escapeHtml(invoiceData.status.replace(/_/g, ' '))}</span></p>
        </div>
      </div>

      <table>
        <thead><tr><th>Field</th><th>Value</th></tr></thead>
        <tbody>
          ${rows.map(([label, value]) => `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`).join('')}
        </tbody>
      </table>

      ${invoiceData.notes ? `<div class="note"><h3>Notes</h3><p>${escapeHtml(invoiceData.notes)}</p></div>` : ''}
      ${invoiceData.terms ? `<div class="note"><h3>Terms</h3><p>${escapeHtml(invoiceData.terms)}</p></div>` : ''}
      ${invoiceData.payUrl ? `<div class="note"><h3>Payment Link</h3><p>${escapeHtml(invoiceData.payUrl)}</p></div>` : ''}
    </div>
    <div class="footer">
      <p>This invoice was generated by ICIMS - Integrated Church Information Management System.</p>
      <p>&copy; ${new Date().getFullYear()} ICIMS. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`;

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
    return Buffer.from(pdfBuffer);
  } finally {
    await page.close().catch(() => undefined);
  }
}
