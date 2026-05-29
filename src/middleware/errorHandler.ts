import { Request, Response, NextFunction } from 'express';

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  console.error('[Error]', err.message);
  console.log(`[GLOBAL-ERROR-HANDLER] URL: ${_req.originalUrl}`);
  console.log(`[GLOBAL-ERROR-HANDLER] Error:`, err.message);
  console.log(`[GLOBAL-ERROR-HANDLER] Stack:`, err.stack);
  res.status(500).json({ success: false, message: err.message || 'Internal server error' });
}
