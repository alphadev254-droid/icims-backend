import admin from 'firebase-admin';
import prisma from './prisma';

// Initialize Firebase Admin SDK if not already initialized
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId: process.env.FIREBASE_PROJECT_ID,
  });
}

const messaging = admin.messaging();

/**
 * Send a push notification to a specific user (all their devices).
 * Automatically removes invalid tokens.
 */
export async function sendPushNotification(
  userId: string,
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<void> {
  try {
    const deviceTokens = await prisma.deviceToken.findMany({
      where: { userId },
      select: { id: true, token: true },
    });

    if (deviceTokens.length === 0) return;

    const tokens = deviceTokens.map(dt => dt.token);

    const message: admin.messaging.MulticastMessage = {
      tokens,
      notification: { title, body },
      data: data || {},
      webpush: {
        notification: {
          title,
          body,
          icon: '/icims-logo.jpg',
        },
      },
    };

    const response = await messaging.sendEachForMulticast(message);

    // Remove invalid tokens
    if (response.failureCount > 0) {
      const invalidTokens: string[] = [];
      response.responses.forEach((resp, idx) => {
        if (
          !resp.success &&
          resp.error &&
          (resp.error.code === 'messaging/registration-token-not-registered' ||
            resp.error.code === 'messaging/invalid-registration-token')
        ) {
          invalidTokens.push(tokens[idx]);
        }
      });

      if (invalidTokens.length > 0) {
        await prisma.deviceToken.deleteMany({
          where: { token: { in: invalidTokens } },
        });
      }
    }
  } catch (error: any) {
    console.error(`[FCM] Failed to send push to user ${userId}:`, error.message);
  }
}

/**
 * Send a push notification to multiple users at once.
 * Groups all their device tokens into a single multicast call.
 */
export async function sendPushToUsers(
  userIds: string[],
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<void> {
  const uniqueUserIds = [...new Set(userIds)];
  await Promise.all(
    uniqueUserIds.map(userId => sendPushNotification(userId, title, body, data))
  );
}
