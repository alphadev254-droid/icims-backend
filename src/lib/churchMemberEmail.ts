import prisma from './prisma';
import { queueEmail } from './emailQueue';

type EmailHtmlBuilder = (member: { firstName: string; lastName: string; email: string }) => string;

interface QueueChurchMemberEmailsOptions {
  churchId: string;
  subject: string;
  buildHtml: EmailHtmlBuilder;
  emailType?: string;
  excludeUserId?: string;
}

export async function queueChurchMemberEmails({
  churchId,
  subject,
  buildHtml,
  emailType = 'notification',
  excludeUserId,
}: QueueChurchMemberEmailsOptions): Promise<number> {
  const members = await prisma.user.findMany({
    where: {
      churchId,
      status: 'active',
      ...(excludeUserId ? { id: { not: excludeUserId } } : {}),
    },
    select: { id: true, firstName: true, lastName: true, email: true },
  });

  const recipients = members.filter(member => member.email);

  if (recipients.length === 0) {
    console.log(`[ChurchEmail] No active member emails for church ${churchId} - subject="${subject}"`);
    return 0;
  }

  const chunkSize = 25;
  for (let index = 0; index < recipients.length; index += chunkSize) {
    const chunk = recipients.slice(index, index + chunkSize);
    await Promise.allSettled(
      chunk.map(member =>
        queueEmail(
          member.email,
          subject,
          buildHtml(member),
          emailType
        )
      )
    );
  }

  console.log(`[ChurchEmail] Queued ${recipients.length} email(s) for church ${churchId} - subject="${subject}"`);
  return recipients.length;
}
