const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:8080';
const SYSTEM_NAME = process.env.SYSTEM || 'ICIMS';

const getBaseStyle = () => `
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #1f2937; background-color: #f3f4f6; margin: 0; padding: 0; }
    .container { max-width: 620px; margin: 36px auto; background: #ffffff; border-radius: 12px; overflow: hidden; border: 1px solid #e5e7eb; box-shadow: 0 12px 32px rgba(17,24,39,0.08); }
    .email-brand { background: #ffffff; color: #111827; padding: 24px 24px 18px 24px; text-align: center; border-bottom: 4px solid #d4a574; }
    .email-logo { width: 62px; height: 62px; object-fit: contain; border-radius: 14px; display: block; margin: 0 auto 10px auto; }
    .email-brand h1 { margin: 0; font-size: 22px; font-weight: 800; letter-spacing: 0.7px; }
    .church-header { background: #ffffff; color: #111827; padding: 18px 24px; text-align: center; border-bottom: 1px solid #e5e7eb; }
    .church-header h1 { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: 0.3px; }
    .header { background: #111827; color: #ffffff; padding: 30px 24px; text-align: center; }
    .header h1 { margin: 0; font-size: 24px; font-weight: 700; }
    .header p { margin: 8px 0 0 0; color: #d4a574; font-size: 14px; font-weight: 600; }
    .content { padding: 32px 26px; }
    .content h2 { margin: 0 0 16px 0; font-size: 20px; font-weight: 700; color: #111827; }
    .content h3 { color: #111827; }
    .content p { margin: 0 0 16px 0; color: #4b5563; }
    .button { display: inline-block; background: #d4a574; color: #111827 !important; padding: 12px 24px; text-decoration: none; border-radius: 7px; margin: 16px 0; font-weight: 700; }
    .button:hover { background: #c89563; }
    .info-box { background: #f9fafb; padding: 20px; border-radius: 8px; border: 1px solid #e5e7eb; border-left: 4px solid #d4a574; margin: 20px 0; }
    .info-box h3 { margin: 0 0 12px 0; font-size: 16px; font-weight: 700; color: #111827; }
    .info-box p { margin: 8px 0; color: #4b5563; font-size: 14px; }
    .footer { background: #f9fafb; padding: 24px; text-align: center; color: #6b7280; font-size: 12px; border-top: 1px solid #e5e7eb; }
    .footer p { margin: 4px 0; }
    ol { padding-left: 20px; }
    ol li { margin: 8px 0; color: #4b5563; }
    a { color: #b8873f; }
  </style>
`;

const getChurchHeader = (churchName?: string) => churchName ? `
  <div class="church-header">
    <h1>${churchName}</h1>
  </div>
` : '';

const escapeHtml = (value: unknown) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const formatEmailDate = (value: Date | string | null | undefined) => value
  ? new Date(value).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
  : '—';

const formatEmailMoney = (currency: string, amount: number) =>
  `${currency} ${Number(amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const userCreatedTemplate = (data: { firstName: string; lastName: string; email: string; password: string; churchName?: string; roleName?: string }) => `
