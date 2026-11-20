import { Router } from 'express';
import weatherController from '../controllers/weatherController.js';

const router = Router();

router.get('/', weatherController.getCurrentWeather);
router.get('/location', weatherController.getLocation);
router.put('/location', weatherController.saveLocation);

export default router;
