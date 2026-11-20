import { Router } from 'express';
import deviceController from '../controllers/deviceController.js';

const router = Router();

router.get('/', deviceController.listDevices);
router.post('/sync', deviceController.syncDevices);
router.get('/:id', deviceController.getDevice);
router.post('/:id/commands', deviceController.sendCommands);
router.patch('/:id', deviceController.updateDevice);

export default router;
