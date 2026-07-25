import { NextFunction, Request, Response } from 'express';
import { displayName, logger, maskEmail, maskPhone } from '../utils/logger';

const MONEY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_AUDIT_JSON_BYTES = Number(process.env.PAYMENT_AUDIT_MAX_JSON_BYTES || 20000);
const MAX_STRING_LENGTH = Number(process.env.PAYMENT_AUDIT_MAX_STRING_LENGTH || 1500);

const SENSITIVE_KEY_PATTERNS = [
  /password/i,
  /passcode/i,
  /\botp\b/i,
  /pin/i,
  /token/i,
  /secret/i,
  /api[-_]?key/i,
  /authorization/i,
  /cookie/i,
  /signature/i,
  /session/i,
  /csrf/i,
  /cvv/i,
  /cvc/i,
  /card/i,
  /expiry/i,
  /account[_-]?number/i,
  /bank[_-]?account[_-]?number/i,
];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+?\d[\d\s().-]{7,}\d$/;

function normalizeRoute(path: string): string {
  return path
    .split('/')
    .map((segment) => {
      if (!segment) return segment;
      if (/^\d+$/.test(segment)) return ':number';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i.test(segment)) return ':uuid';
      if (/^c[a-z0-9]{20,}$/i.test(segment)) return ':id';
      if (/^[A-Za-z0-9_-]{24,}$/.test(segment)) return ':id';
      return segment;
    })
    .join('/') || '/';
}

function getClientIp(req: Request) {
  const forwardedFor = req.get('x-forwarded-for');
  if (forwardedFor) return forwardedFor.split(',')[0]?.trim();
  return req.ip || req.socket.remoteAddress;
}

function isSensitiveKey(key: string) {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function maybeMaskString(value: string) {
  const trimmed = value.trim();
  if (EMAIL_PATTERN.test(trimmed)) return maskEmail(trimmed);
  if (PHONE_PATTERN.test(trimmed)) return maskPhone(trimmed);
  return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}... [truncated]` : value;
}

function sanitize(value: unknown, key = '', depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (isSensitiveKey(key)) return '[REDACTED]';
  if (depth > 8) return '[MAX_DEPTH]';

  if (typeof value === 'string') return maybeMaskString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `[BUFFER:${value.length}]`;

  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, key, depth + 1));
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .map(([entryKey, entryValue]) => [entryKey, sanitize(entryValue, entryKey, depth + 1)]),
    );
  }

  return String(value);
}

function fitForLog(value: unknown) {
  const sanitized = sanitize(value);
  const serialized = JSON.stringify(sanitized);
  if (typeof serialized !== 'string') return sanitized;
  if (serialized.length <= MAX_AUDIT_JSON_BYTES) return sanitized;

  return {
    truncated: true,
    originalBytes: Buffer.byteLength(serialized),
    preview: serialized.slice(0, MAX_AUDIT_JSON_BYTES),
  };
}

function shouldAuditPaymentRequest(req: Request) {
  const path = req.path;
  const method = req.method.toUpperCase();

  if (path.startsWith('/api/webhooks/paychangu') || path.startsWith('/api/webhooks/paystack')) return true;
  if (path.startsWith('/api/payments')) return true;
  if (path.startsWith('/api/payment-status')) return true;
  if (path.startsWith('/api/packages/payments')) return MONEY_METHODS.has(method);
  if (path.startsWith('/api/giving')) return MONEY_METHODS.has(method);
  if (path.startsWith('/api/wallet/withdraw')) return MONEY_METHODS.has(method);
  if (path.startsWith('/api/admin/treasury/withdraw')) return MONEY_METHODS.has(method);
  if (path.startsWith('/api/admin/treasury/withdrawals')) return MONEY_METHODS.has(method);
  if (path.startsWith('/api/events') && MONEY_METHODS.has(method) && /ticket|payment|book/i.test(path)) return true;

  return false;
}

function hasWebhookSignature(req: Request) {
  return Boolean(
    req.get('x-paystack-signature')
    || req.get('paychangu-signature')
    || req.get('x-paychangu-signature')
    || req.get('signature'),
  );
}

export function paymentAuditLogger(req: Request, res: Response, next: NextFunction) {
  if (!shouldAuditPaymentRequest(req)) return next();

  const startedAt = process.hrtime.bigint();
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);
  let responseBody: unknown;

  res.json = ((body?: unknown) => {
    responseBody = body;
    return originalJson(body);
  }) as Response['json'];

  res.send = ((body?: unknown) => {
    if (responseBody === undefined) responseBody = body;
    return originalSend(body);
  }) as Response['send'];

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const statusCode = res.statusCode;
    const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';
    const user = req.user;
    const isWebhook = req.path.startsWith('/api/webhooks/');

    logger[level]('payment_api_trace', {
      auditKind: isWebhook ? 'webhook' : 'money_api',
      requestId: req.requestId,
      method: req.method,
      route: normalizeRoute(req.path),
      path: req.path,
      originalUrl: req.originalUrl,
      statusCode,
      durationMs: Number(durationMs.toFixed(2)),
      ip: getClientIp(req),
      userAgent: req.get('user-agent'),
      userId: user?.userId,
      userName: user?.userName || displayName(user?.firstName, user?.lastName),
      email: maskEmail(user?.email),
      role: user?.role,
      churchId: user?.churchId,
      query: fitForLog(req.query),
      requestBody: fitForLog(req.body),
      responseBody: fitForLog(responseBody),
      rawBodyBytes: req.rawBody?.length,
      webhookSignaturePresent: isWebhook ? hasWebhookSignature(req) : undefined,
    });
  });

  next();
}