<!DOCTYPE html>
<html>
<head>${getBaseStyle()}</head>
<body>
  <div class="container">
    ${getChurchHeader(data.churchName)}
    <div class="header">
      <h1>${SYSTEM_NAME}</h1>
      <p>Welcome to the Church Management System</p>
    </div>
    <div class="content">
      <h2>Hello ${data.firstName} ${data.lastName},</h2>
      <p>Your account has been created successfully${data.churchName ? ` for ${data.churchName}` : ''}.</p>
      
      <div class="info-box">
        <h3>Your Login Credentials</h3>
        <p><strong>Email:</strong> ${data.email}</p>
        <p><strong>Temporary Password:</strong> ${data.password}</p>
        ${data.roleName ? `<p><strong>Role:</strong> ${data.roleName}</p>` : ''}
      </div>
      
      <p><strong>Important:</strong> Please change your password after your first login for security purposes.</p>
      
      <a href="${FRONTEND_URL}/login" class="button">Login to Your Account</a>
      
      <p>If you have any questions, please contact your church administrator.</p>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} ${data.churchName || SYSTEM_NAME}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`;

export const registrationTemplate = (data: { firstName: string; lastName: string; email: string; ministryName?: string; siteUrl?: string; roleName?: string; churchName?: string }) => `
<!DOCTYPE html>
<html>
<head>${getBaseStyle()}</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Welcome to ${SYSTEM_NAME}!</h1>
      <p>Your ministry account is ready</p>
    </div>
    <div class="content">
      <h2>Hello ${data.firstName} ${data.lastName},</h2>
      <p>Your account has been created successfully. Here's everything you need to get started.</p>

      <div class="info-box">
        <h3>Your Account Details</h3>
        <p><strong>Ministry:</strong> ${data.ministryName || '—'}</p>
        <p><strong>Email:</strong> ${data.email}</p>
        ${data.siteUrl ? `<p><strong>Your Ministry Site:</strong> <a href="${data.siteUrl}" style="color: #d4a574;">${data.siteUrl}</a></p>` : ''}
      </div>

      ${data.siteUrl ? `<p style="font-size: 13px; color: #6b7280;">Your public ministry website is being activated — it will be live within a few minutes.</p>` : ''}

      <h3>Next Steps:</h3>
      <ol>
        <li><strong>Choose a Package:</strong> Select a subscription plan that fits your ministry's needs</li>
        <li><strong>Customise Your Church Website:</strong> Add your logo, banner, service times and contact details — go to <a href="${FRONTEND_URL}/dashboard/church-profile" style="color: #d4a574;">Church Website</a> inside your dashboard to edit your public page</li>
        <li><strong>Add Your Branches:</strong> Register your church branches and locations</li>
        <li><strong>Invite Your Team:</strong> Add staff and leaders to help manage your ministry</li>
      </ol>

      <a href="${FRONTEND_URL}/dashboard" class="button">Go to Dashboard</a>

      <p>Need help? Reply to this email or visit our support centre.</p>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} ${SYSTEM_NAME}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`;

export const passwordResetTemplate = (data: { firstName: string; resetToken: string; expiresInMinutes?: number; churchName?: string }) => `
<!DOCTYPE html>
<html>
<head>${getBaseStyle()}</head>
<body>
  <div class="container">
    ${getChurchHeader(data.churchName)}
    <div class="header">
      <h1>Password Reset Request</h1>
    </div>
    <div class="content">
      <h2>Hello ${data.firstName},</h2>
      <p>We received a request to reset your password. Click the button below to create a new password:</p>
      
      <a href="${FRONTEND_URL}/reset-password?token=${data.resetToken}" class="button">Reset Password</a>
      
      <p>This link will expire in ${data.expiresInMinutes || 5} minutes for security reasons.</p>
      
      <p><strong>If you didn't request this,</strong> please ignore this email and your password will remain unchanged.</p>
      
      <p style="color: #6b7280; font-size: 14px;">For security, never share this link with anyone.</p>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} ${data.churchName || SYSTEM_NAME}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`;

export const passwordChangedTemplate = (data: { firstName: string; email: string; churchName?: string }) => `
<!DOCTYPE html>
<html>
<head>${getBaseStyle()}</head>
<body>
  <div class="container">
    ${getChurchHeader(data.churchName)}
    <div class="header">
      <h1>Password Changed Successfully</h1>
    </div>
    <div class="content">
      <h2>Hello ${data.firstName},</h2>
      <p>Your password has been changed successfully.</p>
      
      <div class="info-box">
        <p><strong>Account:</strong> ${data.email}</p>
        <p><strong>Changed:</strong> ${new Date().toLocaleString()}</p>
      </div>
      
      <p><strong>If you didn't make this change,</strong> please contact your administrator immediately.</p>
      
      <a href="${FRONTEND_URL}/login" class="button">Login to Your Account</a>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} ${data.churchName || SYSTEM_NAME}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`;

export const ticketPurchaseTemplate = (data: { 
  firstName: string; 
  eventTitle: string; 
  ticketNumber: string; 
  amount: number; 
  currency: string;
  eventDate: string;
  eventEndDate: string;
  eventLocation: string;
  churchName?: string;
  viewUrl?: string;
}) => `
<!DOCTYPE html>
<html>
<head>${getBaseStyle()}</head>
<body>
  <div class="container">
    ${getChurchHeader(data.churchName)}
    <div class="header">
      <h1>Ticket Confirmation</h1>
    </div>
    <div class="content">
      <h2>Hello ${data.firstName},</h2>
      <p>Your ticket has been purchased successfully!</p>
      
      <div class="info-box">
        <h3>Event Details</h3>
        <p><strong>Event:</strong> ${data.eventTitle}</p>
        <p><strong>Date:</strong> ${data.eventDate} - ${data.eventEndDate}</p>
        <p><strong>Location:</strong> ${data.eventLocation}</p>
        <p><strong>Ticket Number:</strong> ${data.ticketNumber}</p>
        <p><strong>Amount Paid:</strong> ${data.currency} ${data.amount.toLocaleString()}</p>
      </div>
      
      <p>Please present this ticket number at the event entrance.</p>
      
      <p>Your ticket and payment receipt are attached to this email.</p>
      
      <a href="${data.viewUrl || `${FRONTEND_URL}/dashboard/my-tickets`}" class="button">View My Tickets</a>
      
      <p>We look forward to seeing you at the event!</p>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} ${data.churchName || SYSTEM_NAME}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`;

export const eventCreatedTemplate = (data: {
  firstName: string;
  eventTitle: string;
  eventDate: string;
  eventEndDate: string;
  eventTime: string;
  eventLocation: string;
  description?: string;
  churchName?: string;
}) => `
<!DOCTYPE html>
<html>
<head>${getBaseStyle()}</head>
<body>
  <div class="container">
    ${getChurchHeader(data.churchName)}
    <div class="header">
      <h1>New Event</h1>
    </div>
    <div class="content">
      <h2>Hello ${data.firstName},</h2>
      <p>A new event has been created${data.churchName ? ` for ${data.churchName}` : ''}.</p>

      <div class="info-box">
        <h3>${data.eventTitle}</h3>
        <p><strong>Date:</strong> ${data.eventDate}${data.eventEndDate !== data.eventDate ? ` - ${data.eventEndDate}` : ''}</p>
        <p><strong>Time:</strong> ${data.eventTime}</p>
        <p><strong>Location:</strong> ${data.eventLocation}</p>
        ${data.description ? `<p style="white-space: pre-wrap;">${data.description.substring(0, 240)}${data.description.length > 240 ? '...' : ''}</p>` : ''}
      </div>

      <a href="${FRONTEND_URL}/dashboard/events" class="button">View Event</a>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} ${data.churchName || SYSTEM_NAME}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`;

export const donationReceiptTemplate = (data: {
  firstName: string;
  amount: number;
  currency: string;
  campaignName: string;
  reference: string;
  isAnonymous: boolean;
  isGuest?: boolean;
  churchName?: string;
}) => `
<!DOCTYPE html>
<html>
<head>${getBaseStyle()}</head>
<body>
  <div class="container">
    ${getChurchHeader(data.churchName)}
    <div class="header">
      <h1>Donation Receipt</h1>
    </div>
    <div class="content">
      <h2>Hello ${data.firstName},</h2>
      <p>Thank you for your generous donation!</p>
      
      <div class="info-box">
        <h3>Donation Details</h3>
        <p><strong>Campaign:</strong> ${data.campaignName}</p>
        <p><strong>Amount:</strong> ${data.currency} ${data.amount.toLocaleString()}</p>
        <p><strong>Reference:</strong> ${data.reference}</p>
        <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
        ${data.isAnonymous ? '<p><strong>Status:</strong> Anonymous Donation</p>' : ''}
      </div>
      
      <p>Your contribution makes a difference in our community. May God bless you abundantly!</p>
      
      ${!data.isGuest ? `<a href="${FRONTEND_URL}/dashboard/donations" class="button">View Donation History</a>` : ''}
      
      <p style="font-style: italic; color: #6b7280;">"Each of you should give what you have decided in your heart to give, not reluctantly or under compulsion, for God loves a cheerful giver." - 2 Corinthians 9:7</p>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} ${data.churchName || SYSTEM_NAME}. All rights reserved.</p>
      <p>This is an official receipt for your records.</p>
    </div>
  </div>
