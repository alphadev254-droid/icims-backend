import { Router } from 'express';
import {
  generateLink,
  generateAttendanceScannerLink,
  generateAttendanceEntryLink,
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
  getScannerAttendanceByLink,
  scanMemberByScannerLink,
  searchMembersByScannerLink,
  addMembersByScannerLink,
} from '../controllers/sharedAccessController';
import { authenticate } from '../middleware/auth';

// ─── Protected routes (require authentication) ─────────────────────────────

const protectedRouter = Router();
protectedRouter.use(authenticate);

protectedRouter.post('/generate', generateLink);
protectedRouter.post('/attendance/:attendanceId/scanner-link', generateAttendanceScannerLink);
protectedRouter.post('/attendance/:attendanceId/entry-link', generateAttendanceEntryLink);
protectedRouter.get('/my-links', getMyLinks);
protectedRouter.delete('/:id/revoke', revokeLink);
protectedRouter.delete('/:id/delete', deleteLink);
protectedRouter.patch('/:id/activate', activateLink);

// ─── Public routes (no auth required — token-based validation) ─────────────

const publicRouter = Router();

publicRouter.get('/validate/:token', validateLink);
publicRouter.post('/submit/:token', submitAttendance);
publicRouter.post('/:token/verify-code', verifyLinkCode);
publicRouter.get('/:token/scanner-attendance', getScannerAttendanceByLink);
publicRouter.post('/:token/scan-member', scanMemberByScannerLink);
publicRouter.get('/:token/member-search', searchMembersByScannerLink);
publicRouter.post('/:token/manual-members', addMembersByScannerLink);
publicRouter.get('/:token/attendance', getAttendanceByLink);
publicRouter.put('/:token/attendance/:id', updateAttendanceByLink);
publicRouter.get('/:token/attendance/:id/visitors', getVisitorsByLink);
publicRouter.post('/:token/attendance/:id/visitors', addVisitorByLink);
publicRouter.delete('/:token/attendance/:id/visitors/:visitorId', deleteVisitorByLink);

// ─── Export both routers ───────────────────────────────────────────────────

export { protectedRouter as sharedAccessProtectedRoutes, publicRouter as sharedAccessPublicRoutes };
