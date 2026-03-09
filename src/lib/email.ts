import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '465'),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export async function sendEmail(to: string | string[], subject: string, html: string, attachments?: Array<{ filename: string; content: Buffer }>) {
  try {
    await transporter.sendMail({
      from: `"${process.env.SYSTEM || 'ICIMS'}" <${process.env.SMTP_USER}>`,
      to: Array.isArray(to) ? to.join(',') : to,
      subject,
      html,
      attachments,
    });
    const recipients = Array.isArray(to) ? to.join(', ') : to;
    console.log(`Email sent to ${recipients}: ${subject}`);
  } catch (error) {
    console.error('Failed to send email:', error);
    throw error;
  }
}

export default { sendEmail };
