import { Router } from 'express';
import automationController from '../controllers/automationController.js';

const router = Router();

router.get('/', automationController.list);
router.post('/', automationController.create);
router.post('/evaluate-all', automationController.evaluateAll);
router.get('/:id', automationController.getOne);
router.put('/:id', automationController.update);
router.patch('/:id/toggle', automationController.toggle);
router.delete('/:id', automationController.remove);
router.post('/:id/evaluate', automationController.evaluateOne);
router.get('/:id/logs', automationController.logs);

export default router;
