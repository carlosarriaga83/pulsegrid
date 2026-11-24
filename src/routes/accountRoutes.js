import { Router } from 'express';
import accountController from '../controllers/accountController.js';
import { requireAuth, requireRole } from '../middlewares/authMiddleware.js';

const router = Router();

router.use(requireAuth);

router.get('/', accountController.getOverview);
router.put('/profile', accountController.updateProfile);
router.put('/password', accountController.changePassword);
router.put('/details', requireRole('owner', 'admin'), accountController.updateAccount);
router.post('/invitations', requireRole('owner', 'admin'), accountController.inviteUser);
router.delete('/invitations/:id', requireRole('owner', 'admin'), accountController.revokeInvitation);
router.patch('/members/:userId', requireRole('owner', 'admin'), accountController.updateMemberRole);
router.delete('/members/:userId', requireRole('owner', 'admin'), accountController.removeMember);

export default router;
