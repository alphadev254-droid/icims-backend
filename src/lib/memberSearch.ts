import prisma from './prisma';

const memberSelect = {
  id: true,
  churchId: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  memberType: true,
  gender: true,
  dateOfBirth: true,
  church: { select: { id: true, name: true } },
} as const;

function phoneLookupKeys(value: string) {
  const raw = value.trim();
  const digits = raw.replace(/\D/g, '');
  const keys = new Set<string>();
  if (raw) keys.add(raw.toLowerCase());
  if (digits) keys.add(digits);
  const withoutLocalPrefix = digits.replace(/^0+/, '');
  if (withoutLocalPrefix) keys.add(withoutLocalPrefix);
  return Array.from(keys).filter(Boolean);
}

export async function searchActiveMembers(params: {
  churchIds: string[];
  query: string;
  page: number;
  limit: number;
}) {
  const { churchIds, query, page, limit } = params;
  const skip = (page - 1) * limit;
  if (!churchIds.length || query.trim().length < 3) return { members: [], total: 0 };

  const q = query.trim();
  const terms = q.split(/\s+/).filter(Boolean);
  const phoneVariants = phoneLookupKeys(q);
  const fallbackWhere: any = {
    churchId: { in: churchIds },
    status: 'active',
    OR: [
      { firstName: { contains: q } },
      { lastName: { contains: q } },
      { email: { contains: q } },
      { phone: { contains: q } },
      ...phoneVariants.map(value => ({ phone: { contains: value } })),
      ...(terms.length > 1 ? [{
        AND: terms.map(term => ({
          OR: [
            { firstName: { contains: term } },
            { lastName: { contains: term } },
            { email: { contains: term } },
            { phone: { contains: term } },
          ],
        })),
      }] : []),
    ],
  };
  const booleanSearch = terms
    .map(term => term.replace(/[+\-<>()~*"@]+/g, '').trim())
    .filter(term => term.length >= 3)
    .map(term => `+${term}*`)
    .join(' ');

  let members: any[] = [];
  let total = 0;
  try {
    const churchPlaceholders = churchIds.map(() => '?').join(', ');
    const countRows = await prisma.$queryRawUnsafe<Array<{ total: bigint | number }>>(
      `SELECT COUNT(*) AS total FROM users u
       WHERE u.churchId IN (${churchPlaceholders}) AND u.status = 'active'
       AND MATCH(u.firstName, u.lastName, u.email, u.phone) AGAINST (? IN BOOLEAN MODE)`,
      ...churchIds, booleanSearch,
    );
    total = Number(countRows[0]?.total ?? 0);
    if (total > 0) {
      const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT u.id, MATCH(u.firstName, u.lastName, u.email, u.phone) AGAINST (? IN BOOLEAN MODE) AS relevance
         FROM users u
         WHERE u.churchId IN (${churchPlaceholders}) AND u.status = 'active'
         AND MATCH(u.firstName, u.lastName, u.email, u.phone) AGAINST (? IN BOOLEAN MODE)
         ORDER BY relevance DESC, u.firstName ASC, u.lastName ASC LIMIT ? OFFSET ?`,
        booleanSearch, ...churchIds, booleanSearch, limit, skip,
      );
      const orderedIds = rows.map(row => row.id);
      const found = await prisma.user.findMany({ where: { id: { in: orderedIds } }, select: memberSelect });
      const byId = new Map(found.map(member => [member.id, member]));
      members = orderedIds.map(id => byId.get(id)).filter(Boolean);
    }
  } catch (error) {
    console.warn('[MemberSearch] Full-text search failed, using contains fallback:', error);
    total = 0;
  }

  // Phone formats vary by country. Compare normalized digit suffixes instead of
  // maintaining a hardcoded list of international dialling codes.
  const queryDigits = q.replace(/\D/g, '').replace(/^0+/, '');
  if (total === 0 && queryDigits.length >= 6) {
    try {
      const churchPlaceholders = churchIds.map(() => '?').join(', ');
      const normalizedPhoneSql = `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(u.phone, ''), '+', ''), ' ', ''), '-', ''), '(', ''), ')', ''), '.', '')`;
      const phoneRows = await prisma.$queryRawUnsafe<Array<{ id: string; total: bigint | number }>>(
        `SELECT u.id, COUNT(*) OVER() AS total
         FROM users u
         WHERE u.churchId IN (${churchPlaceholders}) AND u.status = 'active'
           AND CHAR_LENGTH(${normalizedPhoneSql}) >= 6
           AND (${normalizedPhoneSql} LIKE CONCAT('%', ?) OR ? LIKE CONCAT('%', TRIM(LEADING '0' FROM ${normalizedPhoneSql})))
         ORDER BY u.firstName ASC, u.lastName ASC LIMIT ? OFFSET ?`,
        ...churchIds, queryDigits, queryDigits, limit, skip,
      );
      total = Number(phoneRows[0]?.total ?? 0);
      if (total > 0) {
        const orderedIds = phoneRows.map(row => row.id);
        const found = await prisma.user.findMany({ where: { id: { in: orderedIds } }, select: memberSelect });
        const byId = new Map(found.map(member => [member.id, member]));
        members = orderedIds.map(id => byId.get(id)).filter(Boolean);
      }
    } catch (error) {
      console.warn('[MemberSearch] Normalized phone search failed, using contains fallback:', error);
      total = 0;
    }
  }

  if (total === 0) {
    const [fallbackMembers, fallbackTotal] = await Promise.all([
      prisma.user.findMany({ where: fallbackWhere, select: memberSelect, orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }], skip, take: limit }),
      prisma.user.count({ where: fallbackWhere }),
    ]);
    members = fallbackMembers;
    total = fallbackTotal;
  }
  return { members, total };
}
