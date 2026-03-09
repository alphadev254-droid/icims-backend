import prisma from '../lib/prisma';
import { sendEmail } from '../lib/email';

const BATCH_SIZE = 10;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY = 60000; // 1 minute

let isProcessing = false;

console.log('📧 Email worker starting...');

export async function processEmailQueue(): Promise<void> {
  if (isProcessing) {
    console.log('⏭️  Email worker already running, skipping...');
    return;
  }

  isProcessing = true;
  
  try {
    const emails = await prisma.$queryRaw<any[]>`
      SELECT * FROM email_queue
      WHERE status = 'pending' AND attempts < ${MAX_ATTEMPTS}
      ORDER BY createdAt ASC
      LIMIT ${BATCH_SIZE}
    `;

    for (const email of emails) {
      try {
        const recipients = email.to.split(',').map((e: string) => e.trim());
        const attachments = email.attachments ? JSON.parse(email.attachments).map((a: any) => ({
          filename: a.filename,
          content: Buffer.from(a.content, 'base64')
        })) : undefined;
        
        await sendEmail(recipients, email.subject, email.html, attachments);
        
        await prisma.$executeRaw`
          UPDATE email_queue
          SET status = 'sent', sentAt = NOW()
          WHERE id = ${email.id}
        `;
      } catch (error: any) {
        await prisma.$executeRaw`
          UPDATE email_queue
          SET attempts = attempts + 1, error = ${error.message}, status = ${email.attempts + 1 >= MAX_ATTEMPTS ? 'failed' : 'pending'}
          WHERE id = ${email.id}
        `;
      }
    }
  } catch (error) {
    console.error('Email queue processing error:', error);
  } finally {
    isProcessing = false;
  }
}

setInterval(processEmailQueue, RETRY_DELAY);
processEmailQueue();
