import { Router } from 'express';
import { getDonations, getDonation, createDonation, updateDonation, deleteDonation } from '../controllers/givingController';
import { authenticate, authorizePermission } from '../middleware/auth';

const router = Router();

router.use(authenticate);

router.get('/',       authorizePermission('giving:read'),   getDonations);
router.get('/:id',    authorizePermission('giving:read'),   getDonation);
router.post('/',      authorizePermission('giving:create'), createDonation);
router.put('/:id',    authorizePermission('giving:update'), updateDonation);
router.delete('/:id', authorizePermission('giving:delete'), deleteDonation);

export default router;
