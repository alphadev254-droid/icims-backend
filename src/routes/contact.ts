import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { queueEmail } from '../lib/emailQueue';

const router = Router();

const contactSchema = z.object({
  name:    z.string().min(1).max(100),
  email:   z.string().email(),
  phone:   z.string().optional(),
  church:  z.string().optional(),
  subject: z.string().min(1).max(200),
  message: z.string().min(10).max(5000),
});

router.post('/', async (req: Request, res: Response): Promise<void> => {
  const parsed = contactSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const { name, email, phone, church, subject, message } = parsed.data;
  const SUPPORT = 'support@churchcentral.church';

  // 1. Notify support inbox
  await queueEmail(
    SUPPORT,
    `[Contact Form] ${subject}`,
    `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
        <h2 style="margin:0 0 16px;font-size:18px">New contact form submission</h2>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <tr><td style="padding:6px 0;color:#666;width:120px">Name</td><td style="padding:6px 0;font-weight:600">${name}</td></tr>
          <tr><td style="padding:6px 0;color:#666">Email</td><td style="padding:6px 0"><a href="mailto:${email}">${email}</a></td></tr>
          ${phone ? `<tr><td style="padding:6px 0;color:#666">Phone</td><td style="padding:6px 0">${phone}</td></tr>` : ''}
          ${church ? `<tr><td style="padding:6px 0;color:#666">Church</td><td style="padding:6px 0">${church}</td></tr>` : ''}
          <tr><td style="padding:6px 0;color:#666">Subject</td><td style="padding:6px 0">${subject}</td></tr>
        </table>
        <hr style="margin:16px 0;border:none;border-top:1px solid #eee" />
        <p style="font-size:14px;color:#333;white-space:pre-wrap;line-height:1.6">${message.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
        <hr style="margin:16px 0;border:none;border-top:1px solid #eee" />
        <p style="font-size:12px;color:#999">Sent from the ICIMS contact form at churchcentral.church</p>
      </div>
    `,
    'notification'
  );

  // 2. Auto-reply to sender
  await queueEmail(
    email,
    `We received your message — ICIMS`,
    `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
        <h2 style="margin:0 0 8px;font-size:18px">Thanks for reaching out, ${name}.</h2>
        <p style="font-size:14px;color:#555;line-height:1.6;margin:0 0 16px">
          We have received your message and will get back to you within one business day.
        </p>
        <div style="background:#f5f5f5;border-radius:8px;padding:16px;font-size:13px;color:#444;margin-bottom:16px">
          <strong>Your message:</strong><br/><br/>
          <em>${message.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br/>')}</em>
        </div>
        <p style="font-size:13px;color:#888">
          If your enquiry is urgent, you can also reach us directly at
          <a href="mailto:${SUPPORT}" style="color:#000">${SUPPORT}</a>.
        </p>
        <hr style="margin:20px 0;border:none;border-top:1px solid #eee" />
        <p style="font-size:12px;color:#aaa">ICIMS — Integrated Church Information Management System</p>
      </div>
    `,
    'notification'
  );

  res.json({ success: true, message: 'Message sent successfully' });
});

// ─── POST /api/contact/demo ───────────────────────────────────────────────────

const demoSchema = z.object({
  name:          z.string().min(1).max(100),
  email:         z.string().email(),
  phone:         z.string().min(1, 'Phone number is required'),
  church:        z.string().min(1, 'Church / organisation name is required'),
  country:       z.enum(['Kenya', 'Malawi', 'Other']),
  memberCount:   z.string().optional(),
  preferredDate: z.string().optional(),
  preferredTime: z.string().optional(),
  message:       z.string().max(2000).optional(),
});

