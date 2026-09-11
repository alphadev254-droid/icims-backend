const DEFAULT_PERSON_FIELDS = ['firstName', 'lastName', 'email', 'phone'] as const;

export function personSearchTerms(value?: string | null): string[] {
  return String(value || '').trim().split(/\s+/).filter(Boolean);
}

/**
 * Builds a Prisma predicate for people whose names are stored in separate
 * columns. Every typed term must match at least one field, so both
 * "John Banda" and "Banda John" work without widening the surrounding scope.
 */
export function buildPersonSearchWhere(
  value: string,
  fields: readonly string[] = DEFAULT_PERSON_FIELDS,
): Record<string, unknown> {
  const terms = personSearchTerms(value);
  if (!terms.length) return {};
  return {
    AND: terms.map(term => ({
      OR: fields.map(field => ({ [field]: { contains: term } })),
    })),
  };
}
