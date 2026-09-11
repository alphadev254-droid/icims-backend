import { Request } from 'express';
import prisma from './prisma';

export const TIMEZONE_HEADER = 'x-timezone';

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value.trim() }).format();
    return true;
  } catch {
    return false;
  }
}

export function normalizeTimeZone(value: unknown): string | null {
  return isValidTimeZone(value) ? value.trim() : null;
}

export function getRequestTimeZone(req?: Request): string | null {
  return req ? normalizeTimeZone(req.get(TIMEZONE_HEADER)) : null;
}

export async function resolveTimeZone(input: {
  req?: Request;
  explicit?: unknown;
  churchId?: string | null;
  ministryAdminId?: string | null;
}): Promise<string> {
  const explicit = normalizeTimeZone(input.explicit);
  if (explicit) return explicit;

  if (input.churchId) {
    const rows = await prisma.$queryRaw<Array<{ timezone: string | null; ministryAdminId: string | null }>>`
      SELECT timezone, ministryAdminId FROM churches WHERE id = ${input.churchId} LIMIT 1
    `;
    const churchZone = normalizeTimeZone(rows[0]?.timezone);
    if (churchZone) return churchZone;
    input.ministryAdminId ??= rows[0]?.ministryAdminId;
  }

  if (input.ministryAdminId) {
    const rows = await prisma.$queryRaw<Array<{ timezone: string | null }>>`
      SELECT timezone FROM users WHERE id = ${input.ministryAdminId} LIMIT 1
    `;
    const ministryZone = normalizeTimeZone(rows[0]?.timezone);
    if (ministryZone) return ministryZone;
  }

  return getRequestTimeZone(input.req)
    ?? normalizeTimeZone(process.env.DEFAULT_TIMEZONE)
    ?? 'UTC';
}

export function todayInTimeZone(timeZone: string, now = new Date()): Date {
  const parts = partsInTimeZone(now, timeZone);
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
}

export function dateRangeInTimeZone(from: string | undefined, to: string | undefined, timeZone: string) {
  const range: { gte?: Date; lt?: Date } = {};
  if (from) range.gte = zonedDateTimeToUtc(from, '00:00:00', timeZone);
  if (to) {
    const parsed = new Date(`${to}T00:00:00.000Z`);
    if (!Number.isNaN(parsed.getTime())) {
      parsed.setUTCDate(parsed.getUTCDate() + 1);
      range.lt = zonedDateTimeToUtc(parsed.toISOString().slice(0, 10), '00:00:00', timeZone);
    }
  }
  return range;
}

function partsInTimeZone(value: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const result: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== 'literal') result[part.type] = Number(part.value);
  }
  return result;
}

/** Converts a date-only value plus local clock time in an IANA zone into a UTC instant. */
export function zonedDateTimeToUtc(date: Date | string, time: string | null | undefined, timeZone: string): Date {
  const raw = typeof date === 'string' ? date : date.toISOString().slice(0, 10);
  const dateMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const timeMatch = time?.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!dateMatch) return new Date(date);

  const desired = {
    year: Number(dateMatch[1]), month: Number(dateMatch[2]), day: Number(dateMatch[3]),
    hour: Number(timeMatch?.[1] ?? 0), minute: Number(timeMatch?.[2] ?? 0), second: Number(timeMatch?.[3] ?? 0),
  };
  const desiredUtc = Date.UTC(desired.year, desired.month - 1, desired.day, desired.hour, desired.minute, desired.second);
  let candidate = new Date(desiredUtc);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = partsInTimeZone(candidate, timeZone);
    const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    const correction = desiredUtc - actualUtc;
    if (correction === 0) break;
    candidate = new Date(candidate.getTime() + correction);
  }
  return candidate;
}
