import { Router } from 'express';
import { authenticate, authorizePermission } from '../middleware/auth';
import {
  getCells, getCell, createCell, updateCell, deleteCell,
  getCellMembers, addCellMember, updateCellMember, removeCellMember,
  getCellMeetings, createCellMeeting,
  getMeetingAttendance, submitMeetingAttendance,
  getCellStats, getCellFinanceStats,
  getCellDonations,
  getCellsOverviewStats,
  getCellsSimple,
  getCellChurchMembers,
} from '../controllers/cellController';

const router = Router();
router.use(authenticate);

// Cells CRUD
router.get('/overview-stats',     getCellsOverviewStats);  // must be before /:id
router.get('/simple',             getCellsSimple);          // lightweight dropdown list
router.get('/',                   getCells);
router.get('/:id',                getCell);
router.post('/',          authorizePermission('cells:create'), createCell);
router.put('/:id',        authorizePermission('cells:update'), updateCell);
router.delete('/:id',     authorizePermission('cells:delete'), deleteCell);

// Cell stats
router.get('/:id/stats',          getCellStats);
router.get('/:id/finance-stats',  getCellFinanceStats);

// Cell donations
router.get('/:id/donations',      getCellDonations);

// Members
router.get('/:id/members',                     getCellMembers);
router.get('/:id/church-members',              getCellChurchMembers);
router.post('/:id/members',                    authorizePermission('cells:update'), addCellMember);
router.put('/:id/members/:memberId',           authorizePermission('cells:update'), updateCellMember);
router.delete('/:id/members/:memberId',        authorizePermission('cells:update'), removeCellMember);

// Meetings
router.get('/:id/meetings',                    getCellMeetings);
router.post('/:id/meetings',                   authorizePermission('cells:update'), createCellMeeting);

// Attendance
router.get('/meetings/:meetingId/attendance',  getMeetingAttendance);
router.post('/meetings/:meetingId/attendance', authorizePermission('cells:update'), submitMeetingAttendance);

export default router;
