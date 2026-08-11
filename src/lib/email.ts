import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';

type EmailAttachment = {
  filename: string;
  content: Buffer;
  cid?: string;
  contentType?: string;
  contentDisposition?: 'attachment' | 'inline';
};

const ICIMS_LOGO_CID = 'icims-logo';

console.log('[EMAIL] SMTP config - host:', process.env.SMTP_HOST, 'port:', process.env.SMTP_PORT, 'secure:', process.env.SMTP_SECURE, 'user:', process.env.SMTP_USER ? process.env.SMTP_USER : 'NOT SET');

function getLogoAttachment(): EmailAttachment | null {
  const logoPath = [
    process.env.ICIMS_EMAIL_LOGO_PATH,
    path.join(process.cwd(), 'public', 'icims-logo.jpg'),
  ].filter(Boolean).find(candidate => fs.existsSync(candidate as string));

  if (!logoPath) return null;

  return {
    filename: 'icims-logo.jpg',
    content: fs.readFileSync(logoPath as string),
    cid: ICIMS_LOGO_CID,
    contentType: 'image/jpeg',
    contentDisposition: 'inline',
  };
}

function prepareBrandedEmail(html: string, attachments?: EmailAttachment[]) {
  const preparedAttachments = [...(attachments || [])];
  const hasInlineLogo = html.includes(`cid:${ICIMS_LOGO_CID}`);
  const shouldInjectLogo = !hasInlineLogo
    && !html.includes('class="invoice-brand"')
    && html.includes('class="container"');

  let preparedHtml = html;
  const logo = getLogoAttachment();

  if (logo && shouldInjectLogo) {
    preparedHtml = html.replace(
      /<div class="container">/,
      `<div class="container">
    <div class="email-brand">
      <img src="cid:${ICIMS_LOGO_CID}" alt="ICIMS" class="email-logo" />
      <h1>${process.env.SYSTEM || 'ICIMS'}</h1>
    </div>`
    );
  }

  if (
    logo
    && preparedHtml.includes(`cid:${ICIMS_LOGO_CID}`)
    && !preparedAttachments.some(attachment => attachment.cid === ICIMS_LOGO_CID)
  ) {
    preparedAttachments.unshift(logo);
  }

  return {
    html: preparedHtml,
    attachments: preparedAttachments.length > 0 ? preparedAttachments : undefined,
  };
}

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '465'),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export async function sendEmail(
  to: string | string[],
  subject: string,
  html: string,
  attachments?: EmailAttachment[],
) {
  const recipients = Array.isArray(to) ? to.join(', ') : to;
  const prepared = prepareBrandedEmail(html, attachments);
  console.log(`[EMAIL] Attempting to send "${subject}" to ${recipients} - attachments: ${prepared.attachments?.length ?? 0}`);

  try {
    const info: any = await transporter.sendMail({
      from: `"${process.env.SYSTEM || 'ICIMS'}" <${process.env.SMTP_USER}>`,
      to: Array.isArray(to) ? to.join(',') : to,
      subject,
      html: prepared.html,
      attachments: prepared.attachments,
    });
    console.log(`[EMAIL] Sent to ${recipients} - messageId: ${info.messageId}`);
  } catch (error: any) {
    console.error(`[EMAIL] Failed to send to ${recipients} - subject: "${subject}"`);
    console.error(`[EMAIL] Error code: ${error.code} message: ${error.message}`);
    if (error.response) console.error(`[EMAIL] SMTP response: ${error.response}`);
    throw error;
  }
}
