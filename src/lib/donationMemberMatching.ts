import prisma from './prisma';

export function normalizeContactEmail(email?: string | null): string | null {
  const value = email?.trim().toLowerCase();
  return value || null;
}

export function phoneLookupKeys(phone?: string | null): string[] {
  const raw = phone?.trim();
  const digits = raw?.replace(/\D/g, '') || '';
  const keys = new Set<string>();

  if (raw) keys.add(raw);
  if (digits) keys.add(digits);

  if (digits.startsWith('265') && digits.length === 12) {
    keys.add(`+${digits}`);
    keys.add(`0${digits.slice(3)}`);
    keys.add(digits.slice(3));
  } else if (digits.startsWith('0') && digits.length === 10) {
    keys.add(digits.slice(1));
    keys.add(`265${digits.slice(1)}`);
    keys.add(`+265${digits.slice(1)}`);
  } else if (digits.length === 9) {
    keys.add(`0${digits}`);
    keys.add(`265${digits}`);
    keys.add(`+265${digits}`);
  }

  return Array.from(keys).filter(Boolean);
}

export async function findDonationMemberByContact({
  churchId,
  email,
  phone,
}: {
  churchId?: string | null;
  email?: string | null;
  phone?: string | null;
}) {
  if (!churchId) return null;

  const phoneKeys = phoneLookupKeys(phone);
  const normalizedEmail = normalizeContactEmail(email);

  const baseWhere = {
    churchId,
    status: 'active',
    role: { name: 'member' },
  };

  if (phoneKeys.length > 0) {
    const byPhone = await prisma.user.findFirst({
      where: {
        ...baseWhere,
        phone: { in: phoneKeys },
      },
      select: { id: true, firstName: true, lastName: true, email: true, phone: true },
    });
    if (byPhone) return byPhone;
  }

  if (normalizedEmail) {
    return prisma.user.findFirst({
      where: {
        ...baseWhere,
        email: normalizedEmail,
      },
      select: { id: true, firstName: true, lastName: true, email: true, phone: true },
    });
  }

  return null;
}

export function getEffectiveDonationDonor(pendingTx: any, metadata: any) {
  const matchedMemberId = typeof metadata?.matchedMemberId === 'string' && metadata.matchedMemberId
    ? metadata.matchedMemberId
    : null;
  const isSubmittedAsGuest = metadata?.isGuest === true;
  const effectiveUserId = matchedMemberId || (!isSubmittedAsGuest ? pendingTx?.userId : null);
  const effectiveIsGuest = isSubmittedAsGuest && !matchedMemberId;

  return { effectiveUserId, effectiveIsGuest, matchedMemberId };
}
