import { Router } from 'express';
import { kpiController } from '../controllers/kpiController';
import { authenticate } from '../middleware/auth';

const router = Router();

router.use(authenticate);

router.post('/', kpiController.create);
router.get('/', kpiController.getAll);
router.get('/calculate', kpiController.calculate);
router.get('/:id', kpiController.getById);
router.put('/:id', kpiController.update);
router.delete('/:id', kpiController.delete);

export default router;
