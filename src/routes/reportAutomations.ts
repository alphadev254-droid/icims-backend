import { NextFunction, Request, Response, Router } from 'express';
import { reportAutomationController } from '../controllers/reportAutomationController';
import { authenticate, authorizePermission } from '../middleware/auth';
import { requireFeature } from '../middleware/packageCheck';

const router = Router();
const asyncRoute = (handler: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { void handler(req, res).catch(next); };
router.use(authenticate, requireFeature('reports_analytics'));
router.get('/definitions', authorizePermission('reports:read'), asyncRoute(reportAutomationController.definitions));
router.get('/recipients', authorizePermission('reports:read'), asyncRoute(reportAutomationController.recipients));
router.get('/', authorizePermission('reports:read'), asyncRoute(reportAutomationController.list));
router.get('/:id/runs', authorizePermission('reports:read'), asyncRoute(reportAutomationController.runs));
router.post('/', authorizePermission('reports:create'), asyncRoute(reportAutomationController.create));
router.put('/:id', authorizePermission('reports:update'), asyncRoute(reportAutomationController.update));
router.delete('/:id', authorizePermission('reports:delete'), asyncRoute(reportAutomationController.remove));
export default router;
