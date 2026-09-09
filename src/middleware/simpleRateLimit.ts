import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

type RateLimitOptions = {
  windowMs: number;
  max: number;
  keyPrefix: string;
};

type Bucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, Bucket>();

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets.entries()) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, 60_000).unref();

export function simpleRateLimit(options: RateLimitOptions) {
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const identity = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${options.keyPrefix}:${identity}`;
    const current = buckets.get(key);
    const bucket = current && current.resetAt > now
      ? current
      : { count: 0, resetAt: now + options.windowMs };

    bucket.count += 1;
    buckets.set(key, bucket);

    if (bucket.count <= options.max) {
      next();
      return;
    }

    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    logger.warn('rate_limit_exceeded', {
      auditKind: 'security',
      route: req.originalUrl,
      keyPrefix: options.keyPrefix,
      ip: identity,
      max: options.max,
      windowMs: options.windowMs,
      retryAfterSeconds,
    });
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(429).json({ success: false, message: 'Too many requests. Please try again shortly.' });
  };
}
