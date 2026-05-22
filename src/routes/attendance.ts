import { Router } from 'express';
import { getAttendance, createAttendance, updateAttendance, deleteAttendance, getAttendanceVisitors, addAttendanceVisitor, deleteAttendanceVisitor, getServiceVisitorsReport } from '../controllers/attendanceController';
import { authenticate, authorizePermission } from '../middleware/auth';

const router = Router();
router.use(authenticate);

router.get('/',       authorizePermission('attendance:read'),   getAttendance);
router.post('/',      authorizePermission('attendance:create'), createAttendance);
router.put('/:id',    authorizePermission('attendance:update'), updateAttendance);
router.get('/visitors',                    authorizePermission('attendance:read'),   getServiceVisitorsReport);
router.get('/:id/visitors',                authorizePermission('attendance:read'),   getAttendanceVisitors);
router.post('/:id/visitors',               authorizePermission('attendance:update'), addAttendanceVisitor);
router.delete('/:id/visitors/:visitorId',  authorizePermission('attendance:update'), deleteAttendanceVisitor);
router.delete('/:id',                      authorizePermission('attendance:update'), deleteAttendance);

export default router;
