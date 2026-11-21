import { Router } from 'express';
import telemetryController from '../controllers/telemetryController.js';

const router = Router();

router.get('/series', telemetryController.listSeries);
router.get('/history', telemetryController.getHistory);
router.post('/capture', telemetryController.captureNow);
router.post('/seed-demo', telemetryController.seedDemo);

export default router;
