import nodemailer from 'nodemailer';
import axios from 'axios';
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
const EMAIL_PROVIDER = (process.env.EMAIL_PROVIDER || 'hostinger').toLowerCase();

console.log(
  '[EMAIL] Provider:',
  EMAIL_PROVIDER,
  'SMTP host:',
  process.env.SMTP_HOST || 'NOT SET',
  'SMTP user:',
  process.env.SMTP_USER ? process.env.SMTP_USER : 'NOT SET',
  'Resend:',
  process.env.RESEND_API_KEY ? 'CONFIGURED' : 'NOT SET',
);

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

function defaultFromAddress() {
  if (EMAIL_PROVIDER === 'resend') {
    return process.env.RESEND_FROM || process.env.EMAIL_FROM || `"${process.env.SYSTEM || 'ICIMS'}" <no-reply@churchcentral.church>`;
  }

  return process.env.SMTP_FROM || `"${process.env.SYSTEM || 'ICIMS'}" <${process.env.SMTP_USER}>`;
}

function htmlToText(html: string) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

async function sendWithResend(
  to: string | string[],
  subject: string,
  html: string,
  attachments?: EmailAttachment[],
) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is required when EMAIL_PROVIDER=resend');
  }

  const payload: Record<string, unknown> = {
    from: defaultFromAddress(),
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
    text: htmlToText(html),
  };

  if (process.env.EMAIL_REPLY_TO || process.env.RESEND_REPLY_TO) {
    payload.reply_to = process.env.EMAIL_REPLY_TO || process.env.RESEND_REPLY_TO;
  }

  if (attachments?.length) {
    payload.attachments = attachments.map(attachment => ({
      filename: attachment.filename,
      content: attachment.content.toString('base64'),
      content_type: attachment.contentType,
      content_disposition: attachment.contentDisposition,
      content_id: attachment.cid,
    }));
  }

  const response = await axios.post('https://api.resend.com/emails', payload, {
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    timeout: 30000,
  });

  return { messageId: response.data?.id };
}

export async function sendEmail(
  to: string | string[],
  subject: string,
  html: string,
  attachments?: EmailAttachment[],
) {
  const recipients = Array.isArray(to) ? to.join(', ') : to;
  const prepared = prepareBrandedEmail(html, attachments);
  console.log(`[EMAIL] Attempting to send "${subject}" to ${recipients} via ${EMAIL_PROVIDER} - attachments: ${prepared.attachments?.length ?? 0}`);

  try {
    const info: any = EMAIL_PROVIDER === 'resend'
      ? await sendWithResend(to, subject, prepared.html, prepared.attachments)
      : await transporter.sendMail({
          from: defaultFromAddress(),
          to: Array.isArray(to) ? to.join(',') : to,
          subject,
          html: prepared.html,
          attachments: prepared.attachments,
        });
    console.log(`[EMAIL] Sent to ${recipients} - messageId: ${info.messageId}`);
  } catch (error: any) {
    console.error(`[EMAIL] Failed to send to ${recipients} - subject: "${subject}"`);
    console.error(`[EMAIL] Error code: ${error.code || error.response?.status || 'unknown'} message: ${error.message}`);
    if (error.response?.data) console.error(`[EMAIL] Provider response: ${JSON.stringify(error.response.data)}`);
    else if (error.response) console.error(`[EMAIL] Provider response: ${error.response}`);
    throw error;
  }
}
