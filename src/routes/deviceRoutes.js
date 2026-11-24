import { Router } from 'express';
import deviceController from '../controllers/deviceController.js';
import { requireRole } from '../middlewares/authMiddleware.js';

const router = Router();
const canControl = requireRole('owner', 'admin', 'member');

router.get('/', deviceController.listDevices);
router.post('/sync', canControl, deviceController.syncDevices);
router.post('/demo', canControl, deviceController.seedDemo);
router.delete('/demo', canControl, deviceController.clearDemo);
router.get('/:id', deviceController.getDevice);
router.post('/:id/commands', canControl, deviceController.sendCommands);
router.patch('/:id', canControl, deviceController.updateDevice);

export default router;
