import { Request, Response, NextFunction } from 'express';
import { logger, maskEmail } from '../utils/logger';

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  logger.error('unhandled_error', {
    requestId: _req.requestId,
    method: _req.method,
    path: _req.path,
    originalUrl: _req.originalUrl,
    userId: _req.user?.userId,
    email: maskEmail(_req.user?.email),
    role: _req.user?.role,
    churchId: _req.user?.churchId,
    errorName: err.name,
    errorMessage: err.message,
    errorStack: err.stack,
  });
  res.status(500).json({ success: false, message: err.message || 'Internal server error' });
}
