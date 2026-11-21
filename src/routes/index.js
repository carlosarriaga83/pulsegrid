import { Router } from 'express';
import systemController from '../controllers/systemController.js';
import deviceRoutes from './deviceRoutes.js';
import weatherRoutes from './weatherRoutes.js';
import automationRoutes from './automationRoutes.js';

const router = Router();

router.get('/health', systemController.getHealth);
router.use('/devices', deviceRoutes);
router.use('/weather', weatherRoutes);
router.use('/automations', automationRoutes);

export default router;
