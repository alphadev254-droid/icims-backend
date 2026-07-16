import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { logger, maskEmail } from '../utils/logger';

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

function normalizeRoute(path: string): string {
  return path
    .split('/')
    .map((segment) => {
      if (!segment) return segment;
      if (/^\d+$/.test(segment)) return ':number';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(segment)) return ':uuid';
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

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const incomingRequestId = req.get('x-request-id') || req.get('x-correlation-id');
  const requestId = incomingRequestId?.trim() || randomUUID();
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);

  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    if (req.path === '/metrics') return;

    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const statusCode = res.statusCode;
    const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';
    const user = req.user;

    logger[level]('http_request', {
      requestId,
      method: req.method,
      route: normalizeRoute(req.path),
      path: req.path,
      statusCode,
      durationMs: Number(durationMs.toFixed(2)),
      ip: getClientIp(req),
      userAgent: req.get('user-agent'),
      userId: user?.userId,
      email: maskEmail(user?.email),
      role: user?.role,
      churchId: user?.churchId,
      accountCountry: user?.accountCountry,
      contentLength: res.getHeader('content-length'),
    });
  });

  next();
}
