import { Request, Response } from 'express';
import prisma from '../lib/prisma';

/**
 * Register a new FCM device token for the authenticated user.
 * POST /push/register-token
 * Body: { token: string, platform?: string }
 */
export async function registerDeviceToken(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const { token, platform } = req.body;
  if (!token) {
    res.status(400).json({ success: false, message: 'Token is required' });
    return;
  }

  try {
    // Upsert: if token already exists for this user, update it; otherwise create
    const existing = await prisma.deviceToken.findUnique({ where: { token } });

    if (existing) {
      if (existing.userId !== userId) {
        // Token was registered by another user — reassign
        await prisma.deviceToken.update({
          where: { token },
          data: { userId, platform: platform || 'web', userAgent: req.headers['user-agent'] || null },
        });
      } else {
        // Token already belongs to this user — just update metadata
        await prisma.deviceToken.update({
          where: { token },
          data: { platform: platform || 'web', userAgent: req.headers['user-agent'] || null },
        });
      }
    } else {
      await prisma.deviceToken.create({
        data: {
          userId,
          token,
          platform: platform || 'web',
          userAgent: req.headers['user-agent'] || null,
        },
      });
    }

    res.json({ success: true });
  } catch (error: any) {
    console.error('[PushToken] Register error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to register token' });
  }
}

/**
 * Unregister (remove) a device token.
 * DELETE /push/unregister-token
 * Body: { token: string }
 */
export async function unregisterDeviceToken(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const { token } = req.body;
  if (!token) {
    res.status(400).json({ success: false, message: 'Token is required' });
    return;
  }

  try {
    await prisma.deviceToken.deleteMany({
      where: { token, userId },
    });
    res.json({ success: true });
  } catch (error: any) {
    console.error('[PushToken] Unregister error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to unregister token' });
  }
}
