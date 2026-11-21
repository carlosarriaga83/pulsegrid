import { Router } from 'express';
import systemController from '../controllers/systemController.js';
import deviceRoutes from './deviceRoutes.js';
import weatherRoutes from './weatherRoutes.js';
import automationRoutes from './automationRoutes.js';
import telemetryRoutes from './telemetryRoutes.js';
import alertRoutes from './alertRoutes.js';

const router = Router();

router.get('/health', systemController.getHealth);
router.use('/devices', deviceRoutes);
router.use('/weather', weatherRoutes);
router.use('/automations', automationRoutes);
router.use('/telemetry', telemetryRoutes);
router.use('/alerts', alertRoutes);

export default router;
