import crypto from 'crypto';

const MAX_EMAIL_LENGTH = 191;

export function buildArchivedUserEmail(email: string): string {
  const uniqueNumber = `${Date.now()}${crypto.randomInt(100000, 999999)}`;
  const archived = `old_${uniqueNumber}_${email}`;
  return archived.length > MAX_EMAIL_LENGTH ? archived.slice(0, MAX_EMAIL_LENGTH) : archived;
}

export async function cancelUserAccount(db: any, userId: string) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true },
  });

  if (!user) return null;

  await db.deviceToken.deleteMany({ where: { userId } });

  return db.user.update({
    where: { id: userId },
    data: {
      email: user.email.startsWith('old_') ? user.email : buildArchivedUserEmail(user.email),
      status: 'cancelled',
      loginEnabled: false,
    },
  });
}
