import { Router } from 'express';
import {
  getAttendance,
  createAttendance,
  updateAttendance,
  deleteAttendance,
  getAttendanceVisitors,
  addAttendanceVisitor,
  deleteAttendanceVisitor,
  getServiceVisitorsReport,
  getAttendanceParticipants,
  updateAttendanceQrSettings,
  activateAttendanceQr,
  closeAttendanceQr,
  regenerateAttendanceQr,
  getQrCheckInSession,
  checkInMemberByQr,
  checkInGuestByQr,
} from '../controllers/attendanceController';
import { authenticate, authenticateOptional, authorizePermission } from '../middleware/auth';

const router = Router();

router.get('/check-in/:token', getQrCheckInSession);
router.post('/check-in/:token/member', authenticateOptional, checkInMemberByQr);
router.post('/check-in/:token/guest', checkInGuestByQr);

router.use(authenticate);

router.get('/',       authorizePermission('attendance:read'),   getAttendance);
router.post('/',      authorizePermission('attendance:create'), createAttendance);
router.put('/:id',    authorizePermission('attendance:update'), updateAttendance);
router.get('/visitors',                    authorizePermission('attendance:read'),   getServiceVisitorsReport);
router.get('/:id/visitors',                authorizePermission('attendance:read'),   getAttendanceVisitors);
router.post('/:id/visitors',               authorizePermission('attendance:update'), addAttendanceVisitor);
router.delete('/:id/visitors/:visitorId',  authorizePermission('attendance:update'), deleteAttendanceVisitor);
router.get('/:id/participants',            authorizePermission('attendance:read'),   getAttendanceParticipants);
router.put('/:id/qr',                      authorizePermission('attendance:update'), updateAttendanceQrSettings);
router.post('/:id/qr/activate',            authorizePermission('attendance:update'), activateAttendanceQr);
router.post('/:id/qr/close',               authorizePermission('attendance:update'), closeAttendanceQr);
router.post('/:id/qr/regenerate',          authorizePermission('attendance:update'), regenerateAttendanceQr);
router.delete('/:id',                      authorizePermission('attendance:update'), deleteAttendance);

export default router;