</body>
</html>
`;

export const packageInvoiceTemplate = (data: {
  firstName?: string | null;
  ministryName?: string | null;
  invoiceNumber: string;
  packageName: string;
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
  payUrl: string;
  heading?: string;
  intro?: string;
  logoCid?: string;
}) => `
<!DOCTYPE html>
<html>
<head>
${getBaseStyle()}
<style>
  .invoice-brand { padding: 22px 24px; text-align: center; background: #ffffff; border-bottom: 4px solid #d4a574; }
  .invoice-logo { width: 64px; height: 64px; object-fit: contain; border-radius: 14px; display: block; margin: 0 auto 10px auto; }
  .invoice-brand h1 { margin: 0; color: #111827; font-size: 22px; letter-spacing: 0.6px; }
  .invoice-hero { background: #111827; color: #ffffff; padding: 30px 24px; text-align: center; }
  .invoice-hero h1 { margin: 0; font-size: 24px; font-weight: 700; }
  .invoice-hero p { margin: 8px 0 0 0; color: #d4a574; font-size: 14px; font-weight: 700; letter-spacing: 0.06em; }
  .invoice-amount { background: #fffaf0; border: 1px solid #f0d7a4; border-radius: 8px; padding: 20px; margin: 22px 0; text-align: center; }
  .invoice-amount .label { color: #6b7280; font-size: 13px; margin: 0 0 6px 0; }
  .invoice-amount .value { color: #111827; font-size: 30px; line-height: 1.15; font-weight: 800; margin: 0; }
  .invoice-grid { width: 100%; border-collapse: collapse; margin: 20px 0; }
  .invoice-grid td { padding: 11px 0; border-bottom: 1px solid #e5e7eb; font-size: 14px; vertical-align: top; }
  .invoice-grid td:first-child { color: #6b7280; font-weight: 700; width: 42%; }
  .invoice-grid td:last-child { color: #111827; font-weight: 600; text-align: right; }
  .invoice-callout { background: #f9fafb; border-left: 4px solid #d4a574; border-radius: 6px; padding: 16px; margin: 18px 0; }
  .invoice-callout h3 { margin: 0 0 8px 0; font-size: 15px; color: #111827; }
  .invoice-callout p { margin: 0; white-space: pre-line; font-size: 14px; color: #4b5563; }
</style>
</head>
<body>
  <div class="container">
    <div class="invoice-brand">
      ${data.logoCid ? `<img src="cid:${escapeHtml(data.logoCid)}" alt="ICIMS" class="invoice-logo" />` : ''}
      <h1>ICIMS</h1>
    </div>
    <div class="invoice-hero">
      <h1>${escapeHtml(data.heading || 'Package Invoice')}</h1>
      <p>${escapeHtml(data.invoiceNumber)}</p>
    </div>
    <div class="content">
      <h2>Hello ${escapeHtml(data.firstName || 'there')},</h2>
      <p>${escapeHtml(data.intro || `Your package invoice is ready for ${data.packageName}.`)}</p>

      <div class="invoice-amount">
        <p class="label">Balance Due</p>
        <p class="value">${formatEmailMoney(data.currency, data.balanceDue)}</p>
      </div>

      <table class="invoice-grid" role="presentation">
        ${data.ministryName ? `<tr><td>Ministry</td><td>${escapeHtml(data.ministryName)}</td></tr>` : ''}
        <tr><td>Package</td><td>${escapeHtml(data.packageName)}</td></tr>
        <tr><td>Billing Cycle</td><td>${escapeHtml(data.billingCycle)}</td></tr>
        <tr><td>Invoice Date</td><td>${formatEmailDate(data.invoiceDate)}</td></tr>
        <tr><td>Due Date</td><td>${formatEmailDate(data.dueDate)}</td></tr>
        <tr><td>Service Period</td><td>${formatEmailDate(data.servicePeriodStart)} - ${formatEmailDate(data.servicePeriodEnd)}</td></tr>
        <tr><td>Amount</td><td>${formatEmailMoney(data.currency, data.amount)}</td></tr>
        <tr><td>Paid</td><td>${formatEmailMoney(data.currency, data.amountPaid)}</td></tr>
      </table>

      ${data.notes ? `
        <div class="invoice-callout">
          <h3>Notes</h3>
          <p>${escapeHtml(data.notes)}</p>
        </div>
      ` : ''}

      ${data.terms ? `
        <div class="invoice-callout">
          <h3>Terms</h3>
          <p>${escapeHtml(data.terms)}</p>
        </div>
      ` : ''}

      <a href="${escapeHtml(data.payUrl)}" class="button">Pay Invoice</a>
      <p style="font-size: 13px; color: #6b7280;">A detailed PDF copy of this invoice is attached for your records.</p>
    </div>
    <div class="footer">
      <p>This invoice was sent by ${SYSTEM_NAME}.</p>
      <p>&copy; ${new Date().getFullYear()} ${SYSTEM_NAME}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`;

export const givingCampaignCreatedTemplate = (data: {
  firstName: string;
  campaignName: string;
  category: string;
  currency: string;
  targetAmount?: number | null;
  endDate?: string | null;
  description?: string | null;
  churchName?: string;
}) => `
<!DOCTYPE html>
<html>
<head>${getBaseStyle()}</head>
<body>
  <div class="container">
    ${getChurchHeader(data.churchName)}
    <div class="header">
      <h1>New Giving Campaign</h1>
    </div>
    <div class="content">
      <h2>Hello ${data.firstName},</h2>
      <p>A new giving campaign has been created${data.churchName ? ` for ${data.churchName}` : ''}.</p>

      <div class="info-box">
        <h3>${data.campaignName}</h3>
        <p><strong>Category:</strong> ${data.category.replace('_', ' ')}</p>
        ${data.targetAmount ? `<p><strong>Target:</strong> ${data.currency} ${data.targetAmount.toLocaleString()}</p>` : ''}
        ${data.endDate ? `<p><strong>End Date:</strong> ${data.endDate}</p>` : ''}
        ${data.description ? `<p style="white-space: pre-wrap;">${data.description.substring(0, 240)}${data.description.length > 240 ? '...' : ''}</p>` : ''}
      </div>

      <a href="${FRONTEND_URL}/dashboard/giving" class="button">View Giving Campaign</a>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} ${data.churchName || SYSTEM_NAME}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`;

export const announcementCreatedTemplate = (data: {
  firstName: string;
  title: string;
  content: string;
  type: string;
  priority: string;
  churchName?: string;
}) => `
<!DOCTYPE html>
<html>
<head>${getBaseStyle()}</head>
<body>
  <div class="container">
    ${getChurchHeader(data.churchName)}
    <div class="header">
      <h1>${data.priority === 'urgent' ? 'Urgent ' : ''}${data.type === 'newsletter' ? 'Newsletter' : data.type === 'prayer_request' ? 'Prayer Request' : 'Announcement'}</h1>
    </div>
    <div class="content">
      <h2>Hello ${data.firstName},</h2>
      <p>A new church post has been shared${data.churchName ? ` by ${data.churchName}` : ''}.</p>

      <div class="info-box">
        <h3>${data.title}</h3>
        <p style="white-space: pre-wrap;">${data.content.substring(0, 300)}${data.content.length > 300 ? '...' : ''}</p>
      </div>

      <a href="${FRONTEND_URL}/dashboard/communication" class="button">View Post</a>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} ${data.churchName || SYSTEM_NAME}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`;

export const withdrawalRequestUserTemplate = (data: {
  firstName: string;
  amount: number;
  fee: number;
  netAmount: number;
  currency: string;
  method: string;
  withdrawalId: string;
  churchName?: string;
  mobileOperator?: string;
  mobileNumber?: string;
  bankCode?: string;
  accountName?: string;
  accountNumber?: string;
}) => `
<!DOCTYPE html>
<html>
<head>${getBaseStyle()}</head>
<body>
  <div class="container">
    ${getChurchHeader(data.churchName)}
    <div class="header">
      <h1>Withdrawal Request Received</h1>
    </div>
    <div class="content">
      <h2>Hello ${data.firstName},</h2>
      <p>Your withdrawal request has been submitted successfully and is being processed.</p>
      
      <div class="info-box">
        <h3>Withdrawal Details</h3>
        <p><strong>Request ID:</strong> ${data.withdrawalId}</p>
        <p><strong>Payout Amount:</strong> ${data.currency} ${data.amount.toLocaleString()}</p>
        <p><strong>Processing Fee:</strong> ${data.currency} ${data.fee.toLocaleString()}</p>
        <p><strong>Total Debited:</strong> ${data.currency} ${data.netAmount.toLocaleString()}</p>
        <p><strong>Method:</strong> ${data.method === 'mobile_money' ? 'Mobile Money' : 'Bank Transfer'}</p>
        ${data.churchName ? `<p><strong>Ministry:</strong> ${data.churchName}</p>` : ''}
        <p><strong>Platform:</strong> ${SYSTEM_NAME}</p>
        <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
      </div>

      ${data.method === 'mobile_money' ? `
      <div class="info-box">
        <h3>Mobile Money Details</h3>
        <p><strong>Operator:</strong> ${data.mobileOperator === 'airtel' ? 'Airtel Money' : 'TNM Mpamba'}</p>
        <p><strong>Mobile Number:</strong> ${data.mobileNumber}</p>
      </div>
      ` : `
      <div class="info-box">
        <h3>Bank Transfer Details</h3>
        <p><strong>Bank Code:</strong> ${data.bankCode}</p>
        <p><strong>Account Name:</strong> ${data.accountName}</p>
        <p><strong>Account Number:</strong> ${data.accountNumber}</p>
      </div>
      `}

      <p>Your funds will be transferred to your account once the request is approved and processed.</p>
      
      <a href="${FRONTEND_URL}/withdrawals" class="button">View Withdrawal Status</a>
    </div>
    <div class="footer">
      <p>&​copy; ${new Date().getFullYear()} ${data.churchName || SYSTEM_NAME}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`;

export const withdrawalRequestAdminTemplate = (data: {
  userName: string;
  userEmail: string;
  amount: number;
  fee: number;
  netAmount: number;
  currency: string;
  method: string;
  withdrawalId: string;
  mobileOperator?: string;
  mobileNumber?: string;
  bankCode?: string;
  accountName?: string;
  accountNumber?: string;
  churchName?: string;
}) => `
<!DOCTYPE html>
<html>
<head>${getBaseStyle()}</head>
<body>
  <div class="container">
    ${getChurchHeader(data.churchName)}
    <div class="header">
      <h1>New Withdrawal Request</h1>
    </div>
    <div class="content">
      <h2>Withdrawal Request Notification</h2>
      <p>A new withdrawal request has been submitted and requires your attention.</p>
      
      <div class="info-box">
        <h3>Request Details</h3>
        <p><strong>Request ID:</strong> ${data.withdrawalId}</p>
        <p><strong>Requested By:</strong> ${data.userName} (${data.userEmail})</p>
        <p><strong>Payout Amount:</strong> ${data.currency} ${data.amount.toLocaleString()}</p>
        <p><strong>Processing Fee:</strong> ${data.currency} ${data.fee.toLocaleString()}</p>
        <p><strong>Total Debited:</strong> ${data.currency} ${data.netAmount.toLocaleString()}</p>
        <p><strong>Method:</strong> ${data.method === 'mobile_money' ? 'Mobile Money' : 'Bank Transfer'}</p>
        ${data.churchName ? `<p><strong>Ministry:</strong> ${data.churchName}</p>` : ''}
        <p><strong>Platform:</strong> ${SYSTEM_NAME}</p>
        <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
      </div>
      
      ${data.method === 'mobile_money' ? `
      <div class="info-box">
        <h3>Mobile Money Details</h3>
        <p><strong>Operator:</strong> ${data.mobileOperator === 'airtel' ? 'Airtel Money' : 'TNM Mpamba'}</p>
        <p><strong>Mobile Number:</strong> ${data.mobileNumber}</p>
      </div>
      ` : `
      <div class="info-box">
        <h3>Bank Transfer Details</h3>
        <p><strong>Bank Code:</strong> ${data.bankCode}</p>
        <p><strong>Account Name:</strong> ${data.accountName}</p>
        <p><strong>Account Number:</strong> ${data.accountNumber}</p>
      </div>
      `}
      
      <a href="${FRONTEND_URL}/withdrawals" class="button">Review Request</a>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} ${data.churchName || SYSTEM_NAME}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`;

export const withdrawalOtpTemplate = (data: {
  firstName: string;
  otpCode: string;
  amount: number;
  currency: string;
  method: string;
  expiresInMinutes: number;
  churchName?: string;
}) => `
<!DOCTYPE html>
<html>
<head>${getBaseStyle()}</head>
<body>
  <div class="container">
    ${getChurchHeader(data.churchName)}
    <div class="header">
      <h1>Withdrawal Verification</h1>
      <p>Security confirmation required</p>
    </div>
    <div class="content">
      <h2>Hello ${data.firstName},</h2>
      <p>Use the verification code below to confirm your withdrawal request.</p>

      <div class="info-box" style="text-align:center;">
        <h3>Your OTP Code</h3>
        <p style="font-size:32px; letter-spacing:8px; font-weight:700; color:#111827; margin:16px 0;">${data.otpCode}</p>
        <p>This code expires in ${data.expiresInMinutes} minutes.</p>
      </div>

      <div class="info-box">
        <h3>Request Summary</h3>
        <p><strong>Amount:</strong> ${data.currency} ${data.amount.toLocaleString()}</p>
        <p><strong>Method:</strong> ${data.method === 'mobile_money' ? 'Mobile Money' : 'Bank Transfer'}</p>
      </div>

      <p>If you did not request this withdrawal, do not share this code and contact your administrator immediately.</p>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} ${data.churchName || SYSTEM_NAME}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`;


export const withdrawalFinalStatusTemplate = (data: {
  firstName: string;
  email: string;
  amount: number;
  fee: number;
  netAmount: number;
  currency: string;
  method: string;
  status: 'completed' | 'failed';
  withdrawalId: string;
  mobileOperator?: string;
  mobileNumber?: string;
  bankCode?: string;
  accountName?: string;
  accountNumber?: string;
  churchName?: string;
}) => `
<!DOCTYPE html>
<html>
<head>${getBaseStyle()}</head>
<body>
  <div class="container">
    ${getChurchHeader(data.churchName)}
    <div class="header">
      <h1>Withdrawal ${data.status === 'completed' ? 'Completed' : 'Failed'}</h1>
    </div>
    <div class="content">
      <h2>Hello ${data.firstName},</h2>
      <p>Your withdrawal request (${data.withdrawalId}) has been <strong>${data.status}</strong>.</p>
      <div class="info-box">
        <h3>Withdrawal Summary</h3>
        <p><strong>Amount:</strong> ${data.currency} ${data.amount.toLocaleString()}</p>
        <p><strong>Processing Fee:</strong> ${data.currency} ${data.fee.toLocaleString()}</p>
        <p><strong>Net Amount:</strong> ${data.currency} ${data.netAmount.toLocaleString()}</p>
        <p><strong>Method:</strong> ${data.method === 'mobile_money' ? 'Mobile Money' : 'Bank Transfer'}</p>
        ${data.churchName ? `<p><strong>Ministry:</strong> ${data.churchName}</p>` : ''}
        <p><strong>Platform:</strong> ${SYSTEM_NAME}</p>
        <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
      </div>

      ${data.method === 'mobile_money' ? `
      <div class="info-box">
        <h3>Mobile Money Details</h3>
        <p><strong>Operator:</strong> ${data.mobileOperator === 'airtel' ? 'Airtel Money' : 'TNM Mpamba'}</p>
        <p><strong>Mobile Number:</strong> ${data.mobileNumber}</p>
      </div>
      ` : `
      <div class="info-box">
        <h3>Bank Transfer Details</h3>
        <p><strong>Bank Code:</strong> ${data.bankCode}</p>
        <p><strong>Account Name:</strong> ${data.accountName}</p>
        <p><strong>Account Number:</strong> ${data.accountNumber}</p>
      </div>
      `}

      ${data.status === 'failed'
        ? '<p>The amount has been returned to your ministry wallet balance.</p>'
        : '<p>The funds have been sent to the destination account you provided.</p>'}

      <a href="${FRONTEND_URL}/withdrawals" class="button">View Withdrawal History</a>
    </div>
    <div class="footer">
      <p>&​copy; ${new Date().getFullYear()} ${data.churchName || SYSTEM_NAME}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`;

export const packageSubscriptionTemplate = (data: {
  firstName: string;
  packageName: string;
  amount: number;
  currency: string;
  billingCycle: string;
  expiresAt: string;
  features: string[];
  churchName?: string;
}) => `
<!DOCTYPE html>
<html>
<head>${getBaseStyle()}</head>
<body>
  <div class="container">
    ${getChurchHeader(data.churchName)}
    <div class="header">
      <h1>Subscription Confirmed</h1>
    </div>
    <div class="content">
      <h2>Hello ${data.firstName},</h2>
      <p>Thank you for subscribing! Your ${data.packageName} package is now active.</p>
      
      <div class="info-box">
        <h3>Subscription Details</h3>
        <p><strong>Package:</strong> ${data.packageName}</p>
        <p><strong>Amount Paid:</strong> ${data.currency} ${data.amount.toLocaleString()}</p>
        <p><strong>Billing Cycle:</strong> ${data.billingCycle}</p>
        <p><strong>Expires On:</strong> ${data.expiresAt}</p>
      </div>
      
      <div class="info-box">
        <h3>Your Package Includes</h3>
        <ul style="margin: 0; padding-left: 20px;">
          ${data.features.map(f => `<li style="margin: 8px 0; color: #4b5563;">${f}</li>`).join('')}
        </ul>
      </div>
      
      <p>You now have full access to all features included in your package.</p>
      
      <a href="${FRONTEND_URL}/dashboard" class="button">Go to Dashboard</a>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} ${data.churchName || SYSTEM_NAME}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`;

export const subscriptionExpiringTemplate = (data: {
  firstName: string;
  packageName: string;
  daysLeft: number;
  expiresAt: string;
  renewUrl: string;
}) => `
<!DOCTYPE html>
<html>
<head>${getBaseStyle()}</head>
<body>
  <div class="container">
    <div class="header" style="background: #f59e0b;">
      <h1>Subscription Expiring Soon</h1>
    </div>
    <div class="content">
      <h2>Hello ${data.firstName},</h2>
      <p>Your <strong>${data.packageName}</strong> subscription will expire in <strong>${data.daysLeft} days</strong>.</p>
      
      <div class="info-box" style="background: #fef3c7; border-left-color: #f59e0b;">
        <p><strong>Expiration Date:</strong> ${data.expiresAt}</p>
        <p><strong>Package:</strong> ${data.packageName}</p>
      </div>
      
      <p>To continue enjoying uninterrupted access to all features, please renew your subscription before it expires.</p>
      
      <a href="${data.renewUrl}" class="button" style="background: #f59e0b;">Renew Subscription</a>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} ${SYSTEM_NAME}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`;

export const subscriptionExpiredTemplate = (data: {
  firstName: string;
  packageName: string;
  expiredAt: string;
  daysSinceExpiry: number;
  renewUrl: string;
}) => `
<!DOCTYPE html>
<html>
<head>${getBaseStyle()}</head>
<body>
  <div class="container">
    <div class="header" style="background: #dc2626;">
      <h1>Subscription Expired</h1>
    </div>
    <div class="content">
      <h2>Hello ${data.firstName},</h2>
      <p>Your <strong>${data.packageName}</strong> subscription has expired.</p>
      
      <div class="info-box" style="background: #fee2e2; border-left-color: #dc2626;">
        <p><strong>Expired On:</strong> ${data.expiredAt}</p>
        <p><strong>Days Since Expiry:</strong> ${data.daysSinceExpiry}</p>
        <p><strong>Package:</strong> ${data.packageName}</p>
      </div>
      
      <p>Your access to premium features has been suspended. Renew now to restore full functionality.</p>
      
      <a href="${data.renewUrl}" class="button" style="background: #dc2626;">Renew Now</a>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} ${SYSTEM_NAME}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`;

export const adminDirectEmailTemplate = (data: { firstName: string; subject: string; message: string }) => `
<!DOCTYPE html>
<html>
<head>${getBaseStyle()}</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${SYSTEM_NAME}</h1>
      <p>Message from System Administrator</p>
    </div>
    <div class="content">
      <h2>Hello ${data.firstName},</h2>
      <div style="white-space: pre-line; color: #4b5563; line-height: 1.8;">${data.message}</div>
    </div>
    <div class="footer">
      <p>This message was sent to you by the ${SYSTEM_NAME} system administrator.</p>
      <p>&copy; ${new Date().getFullYear()} ${SYSTEM_NAME}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`;

export const memberWelcomeTemplate = (data: { firstName: string; lastName: string; email: string; churchName: string }) => `
<!DOCTYPE html>
<html>
<head>${getBaseStyle()}</head>
<body>
  <div class="container">
    ${getChurchHeader(data.churchName)}
    <div class="header">
      <h1>Welcome to ${data.churchName}!</h1>
    </div>
    <div class="content">
      <h2>Hello ${data.firstName} ${data.lastName},</h2>
      <p>Welcome! Your membership account has been created successfully.</p>
      
      <div class="info-box">
        <h3>Your Account</h3>
        <p><strong>Email:</strong> ${data.email}</p>
        <p><strong>Church:</strong> ${data.churchName}</p>
      </div>
      
      <p>You can now access your member dashboard to:</p>
      <ul style="padding-left: 20px;">
        <li style="margin: 8px 0; color: #4b5563;">View upcoming events and church activities</li>
        <li style="margin: 8px 0; color: #4b5563;">Make donations and contributions</li>
        <li style="margin: 8px 0; color: #4b5563;">Access church resources and announcements</li>
        <li style="margin: 8px 0; color: #4b5563;">Stay connected with your church community</li>
      </ul>
      
      <a href="${FRONTEND_URL}/login" class="button">Access Your Dashboard</a>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} ${data.churchName}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`;

export const visitRequestTemplate = (data: {
  ministryName: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string | null;
  serviceName?: string | null;
  notes?: string | null;
  submittedAt: string;
}) => `
<!DOCTYPE html>
<html>
<head>${getBaseStyle()}</head>
<body>
  <div class="container">
    ${getChurchHeader(data.ministryName)}
    <div class="header">
      <h1>New Visit Request</h1>
    </div>
    <div class="content">
      <h2>${data.firstName} ${data.lastName} is planning a visit.</h2>
      <p>A visitor submitted the Plan a Visit form on your public church website.</p>

      <div class="info-box">
        <h3>Visitor Details</h3>
        <p><strong>Name:</strong> ${data.firstName} ${data.lastName}</p>
        <p><strong>Email:</strong> ${data.email}</p>
        ${data.phone ? `<p><strong>Phone:</strong> ${data.phone}</p>` : ''}
        ${data.serviceName ? `<p><strong>Service:</strong> ${data.serviceName}</p>` : ''}
        <p><strong>Submitted:</strong> ${data.submittedAt}</p>
      </div>

      ${data.notes ? `
        <div class="info-box" style="background:#f9fafb;">
          <h3>Notes</h3>
          <p style="white-space:pre-line;">${data.notes}</p>
        </div>
      ` : ''}
    </div>
    <div class="footer">
      <p>This message was sent from the public website contact form for ${data.ministryName}.</p>
      <p>&copy; ${new Date().getFullYear()} ${SYSTEM_NAME}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`;
