import authService from '../services/authService.js';
import {
  extractSessionToken,
  setSessionCookie,
  clearSessionCookie,
} from '../middlewares/authMiddleware.js';

function resolveBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

export async function me(req, res, next) {
  try {
    const token = extractSessionToken(req);
    const session = token ? await authService.getSessionByToken(token) : null;
    const hasUsers = await authService.hasAnyUsers();

    res.json({
      ok: true,
      authenticated: Boolean(session),
      hasUsers,
      data: session
        ? { user: session.user, account: session.account, role: session.role }
        : null,
    });
  } catch (err) {
    next(err);
  }
}

export async function register(req, res, next) {
  try {
    const { name, email, password, accountName, inviteToken } = req.body || {};
    const result = await authService.register({
      name,
      email,
      password,
      accountName,
      inviteToken,
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
    });

    setSessionCookie(req, res, result.token, result.expiresAt);
    res.status(201).json({
      ok: true,
      data: { user: result.user, account: result.account, role: result.role },
    });
  } catch (err) {
    next(err);
  }
}

export async function login(req, res, next) {
  try {
    const { email, password } = req.body || {};
    const result = await authService.login({
      email,
      password,
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
    });

    setSessionCookie(req, res, result.token, result.expiresAt);
    res.json({
      ok: true,
      data: { user: result.user, account: result.account, role: result.role },
    });
  } catch (err) {
    next(err);
  }
}

export async function logout(req, res, next) {
  try {
    const token = extractSessionToken(req);
    await authService.logout(token);
    clearSessionCookie(req, res);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

export async function forgotPassword(req, res, next) {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ ok: false, error: 'Ingresa tu correo electrónico' });
    const result = await authService.requestPasswordReset(email, resolveBaseUrl(req));
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    next(err);
  }
}

export async function resetPassword(req, res, next) {
  try {
    const { token, newPassword } = req.body || {};
    if (!token) return res.status(400).json({ ok: false, error: 'Token de recuperación faltante' });
    await authService.resetPassword({ token, newPassword });
    res.json({ ok: true, message: 'Contraseña actualizada correctamente. Ya puedes iniciar sesión.' });
  } catch (err) {
    next(err);
  }
}

export async function previewInvitation(req, res, next) {
  try {
    const inv = await authService.getInvitationPreview(req.params.token);
    if (!inv) {
      return res.status(404).json({ ok: false, error: 'La invitación no es válida o ya expiró' });
    }
    res.json({ ok: true, data: inv });
  } catch (err) {
    next(err);
  }
}

export default {
  me,
  register,
  login,
  logout,
  forgotPassword,
  resetPassword,
  previewInvitation,
};
