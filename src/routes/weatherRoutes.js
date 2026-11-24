import { Router } from 'express';
import weatherController from '../controllers/weatherController.js';
import { requireRole } from '../middlewares/authMiddleware.js';

const router = Router();

router.get('/', weatherController.getCurrentWeather);
router.get('/location', weatherController.getLocation);
router.put('/location', requireRole('owner', 'admin', 'member'), weatherController.saveLocation);

export default router;
