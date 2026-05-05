import { Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import { hashPassword } from '../lib/password';
import { queueEmail } from '../lib/emailQueue';
import { passwordResetTemplate, passwordChangedTemplate } from '../lib/emailTemplates';

const requestResetSchema = z.object({
  email: z.string().email('Invalid email'),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Token required'),
  newPassword: z.string().min(8, 'Password must be at least 8 characters'),
});

export async function requestPasswordReset(req: Request, res: Response): Promise<void> {
  const parsed = requestResetSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const { email } = parsed.data;
  console.log(`[PasswordReset] Reset requested for: ${email}`);

  const user = await prisma.user.findUnique({ where: { email } });

  if (!user) {
    console.log(`[PasswordReset] Email not found — returning generic response`);
    res.json({ success: true, message: 'If the email exists, a reset link has been sent' });
    return;
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 3600000);

  await prisma.passwordResetToken.create({
    data: { userId: user.id, token, expiresAt },
  });

  console.log(`[PasswordReset] Token created for user ${user.id} (${user.email}), expires at ${expiresAt.toISOString()}`);

  queueEmail(
    user.email,
    'Password Reset Request',
    passwordResetTemplate({ firstName: user.firstName, resetToken: token }),
    'password_reset'
  )
    .then(() => console.log(`[PasswordReset] Email queued successfully for ${user.email}`))
    .catch(err => console.error(`[PasswordReset] Failed to queue email for ${user.email}:`, err));

  res.json({ success: true, message: 'If the email exists, a reset link has been sent' });
}

export async function resetPassword(req: Request, res: Response): Promise<void> {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    return;
  }

  const { token, newPassword } = parsed.data;
  console.log(`[PasswordReset] Reset attempt with token: ${token.slice(0, 8)}...`);

  const resetToken = await prisma.passwordResetToken.findFirst({
    where: { token, expiresAt: { gte: new Date() }, used: false },
    include: { user: true },
  });

  if (!resetToken) {
    console.log(`[PasswordReset] Invalid or expired token`);
    res.status(400).json({ success: false, message: 'Invalid or expired reset token' });
    return;
  }

  console.log(`[PasswordReset] Valid token for user ${resetToken.userId} (${resetToken.user.email})`);

  const hashedPassword = await hashPassword(newPassword);

  await prisma.$transaction([
    prisma.user.update({ where: { id: resetToken.userId }, data: { password: hashedPassword } }),
    prisma.passwordResetToken.update({ where: { id: resetToken.id }, data: { used: true } }),
  ]);

  console.log(`[PasswordReset] Password updated for ${resetToken.user.email}`);

  queueEmail(
    resetToken.user.email,
    'Password Changed Successfully',
    passwordChangedTemplate({ firstName: resetToken.user.firstName, email: resetToken.user.email }),
    'password_changed'
  )
    .then(() => console.log(`[PasswordReset] Confirmation email queued for ${resetToken.user.email}`))
    .catch(err => console.error(`[PasswordReset] Failed to queue confirmation email for ${resetToken.user.email}:`, err));

  res.json({ success: true, message: 'Password reset successfully' });
}
