import { Router } from 'express';
import { authenticate, authorizeAnyPermission, authorizePermission } from '../middleware/auth';
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
  getCellVisitors,
} from '../controllers/cellController';

const router = Router();
router.use(authenticate);

const cellSelectorPermissions = [
  'cells:read',
  'cells:create',
  'cells:update',
  'attendance:read',
  'attendance:create',
  'attendance:update',
  'donations:read',
  'transactions:read',
  'reports:read',
];

router.get('/overview-stats', authorizePermission('cells:read'), getCellsOverviewStats);
router.get('/select', authorizeAnyPermission(cellSelectorPermissions), getCellsSimple);
router.get('/simple', authorizeAnyPermission(cellSelectorPermissions), getCellsSimple);
router.get('/visitors', authorizePermission('cells:read'), getCellVisitors);
router.get('/', authorizePermission('cells:read'), getCells);
router.get('/:id', authorizePermission('cells:read'), getCell);
router.post('/', authorizePermission('cells:create'), createCell);
router.put('/:id', authorizePermission('cells:update'), updateCell);
router.delete('/:id', authorizePermission('cells:delete'), deleteCell);

router.get('/:id/stats', authorizePermission('cells:read'), getCellStats);
router.get('/:id/finance-stats', authorizePermission('cells:read'), getCellFinanceStats);
router.get('/:id/donations', authorizeAnyPermission(['cells:read', 'donations:read', 'transactions:read']), getCellDonations);

router.get('/:id/members', authorizePermission('cells:read'), getCellMembers);
router.get('/:id/church-members', authorizeAnyPermission(['cells:read', 'cells:update']), getCellChurchMembers);
router.post('/:id/members', authorizePermission('cells:update'), addCellMember);
router.put('/:id/members/:memberId', authorizePermission('cells:update'), updateCellMember);
router.delete('/:id/members/:memberId', authorizePermission('cells:update'), removeCellMember);

router.get('/:id/meetings', authorizePermission('cells:read'), getCellMeetings);
router.post('/:id/meetings', authorizePermission('cells:update'), createCellMeeting);

router.get('/meetings/:meetingId/attendance', authorizeAnyPermission(['cells:read', 'cells:update']), getMeetingAttendance);
router.post('/meetings/:meetingId/attendance', authorizePermission('cells:update'), submitMeetingAttendance);

export default router;
