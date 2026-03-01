import { Router } from 'express';
import { getEvents, getEvent, createEvent, updateEvent, deleteEvent } from '../controllers/eventController';
import { authenticate, authorizePermission } from '../middleware/auth';

const router = Router();

router.use(authenticate);

router.get('/',       authorizePermission('events:read'),   getEvents);
router.get('/:id',    authorizePermission('events:read'),   getEvent);
router.post('/',      authorizePermission('events:create'), createEvent);
router.put('/:id',    authorizePermission('events:update'), updateEvent);
router.delete('/:id', authorizePermission('events:delete'), deleteEvent);

export default router;
