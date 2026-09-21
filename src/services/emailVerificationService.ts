import crypto from 'crypto';
import prisma from '../lib/prisma';
import { queueEmail } from '../lib/emailQueue';
import { hashPassword, comparePassword } from '../lib/password';

const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;

function emailVerificationTemplate(data: { firstName: string; otpCode: string; expiresInMinutes: number }) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111827">
      <h2 style="margin:0 0 12px">Verify your ICIMS account</h2>
      <p>Hello ${data.firstName},</p>
      <p>Use this code to verify your email address and activate your account:</p>
      <div style="font-size:32px;letter-spacing:8px;font-weight:700;background:#f3f4f6;border-radius:12px;padding:18px;text-align:center;margin:20px 0">
        ${data.otpCode}
      </div>
      <p>This code expires in ${data.expiresInMinutes} minutes.</p>
      <p style="font-size:12px;color:#6b7280">If you did not create this account, you can ignore this email.</p>
    </div>
  `;
}

export async function sendEmailVerificationOtp(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, firstName: true, emailVerified: true } });
  if (!user || user.emailVerified) return;

  const otpCode = crypto.randomInt(100000, 1000000).toString();
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

  await prisma.emailVerificationOtp.create({
    data: {
      userId: user.id,
      otpHash: await hashPassword(otpCode),
      expiresAt,
    },
  });

  await queueEmail(
    user.email,
    'Verify your ICIMS account',
    emailVerificationTemplate({ firstName: user.firstName, otpCode, expiresInMinutes: OTP_TTL_MINUTES }),
    'email_verification',
  );
}

export async function verifyEmailOtp(email: string, otpCode: string) {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, emailVerified: true } });
  if (!user) return { success: false, message: 'Account not found' };
  if (user.emailVerified) return { success: true, userId: user.id };

  const otp = await prisma.emailVerificationOtp.findFirst({
    where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!otp) return { success: false, message: 'OTP is missing or expired. Request a new code.' };
  if (otp.attempts >= OTP_MAX_ATTEMPTS) {
    await prisma.emailVerificationOtp.update({ where: { id: otp.id }, data: { usedAt: new Date() } });
    return { success: false, message: 'Too many incorrect attempts. Request a new code.' };
  }

  const valid = await comparePassword(otpCode, otp.otpHash);
  if (!valid) {
    await prisma.emailVerificationOtp.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
    return { success: false, message: 'Invalid OTP code' };
  }

  await prisma.$transaction([
    prisma.emailVerificationOtp.update({ where: { id: otp.id }, data: { usedAt: new Date() } }),
    prisma.user.update({ where: { id: user.id }, data: { emailVerified: true, emailVerifiedAt: new Date() } }),
  ]);

  return { success: true, userId: user.id };
}
