import { Router } from 'express';
import automationController from '../controllers/automationController.js';
import { requireRole } from '../middlewares/authMiddleware.js';

const router = Router();
const canEdit = requireRole('owner', 'admin', 'member');

router.get('/', automationController.list);
router.post('/', canEdit, automationController.create);
router.post('/evaluate-all', canEdit, automationController.evaluateAll);
router.get('/:id', automationController.getOne);
router.put('/:id', canEdit, automationController.update);
router.patch('/:id/toggle', canEdit, automationController.toggle);
router.delete('/:id', canEdit, automationController.remove);
router.post('/:id/evaluate', canEdit, automationController.evaluateOne);
router.get('/:id/logs', automationController.logs);

export default router;
