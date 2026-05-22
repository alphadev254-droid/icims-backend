import { Router } from 'express';
import {
  generateLink,
  getMyLinks,
  revokeLink,
  deleteLink,
  activateLink,
  validateLink,
  submitAttendance,
  getAttendanceByLink,
  updateAttendanceByLink,
  getVisitorsByLink,
  addVisitorByLink,
  deleteVisitorByLink,
  verifyLinkCode,
} from '../controllers/sharedAccessController';
import { authenticate } from '../middleware/auth';

// ─── Protected routes (require authentication) ─────────────────────────────

const protectedRouter = Router();
protectedRouter.use(authenticate);

protectedRouter.post('/generate', generateLink);
protectedRouter.get('/my-links', getMyLinks);
protectedRouter.delete('/:id/revoke', revokeLink);
protectedRouter.delete('/:id/delete', deleteLink);
protectedRouter.patch('/:id/activate', activateLink);

// ─── Public routes (no auth required — token-based validation) ─────────────

const publicRouter = Router();

publicRouter.get('/validate/:token', validateLink);
publicRouter.post('/submit/:token', submitAttendance);
publicRouter.post('/:token/verify-code', verifyLinkCode);
publicRouter.get('/:token/attendance', getAttendanceByLink);
publicRouter.put('/:token/attendance/:id', updateAttendanceByLink);
publicRouter.get('/:token/attendance/:id/visitors', getVisitorsByLink);
publicRouter.post('/:token/attendance/:id/visitors', addVisitorByLink);
publicRouter.delete('/:token/attendance/:id/visitors/:visitorId', deleteVisitorByLink);

// ─── Export both routers ───────────────────────────────────────────────────

export { protectedRouter as sharedAccessProtectedRoutes, publicRouter as sharedAccessPublicRoutes };
