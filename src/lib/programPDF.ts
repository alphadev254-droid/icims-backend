import fs from 'fs/promises';
import path from 'path';
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

function formatDateTime(value: Date | string | null | undefined): string {
  if (!value) return '-';
  return new Date(value).toLocaleString('en-US', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatTime(value: Date | string | null | undefined): string {
  if (!value) return '-';
  return new Date(value).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

async function logoDataUri(logoUrl?: string | null): Promise<string | null> {
  if (!logoUrl || !logoUrl.startsWith('/uploads/')) return logoUrl || null;
  const filePath = path.join(process.cwd(), logoUrl.replace(/^\//, ''));
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.svg' ? 'image/svg+xml' : 'image/png';
    return `data:${mime};base64,${data.toString('base64')}`;
  } catch {
    return null;
  }
}

export async function generateProgramPDF(data: {
  program: {
    title: string;
    description?: string | null;
    items: Array<{
      title: string;
      description?: string | null;
      startsAt: Date;
      endsAt: Date;
      user?: { firstName: string; lastName: string; email?: string | null; phone?: string | null } | null;
      guestName?: string | null;
      guestEmail?: string | null;
      guestPhone?: string | null;
    }>;
  };
  target: {
    type: 'Service' | 'Event';
    title: string;
    location?: string | null;
    startsAt: Date;
    endsAt?: Date | null;
    churches: Array<{ id: string; name: string; logoUrl?: string | null }>;
  };
  ministryLogoUrl?: string | null;
  primaryColor?: string | null;
}): Promise<Buffer> {
  const logo = await logoDataUri(data.ministryLogoUrl);
  const color = /^#[0-9a-fA-F]{6}$/.test(data.primaryColor || '') ? data.primaryColor : '#d89b12';
  const churchNames = data.target.churches.map((church) => church.name).join(', ');
  const rows = data.program.items.map((item, index) => {
    const person = item.user
      ? `${item.user.firstName} ${item.user.lastName}`.trim()
      : item.guestName || '-';
    const contact = item.user
      ? item.user.email || item.user.phone || ''
      : item.guestEmail || item.guestPhone || '';
    return `
      <tr>
        <td class="index">${index + 1}</td>
        <td class="time">${escapeHtml(formatTime(item.startsAt))}<span>${escapeHtml(formatTime(item.endsAt))}</span></td>
        <td>
          <strong>${escapeHtml(item.title)}</strong>
          ${item.description ? `<p>${escapeHtml(item.description)}</p>` : ''}
        </td>
        <td>
          <strong>${escapeHtml(person)}</strong>
          ${contact ? `<p>${escapeHtml(contact)}</p>` : ''}
        </td>
      </tr>
    `;
  }).join('');

  const html = `
<!DOCTYPE html>
<html>
<head>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; background: #f4f6f8; color: #111827; font-family: Arial, sans-serif; }
    .page { width: 760px; margin: 0 auto; padding: 32px; }
    .sheet { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; overflow: hidden; }
    .header { padding: 32px 36px; border-top: 8px solid ${color}; border-bottom: 1px solid #e5e7eb; }
    .brand { display: flex; align-items: center; gap: 16px; margin-bottom: 24px; }
    .logo { width: 62px; height: 62px; object-fit: contain; border-radius: 10px; border: 1px solid #e5e7eb; padding: 6px; }
    .fallback-logo { width: 62px; height: 62px; border-radius: 10px; background: ${color}; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 24px; font-weight: 800; }
    .eyebrow { color: ${color}; font-size: 12px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: 6px 0 0; font-size: 28px; line-height: 1.15; }
    .meta { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-top: 18px; }
    .meta div { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; }
    .meta span { display: block; color: #6b7280; font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; margin-bottom: 5px; }
    .meta strong { font-size: 13px; line-height: 1.4; }
    .content { padding: 28px 36px 34px; }
    .description { margin-bottom: 20px; color: #374151; font-size: 14px; line-height: 1.55; white-space: pre-line; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #111827; color: #fff; padding: 12px 10px; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; text-align: left; }
    td { border-bottom: 1px solid #e5e7eb; padding: 13px 10px; vertical-align: top; font-size: 13px; }
    td p { margin: 5px 0 0; color: #6b7280; line-height: 1.4; }
    .index { width: 42px; color: ${color}; font-weight: 800; }
    .time { width: 110px; font-weight: 700; }
    .time span { display: block; margin-top: 4px; color: #6b7280; font-weight: 500; }
    .empty { padding: 28px; color: #6b7280; text-align: center; border: 1px dashed #d1d5db; border-radius: 8px; }
    .footer { padding: 16px 36px; border-top: 1px solid #e5e7eb; background: #f9fafb; color: #6b7280; font-size: 11px; display: flex; justify-content: space-between; gap: 16px; }
  </style>
</head>
<body>
  <div class="page">
    <div class="sheet">
      <div class="header">
        <div class="brand">
          ${logo ? `<img class="logo" src="${escapeHtml(logo)}" />` : `<div class="fallback-logo">IC</div>`}
          <div>
            <div class="eyebrow">${escapeHtml(data.target.type)} Program</div>
            <h1>${escapeHtml(data.program.title || data.target.title)}</h1>
          </div>
        </div>
        <div class="meta">
          <div><span>${escapeHtml(data.target.type)}</span><strong>${escapeHtml(data.target.title)}</strong></div>
          <div><span>Church${data.target.churches.length === 1 ? '' : 'es'}</span><strong>${escapeHtml(churchNames || '-')}</strong></div>
          <div><span>Starts</span><strong>${escapeHtml(formatDateTime(data.target.startsAt))}</strong></div>
          <div><span>Ends</span><strong>${escapeHtml(formatDateTime(data.target.endsAt))}</strong></div>
          <div><span>Location</span><strong>${escapeHtml(data.target.location || '-')}</strong></div>
          <div><span>Generated</span><strong>${escapeHtml(formatDateTime(new Date()))}</strong></div>
        </div>
      </div>
      <div class="content">
        ${data.program.description ? `<div class="description">${escapeHtml(data.program.description)}</div>` : ''}
        ${data.program.items.length ? `
          <table>
            <thead><tr><th>#</th><th>Time</th><th>Program Item</th><th>Responsible Person</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        ` : '<div class="empty">No program items have been added.</div>'}
      </div>
      <div class="footer">
        <span>Generated by ICIMS</span>
        <span>${escapeHtml(churchNames || data.target.title)}</span>
      </div>
    </div>
  </div>
</body>
</html>`;

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
