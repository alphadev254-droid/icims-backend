import { queueEmail } from './emailQueue';
import prisma from './prisma';

type RegistrationActivity = {
  title: string;
  summary: string;
  details: Array<[string, string | null | undefined]>;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function notifySystemAdminOfRegistrationActivity(activity: RegistrationActivity): Promise<void> {
  const rows = activity.details
    .filter(([, value]) => value?.trim())
    .map(([label, value]) => `<tr>
      <td style="padding:8px 12px;color:#6b7280;border-bottom:1px solid #e5e7eb">${escapeHtml(label)}</td>
      <td style="padding:8px 12px;color:#111827;border-bottom:1px solid #e5e7eb;font-weight:600">${escapeHtml(value!.trim())}</td>
    </tr>`)
    .join('');

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f3f4f6;font-family:Arial,sans-serif;color:#1f2937">
    <div style="max-width:620px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden">
      <div style="padding:20px 24px;background:#111827;color:#fff"><h1 style="margin:0;font-size:20px">${escapeHtml(activity.title)}</h1></div>
      <div style="padding:24px"><p style="margin:0 0 18px;line-height:1.6">${escapeHtml(activity.summary)}</p>
        <table style="width:100%;border-collapse:collapse;font-size:14px">${rows}</table>
        <p style="margin:20px 0 0;color:#6b7280;font-size:12px">ICIMS system notification</p>
      </div>
    </div>
  </body></html>`;

  try {
    const systemAdmin = await prisma.user.findFirst({
      where: {
        role: { is: { name: 'system_admin' } },
        status: 'active',
        loginEnabled: true,
      },
      select: { email: true },
      orderBy: { createdAt: 'asc' },
    });

    if (!systemAdmin?.email) {
      console.error(`No active system admin email found for notification (${activity.title})`);
      return;
    }

    await queueEmail(systemAdmin.email, activity.title, html, 'notification');
  } catch (error) {
    console.error(`Failed to queue system admin notification (${activity.title}):`, error);
  }
}
