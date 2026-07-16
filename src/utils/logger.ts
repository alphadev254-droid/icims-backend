type LogLevel = 'debug' | 'info' | 'warn' | 'error';

type LogFields = Record<string, unknown>;

const service = process.env.SERVICE_NAME || 'icims-backend';
const environment = process.env.NODE_ENV || 'development';

function maskMiddle(value: string, visibleStart: number, visibleEnd: number) {
  if (!value) return value;
  if (value.length <= visibleStart + visibleEnd) return '*'.repeat(value.length);
  return `${value.slice(0, visibleStart)}${'*'.repeat(Math.max(3, value.length - visibleStart - visibleEnd))}${value.slice(-visibleEnd)}`;
}

export function maskEmail(email?: string | null) {
  if (!email) return undefined;
  const [local, domain] = email.trim().toLowerCase().split('@');
  if (!local || !domain) return maskMiddle(email, 2, 2);
  return `${maskMiddle(local, 2, 1)}@${domain}`;
}

export function maskPhone(phone?: string | null) {
  if (!phone) return undefined;
  const normalized = phone.replace(/\s+/g, '');
  return maskMiddle(normalized, 4, 3);
}

export function maskToken(token?: string | null) {
  if (!token) return undefined;
  return maskMiddle(token, 6, 4);
}

export function displayName(firstName?: string | null, lastName?: string | null) {
  const name = [firstName, lastName]
    .map(part => part?.trim())
    .filter(Boolean)
    .join(' ');
  return name || undefined;
}

function cleanValue(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (Array.isArray(value)) return value.map(cleanValue);

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .map(([key, entryValue]) => [key, cleanValue(entryValue)]),
    );
  }

  return value;
}

export function log(level: LogLevel, event: string, fields: LogFields = {}) {
  const payload = cleanValue({
    timestamp: new Date().toISOString(),
    level,
    service,
    environment,
    event,
    ...fields,
  });

  const line = JSON.stringify(payload);
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (event: string, fields?: LogFields) => log('debug', event, fields),
  info: (event: string, fields?: LogFields) => log('info', event, fields),
  warn: (event: string, fields?: LogFields) => log('warn', event, fields),
  error: (event: string, fields?: LogFields) => log('error', event, fields),
};
