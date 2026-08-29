import { Router } from 'express';
import { getEvents, getEvent, getEventSelect, createEvent, updateEvent, deleteEvent, bookTicket, getMyTickets, getEventTickets, createManualTicket, getUnallocatedTransactions, getTicketTransaction, markAttendance, downloadTicket, cancelTicket, getPublicEvent } from '../controllers/eventController';
import { authenticate, authorizeAnyPermission, authorizePermission } from '../middleware/auth';
import { requireFeature } from '../middleware/packageCheck';

const router = Router();

// Public route (no auth required)
router.get('/:id/public', getPublicEvent);

router.use(authenticate);

// Specific routes first (before /:id)
router.get('/my-tickets', requireFeature('event_member_booking'), authorizePermission('tickets:read'), getMyTickets);
router.post('/book-ticket', requireFeature('event_member_booking'), bookTicket);
router.get('/tickets/:ticketId/transaction', requireFeature('event_ticketing'), authorizePermission('tickets:read'), getTicketTransaction);
router.get('/tickets/:ticketId/download', requireFeature('event_ticketing'), authorizePermission('tickets:read'), downloadTicket);
router.delete('/tickets/:ticketId', requireFeature('event_ticketing'), authorizePermission('tickets:create'), cancelTicket);
router.get('/select', authorizeAnyPermission([
  'events:read',
  'events:create',
  'events:update',
  'attendance:read',
  'attendance:create',
  'attendance:update',
  'tickets:read',
  'tickets:create',
  'transactions:read',
  'reports:read',
]), getEventSelect);

// General CRUD routes
router.get('/',       requireFeature('events_management'), authorizePermission('events:read'),   getEvents);
router.get('/:id',    requireFeature('events_management'), authorizePermission('events:read'),   getEvent);
router.post('/',      requireFeature('events_management'), authorizePermission('events:create'), createEvent);
router.put('/:id',    requireFeature('events_management'), authorizePermission('events:update'), updateEvent);
router.delete('/:id', requireFeature('events_management'), authorizePermission('events:delete'), deleteEvent);

// Event-specific ticket routes
router.post('/:id/manual-ticket', requireFeature('event_manual_payments'), authorizePermission('tickets:create'), createManualTicket);
router.get('/:id/unallocated-transactions', requireFeature('event_manual_payments'), authorizePermission('tickets:read'), getUnallocatedTransactions);
router.get('/:id/tickets', requireFeature('event_reports'), authorizePermission('tickets:read'), getEventTickets);
router.patch('/tickets/:ticketId/attendance', requireFeature('event_attendance'), authorizePermission('attendance:create'), markAttendance);

export default router;
