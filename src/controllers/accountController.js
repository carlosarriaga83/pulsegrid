import authService from '../services/authService.js';

function resolveBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

export async function getOverview(req, res, next) {
  try {
    const members = await authService.listAccountMembers(req.account.id);
    const invitations =
      req.role === 'owner' || req.role === 'admin'
        ? await authService.listInvitations(req.account.id)
        : [];

    res.json({
      ok: true,
      data: {
        user: req.user,
        account: req.account,
        role: req.role,
        members,
        invitations,
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function updateProfile(req, res, next) {
  try {
    const user = await authService.updateProfile(req.user.id, req.body || {});
    res.json({ ok: true, data: user });
  } catch (err) {
    next(err);
  }
}

export async function changePassword(req, res, next) {
  try {
    await authService.changePassword(req.user.id, req.body || {});
    res.json({ ok: true, message: 'Contraseña actualizada correctamente' });
  } catch (err) {
    next(err);
  }
}

export async function updateAccount(req, res, next) {
  try {
    const account = await authService.updateAccountName(req.account.id, req.body?.name);
    res.json({ ok: true, data: account });
  } catch (err) {
    next(err);
  }
}

export async function inviteUser(req, res, next) {
  try {
    const { email, role } = req.body || {};
    const result = await authService.createInvitation({
      accountId: req.account.id,
      invitedByUserId: req.user.id,
      inviterName: req.user.name,
      accountName: req.account.name,
      email,
      role,
      baseUrl: resolveBaseUrl(req),
    });
    const members = await authService.listAccountMembers(req.account.id);
    const invitations = await authService.listInvitations(req.account.id);
    res.status(201).json({ ok: true, data: { ...result, members, invitations } });
  } catch (err) {
    next(err);
  }
}

export async function revokeInvitation(req, res, next) {
  try {
    await authService.revokeInvitation(req.account.id, req.params.id);
    const invitations = await authService.listInvitations(req.account.id);
    res.json({ ok: true, data: invitations });
  } catch (err) {
    next(err);
  }
}

export async function updateMemberRole(req, res, next) {
  try {
    const members = await authService.updateMemberRole(
      req.account.id,
      Number(req.params.userId),
      req.body?.role
    );
    res.json({ ok: true, data: members });
  } catch (err) {
    next(err);
  }
}

export async function removeMember(req, res, next) {
  try {
    const members = await authService.removeMember(req.account.id, Number(req.params.userId));
    res.json({ ok: true, data: members });
  } catch (err) {
    next(err);
  }
}

export default {
  getOverview,
  updateProfile,
  changePassword,
  updateAccount,
  inviteUser,
  revokeInvitation,
  updateMemberRole,
  removeMember,
};
