import { Router } from 'express';
import alertController from '../controllers/alertController.js';
import { requireRole } from '../middlewares/authMiddleware.js';

const router = Router();
const canManage = requireRole('owner', 'admin');

router.get('/config', alertController.getConfig);
router.put('/smtp', canManage, alertController.updateSmtp);
router.post('/recipients', canManage, alertController.addRecipient);
router.patch('/recipients/:id', canManage, alertController.updateRecipient);
router.delete('/recipients/:id', canManage, alertController.deleteRecipient);
router.post('/test', canManage, alertController.sendTest);
router.get('/logs', alertController.listLogs);

export default router;
