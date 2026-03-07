import prisma from './prisma';

export type EmailType = 
  | 'user_created'
  | 'registration'
  | 'password_reset'
  | 'password_changed'
  | 'ticket_purchase'
  | 'donation_receipt'
  | 'withdrawal_request_user'
  | 'withdrawal_request_admin'
  | 'package_subscription';

export async function queueEmail(
  to: string,
  subject: string,
  html: string,
  type: EmailType
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO email_queue (id, \`to\`, subject, html, type, status, attempts, createdAt)
    VALUES (${generateId()}, ${to}, ${subject}, ${html}, ${type}, 'pending', 0, NOW())
  `;
}

function generateId(): string {
  return `email_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}