router.post('/demo', async (req: Request, res: Response): Promise<void> => {
  const parsed = demoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const { name, email, phone, church, country, memberCount, preferredDate, preferredTime, message } = parsed.data;
  const SUPPORT = 'support@churchcentral.church';
  const firstName = name.split(' ')[0];

  // 1. Notify ICIMS team
  await queueEmail(
    SUPPORT,
    `[Demo Request] ${church} — ${country}`,
    `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
        <div style="background:#d4a574;padding:16px 24px;border-radius:8px 8px 0 0">
          <h2 style="margin:0;color:#fff;font-size:18px">New Demo Request</h2>
        </div>
        <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;padding:24px">
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <tr style="border-bottom:1px solid #f3f4f6">
              <td style="padding:10px 0;color:#6b7280;width:140px;font-weight:500">Name</td>
              <td style="padding:10px 0;font-weight:600;color:#111">${name}</td>
            </tr>
            <tr style="border-bottom:1px solid #f3f4f6">
              <td style="padding:10px 0;color:#6b7280;font-weight:500">Email</td>
              <td style="padding:10px 0"><a href="mailto:${email}" style="color:#d4a574">${email}</a></td>
            </tr>
            <tr style="border-bottom:1px solid #f3f4f6">
              <td style="padding:10px 0;color:#6b7280;font-weight:500">Phone</td>
              <td style="padding:10px 0">${phone}</td>
            </tr>
            <tr style="border-bottom:1px solid #f3f4f6">
              <td style="padding:10px 0;color:#6b7280;font-weight:500">Church / Org</td>
              <td style="padding:10px 0;font-weight:600;color:#111">${church}</td>
            </tr>
            <tr style="border-bottom:1px solid #f3f4f6">
              <td style="padding:10px 0;color:#6b7280;font-weight:500">Country</td>
              <td style="padding:10px 0">${country}</td>
            </tr>
            ${memberCount ? `<tr style="border-bottom:1px solid #f3f4f6"><td style="padding:10px 0;color:#6b7280;font-weight:500">Members</td><td style="padding:10px 0">${memberCount}</td></tr>` : ''}
            ${preferredDate ? `<tr style="border-bottom:1px solid #f3f4f6"><td style="padding:10px 0;color:#6b7280;font-weight:500">Preferred Date</td><td style="padding:10px 0">${preferredDate}</td></tr>` : ''}
            ${preferredTime ? `<tr style="border-bottom:1px solid #f3f4f6"><td style="padding:10px 0;color:#6b7280;font-weight:500">Preferred Time</td><td style="padding:10px 0">${preferredTime}</td></tr>` : ''}
          </table>
          ${message ? `
          <div style="margin-top:16px;padding:16px;background:#f9fafb;border-radius:6px;font-size:13px;color:#374151;line-height:1.6">
            <strong>Additional notes:</strong><br/><br/>
            ${message.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br/>')}
          </div>` : ''}
          <p style="margin-top:20px;font-size:12px;color:#9ca3af">
            Submitted ${new Date().toLocaleString('en-US', { timeZone: 'Africa/Nairobi' })} EAT via churchcentral.church
          </p>
        </div>
      </div>
    `,
    'notification'
  );

  // 2. Confirmation to requester
  await queueEmail(
    email,
    `Your demo is booked — ICIMS`,
    `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
        <div style="background:#d4a574;padding:20px 24px;border-radius:8px 8px 0 0;text-align:center">
          <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700">ICIMS</h1>
          <p style="margin:6px 0 0;color:rgba(255,255,255,0.85);font-size:13px">Church Management Platform</p>
        </div>
        <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;padding:32px 24px">
          <h2 style="margin:0 0 12px;font-size:20px;color:#111">Thanks, ${firstName}!</h2>
          <p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 20px">
            We've received your demo request for <strong>${church}</strong>. Our team will reach out within <strong>one business day</strong> to confirm your session and send you the meeting link.
          </p>
          <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:20px;margin-bottom:24px">
            <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#374151">What to expect in your demo:</p>
            <ul style="margin:0;padding-left:20px;font-size:13px;color:#6b7280;line-height:2">
              <li>A walkthrough of all 15+ modules</li>
              <li>Live Q&amp;A with our team</li>
              <li>Pricing and package recommendations for your church size</li>
              <li>Onboarding timeline and next steps</li>
            </ul>
          </div>
          ${preferredDate ? `
          <div style="background:#fef9f0;border:1px solid #f3d9b1;border-radius:8px;padding:16px;margin-bottom:24px;font-size:13px;color:#92400e">
            <strong>Your preferred slot:</strong> ${preferredDate}${preferredTime ? ` at ${preferredTime}` : ''}
          </div>` : ''}
          <p style="font-size:13px;color:#6b7280;margin:0">
            Questions before the demo? Email us at
            <a href="mailto:${SUPPORT}" style="color:#d4a574;font-weight:500">${SUPPORT}</a>
            or WhatsApp <strong>+265 998 951 510</strong>.
          </p>
        </div>
        <p style="text-align:center;font-size:11px;color:#9ca3af;margin-top:16px">
          &copy; ${new Date().getFullYear()} ICIMS — Integrated Church Information Management System
        </p>
      </div>
    `,
    'notification'
  );

  res.json({ success: true, message: 'Demo request submitted successfully' });
});

export default router;
