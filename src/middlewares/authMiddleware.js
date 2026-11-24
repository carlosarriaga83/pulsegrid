import authService from '../services/authService.js';

export const SESSION_COOKIE_NAME = 'pg_session';

export function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  for (const part of String(cookieHeader).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

export function extractSessionToken(req) {
  const cookies = parseCookies(req.headers?.cookie);
  if (cookies[SESSION_COOKIE_NAME]) return cookies[SESSION_COOKIE_NAME];

  const authHeader = req.headers?.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return null;
}

export function setSessionCookie(req, res, token, expiresAt) {
  const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: Boolean(isSecure),
    expires: expiresAt,
    path: '/',
  });
}

export function clearSessionCookie(req, res) {
  const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure: Boolean(isSecure),
    path: '/',
  });
}

export async function requireAuth(req, res, next) {
  try {
    const token = extractSessionToken(req);
    if (!token) {
      return res.status(401).json({ ok: false, error: 'Debes iniciar sesión para continuar' });
    }
    const session = await authService.getSessionByToken(token);
    if (!session) {
      return res.status(401).json({ ok: false, error: 'Tu sesión expiró. Inicia sesión nuevamente.' });
    }
    req.user = session.user;
    req.account = session.account;
    req.role = session.role;
    req.sessionToken = token;
    next();
  } catch (err) {
    next(err);
  }
}

export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.role || !allowedRoles.includes(req.role)) {
      return res.status(403).json({
        ok: false,
        error: 'No tienes permisos suficientes para realizar esta acción',
      });
    }
    next();
  };
}

export default {
  SESSION_COOKIE_NAME,
  parseCookies,
  extractSessionToken,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  requireRole,
};
