import { Router } from 'express';
import systemController from '../controllers/systemController.js';
import authRoutes from './authRoutes.js';
import accountRoutes from './accountRoutes.js';
import deviceRoutes from './deviceRoutes.js';
import weatherRoutes from './weatherRoutes.js';
import automationRoutes from './automationRoutes.js';
import telemetryRoutes from './telemetryRoutes.js';
import alertRoutes from './alertRoutes.js';
import { requireAuth } from '../middlewares/authMiddleware.js';

const router = Router();

// Rutas públicas
router.get('/health', systemController.getHealth);
router.use('/auth', authRoutes);

// Rutas protegidas por sesión
router.use('/account', accountRoutes);
router.use('/devices', requireAuth, deviceRoutes);
router.use('/weather', requireAuth, weatherRoutes);
router.use('/automations', requireAuth, automationRoutes);
router.use('/telemetry', requireAuth, telemetryRoutes);
router.use('/alerts', requireAuth, alertRoutes);

export default router;
