import { Router } from 'express';
import authController from '../controllers/authController.js';

const router = Router();

router.get('/me', authController.me);
router.post('/register', authController.register);
router.post('/login', authController.login);
router.post('/logout', authController.logout);
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);
router.get('/invite/:token', authController.previewInvitation);

export default router;
