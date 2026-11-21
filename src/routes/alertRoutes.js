import { Router } from 'express';
import alertController from '../controllers/alertController.js';

const router = Router();

router.get('/config', alertController.getConfig);
router.put('/smtp', alertController.updateSmtp);
router.post('/recipients', alertController.addRecipient);
router.patch('/recipients/:id', alertController.updateRecipient);
router.delete('/recipients/:id', alertController.deleteRecipient);
router.post('/test', alertController.sendTest);
router.get('/logs', alertController.listLogs);

export default router;
