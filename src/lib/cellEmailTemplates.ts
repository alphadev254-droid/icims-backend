const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:8080';

const getBaseStyle = () => `
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #1f2937; background-color: #f9fafb; margin: 0; padding: 0; }
    .container { max-width: 600px; margin: 40px auto; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .church-header { background: white; color: #1e3a8a; padding: 20px 24px; text-align: center; border-bottom: 4px solid #d4a574; }
    .church-header h1 { margin: 0; font-size: 22px; font-weight: 700; letter-spacing: 0.5px; }
    .header { background: #d4a574; color: white; padding: 32px 24px; text-align: center; }
    .header h1 { margin: 0; font-size: 24px; font-weight: 600; }
    .content { padding: 32px 24px; }
    .content h2 { margin: 0 0 16px 0; font-size: 20px; font-weight: 600; color: #111827; }
    .content p { margin: 0 0 16px 0; color: #4b5563; }
    .button { display: inline-block; background: #d4a574; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 16px 0; font-weight: 500; }
    .info-box { background: #f3f4f6; padding: 20px; border-radius: 6px; border-left: 4px solid #d4a574; margin: 20px 0; }
    .info-box h3 { margin: 0 0 12px 0; font-size: 16px; font-weight: 600; color: #111827; }
    .info-box p { margin: 8px 0; color: #4b5563; font-size: 14px; }
    .footer { background: #f9fafb; padding: 24px; text-align: center; color: #6b7280; font-size: 12px; border-top: 1px solid #e5e7eb; }
  </style>
`;

const escapeHtml = (value: unknown) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

export const cellMemberAddedTemplate = (data: {
  firstName: string;
  cellName: string;
  churchName: string;
  addedBy: string;
  isLeader?: boolean;
  isAssistant?: boolean;
}) => {
  const roleLabel = data.isLeader ? 'Cell Leader' : data.isAssistant ? 'Assistant Cell Leader' : 'Cell Member';

  return `
<!DOCTYPE html>
<html>
<head>${getBaseStyle()}</head>
<body>
  <div class="container">
    <div class="church-header">
      <h1>${escapeHtml(data.churchName)}</h1>
    </div>
    <div class="header">
      <h1>Added to Cell</h1>
    </div>
    <div class="content">
      <h2>Hello ${escapeHtml(data.firstName)},</h2>
      <p>You have been added to a cell in ${escapeHtml(data.churchName)}.</p>

      <div class="info-box">
        <h3>Cell Details</h3>
        <p><strong>Cell:</strong> ${escapeHtml(data.cellName)}</p>
        <p><strong>Role:</strong> ${escapeHtml(roleLabel)}</p>
        <p><strong>Added By:</strong> ${escapeHtml(data.addedBy)}</p>
        <p><strong>Date:</strong> ${new Date().toLocaleDateString()}</p>
      </div>

      <p>You can view your cell information and related activities from your dashboard.</p>

      <a href="${FRONTEND_URL}/dashboard/cells" class="button">View My Cell</a>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} ${escapeHtml(data.churchName)}</p>
    </div>
  </div>
</body>
</html>
`;
};
