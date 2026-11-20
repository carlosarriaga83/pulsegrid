import { Router } from 'express';
import systemController from '../controllers/systemController.js';
import deviceRoutes from './deviceRoutes.js';
import weatherRoutes from './weatherRoutes.js';

const router = Router();

router.get('/health', systemController.getHealth);
router.use('/devices', deviceRoutes);
router.use('/weather', weatherRoutes);

export default router;
