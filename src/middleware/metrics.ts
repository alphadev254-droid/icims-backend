import { NextFunction, Request, Response } from 'express';
import client from 'prom-client';

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

register.registerMetric(httpRequestsTotal);
register.registerMetric(httpRequestDurationSeconds);
register.registerMetric(httpRequestsInFlight);

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
