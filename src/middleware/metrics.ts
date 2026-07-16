import { NextFunction, Request, Response } from 'express';
import client from 'prom-client';
import { logger } from '../utils/logger';

const register = new client.Registry();

client.collectDefaultMetrics({
  register,
  prefix: 'icims_backend_',
});

const httpRequestsTotal = new client.Counter({
  name: 'icims_backend_http_requests_total',
  help: 'Total HTTP requests handled by ICIMS backend',
  labelNames: ['method', 'route', 'status_code'] as const,
});

const httpRequestDurationSeconds = new client.Histogram({
  name: 'icims_backend_http_request_duration_seconds',
  help: 'HTTP request duration in seconds for ICIMS backend',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

const httpRequestsInFlight = new client.Gauge({
  name: 'icims_backend_http_requests_in_flight',
  help: 'Current in-flight HTTP requests for ICIMS backend',
  labelNames: ['method', 'route'] as const,
});

const authLoginAttemptsTotal = new client.Counter({
  name: 'icims_backend_auth_login_attempts_total',
  help: 'Total ICIMS login attempts by result',
  labelNames: ['status', 'reason'] as const,
});

const paymentEventsTotal = new client.Counter({
  name: 'icims_backend_payment_events_total',
  help: 'Total ICIMS payment lifecycle events',
  labelNames: ['gateway', 'type', 'status'] as const,
});

const withdrawalEventsTotal = new client.Counter({
  name: 'icims_backend_withdrawal_events_total',
  help: 'Total ICIMS withdrawal lifecycle events',
  labelNames: ['method', 'status', 'scope'] as const,
});

register.registerMetric(httpRequestsTotal);
register.registerMetric(httpRequestDurationSeconds);
register.registerMetric(httpRequestsInFlight);
register.registerMetric(authLoginAttemptsTotal);
register.registerMetric(paymentEventsTotal);
register.registerMetric(withdrawalEventsTotal);

type LifecycleLogMeta = Record<string, unknown>;

export function recordLoginAttempt(status: 'success' | 'failed', reason = 'none', meta: LifecycleLogMeta = {}) {
  authLoginAttemptsTotal.inc({ status, reason });
  logger[status === 'success' ? 'info' : 'warn']('auth_login_attempt', {
    status,
    reason,
    ...meta,
  });
}

export function recordPaymentEvent(gateway: string | null | undefined, type: string | null | undefined, status: 'initialized' | 'completed' | 'failed', meta: LifecycleLogMeta = {}) {
  paymentEventsTotal.inc({
    gateway: gateway || 'unknown',
    type: type || 'unknown',
    status,
  });
  logger[status === 'failed' ? 'error' : 'info']('payment_event', {
    gateway: gateway || 'unknown',
    type: type || 'unknown',
    status,
    ...meta,
  });
}

export function recordWithdrawalEvent(method: string | null | undefined, status: 'requested' | 'processing' | 'completed' | 'failed', scope = 'ministry', meta: LifecycleLogMeta = {}) {
  withdrawalEventsTotal.inc({
    method: method || 'unknown',
    status,
    scope,
  });
  logger[status === 'failed' ? 'error' : 'info']('withdrawal_event', {
    method: method || 'unknown',
    status,
    scope,
    ...meta,
  });
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

export function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
  if (req.path === '/metrics') return next();

  const method = req.method;
  const route = normalizeRoute(req.path);
  const endTimer = httpRequestDurationSeconds.startTimer({ method, route });

  httpRequestsInFlight.inc({ method, route });

  res.on('finish', () => {
    const statusCode = String(res.statusCode);
    httpRequestsInFlight.dec({ method, route });
    httpRequestsTotal.inc({ method, route, status_code: statusCode });
    endTimer({ status_code: statusCode });
  });

  next();
}

function getBearerToken(req: Request): string | null {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || req.get('x-metrics-token') || null;
}

export async function metricsHandler(req: Request, res: Response) {
  const expectedToken = process.env.METRICS_TOKEN;
  if (!expectedToken) {
    res.status(404).json({ success: false, message: 'Route not found' });
    return;
  }

  if (getBearerToken(req) !== expectedToken) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return;
  }

  res.setHeader('Content-Type', register.contentType);
  res.send(await register.metrics());
}
