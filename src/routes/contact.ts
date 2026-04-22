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

export default router;
