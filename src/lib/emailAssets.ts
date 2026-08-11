import fs from 'fs';
import path from 'path';
import type { EmailAttachment } from './emailQueue';

export const ICIMS_LOGO_CID = 'icims-logo';

export function getIcimsLogoAttachment(): EmailAttachment | null {
  const candidates = [
    process.env.ICIMS_EMAIL_LOGO_PATH,
    path.join(process.cwd(), 'public', 'icims-logo.jpg'),
  ].filter(Boolean) as string[];

  const logoPath = candidates.find(candidate => fs.existsSync(candidate));
  if (!logoPath) return null;

  return {
    filename: 'icims-logo.jpg',
    content: fs.readFileSync(logoPath),
    cid: ICIMS_LOGO_CID,
    contentType: 'image/jpeg',
    contentDisposition: 'inline',
  };
}

export function withIcimsLogoAttachment(attachments: EmailAttachment[]): EmailAttachment[] {
  const logo = getIcimsLogoAttachment();
  return logo ? [logo, ...attachments] : attachments;
}
