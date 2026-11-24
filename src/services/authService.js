import crypto from 'node:crypto';
import { query, pool } from '../config/db.js';
import emailService from './emailService.js';

const SESSION_TTL_DAYS = 14;
const RESET_TTL_MINUTES = 60;
const INVITE_TTL_DAYS = 7;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password, storedHash) {
  if (!storedHash || !String(storedHash).startsWith('scrypt$')) return false;
  const [, salt, keyHex] = String(storedHash).split('$');
  if (!salt || !keyHex) return false;
  const derived = crypto.scryptSync(String(password), salt, 64);
  const storedBuf = Buffer.from(keyHex, 'hex');
  if (derived.length !== storedBuf.length) return false;
  return crypto.timingSafeEqual(derived, storedBuf);
}

function generateToken() {
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

function sha256(raw) {
  return crypto.createHash('sha256').update(String(raw || '')).digest('hex');
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function validatePassword(password) {
  const pwd = String(password || '');
  if (pwd.length < 8) {
    const err = new Error('La contraseña debe tener al menos 8 caracteres');
    err.statusCode = 400;
    throw err;
  }
  return pwd;
}

async function createSession({ userId, accountId, userAgent = '', ipAddress = '' }) {
  const { raw, hash } = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  await query(
    `INSERT INTO user_sessions (user_id, account_id, token_hash, user_agent, ip_address, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, accountId, hash, String(userAgent || '').slice(0, 255), String(ipAddress || '').slice(0, 64), expiresAt]
  );

  return { token: raw, expiresAt };
}

/**
 * Registra un nuevo usuario. Si trae inviteToken válido, se une a esa cuenta con el rol asignado;
 * de lo contrario crea una cuenta propia como 'owner'.
 */
export async function register({ name, email, password, accountName = '', inviteToken = '', userAgent = '', ipAddress = '' }) {
  const cleanName = String(name || '').trim();
  const cleanEmail = normalizeEmail(email);
  if (!cleanName || cleanName.length < 2) {
    const err = new Error('Ingresa tu nombre completo');
    err.statusCode = 400;
    throw err;
  }
  if (!cleanEmail || !cleanEmail.includes('@')) {
    const err = new Error('Ingresa un correo electrónico válido');
    err.statusCode = 400;
    throw err;
  }
  validatePassword(password);

  const existing = await query('SELECT id FROM users WHERE email = ? LIMIT 1', [cleanEmail]);
  if (existing.length > 0) {
    const err = new Error('Ya existe una cuenta registrada con este correo electrónico');
    err.statusCode = 409;
    throw err;
  }

  let invitation = null;
  if (inviteToken) {
    const invRows = await query(
      `SELECT * FROM account_invitations
       WHERE token_hash = ? AND status = 'pending' AND expires_at > UTC_TIMESTAMP()
       LIMIT 1`,
      [sha256(inviteToken)]
    );
    if (invRows.length === 0) {
      const err = new Error('La invitación no es válida o ya expiró');
      err.statusCode = 400;
      throw err;
    }
    invitation = invRows[0];
    if (normalizeEmail(invitation.email) !== cleanEmail) {
      const err = new Error(`Esta invitación corresponde al correo ${invitation.email}`);
      err.statusCode = 400;
      throw err;
    }
  }

  const passwordHash = hashPassword(password);
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const [userRes] = await conn.execute(
      `INSERT INTO users (email, name, password_hash, is_active, last_login_at)
       VALUES (?, ?, ?, 1, UTC_TIMESTAMP())`,
      [cleanEmail, cleanName, passwordHash]
    );
    const userId = userRes.insertId;

    let accountId;
    let role;

    if (invitation) {
      accountId = invitation.account_id;
      role = invitation.role;

      await conn.execute(
        'INSERT INTO account_members (account_id, user_id, role) VALUES (?, ?, ?)',
        [accountId, userId, role]
      );
      await conn.execute(
        `UPDATE account_invitations SET status = 'accepted', accepted_at = UTC_TIMESTAMP() WHERE id = ?`,
        [invitation.id]
      );
    } else {
      const finalAccountName = String(accountName || '').trim() || `Cuenta de ${cleanName}`;
      const [accRes] = await conn.execute(
        'INSERT INTO accounts (name, owner_user_id) VALUES (?, ?)',
        [finalAccountName, userId]
      );
      accountId = accRes.insertId;
      role = 'owner';

      await conn.execute(
        'INSERT INTO account_members (account_id, user_id, role) VALUES (?, ?, ?)',
        [accountId, userId, role]
      );
    }

    await conn.commit();

    const session = await createSession({ userId, accountId, userAgent, ipAddress });
    const full = await getSessionByToken(session.token);
    return { ...full, token: session.token, expiresAt: session.expiresAt };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function login({ email, password, userAgent = '', ipAddress = '' }) {
  const cleanEmail = normalizeEmail(email);
  const rows = await query('SELECT * FROM users WHERE email = ? LIMIT 1', [cleanEmail]);
  if (rows.length === 0) {
    const err = new Error('Correo o contraseña incorrectos');
    err.statusCode = 401;
    throw err;
  }

  const user = rows[0];
  if (!user.is_active) {
    const err = new Error('Esta cuenta de usuario está desactivada');
    err.statusCode = 403;
    throw err;
  }

  if (!verifyPassword(password, user.password_hash)) {
    const err = new Error('Correo o contraseña incorrectos');
    err.statusCode = 401;
    throw err;
  }

  const memberships = await query(
    'SELECT account_id, role FROM account_members WHERE user_id = ? ORDER BY FIELD(role, "owner", "admin", "member", "viewer") ASC LIMIT 1',
    [user.id]
  );
  if (memberships.length === 0) {
    const err = new Error('El usuario no pertenece a ninguna cuenta activa');
    err.statusCode = 403;
    throw err;
  }

  await query('UPDATE users SET last_login_at = UTC_TIMESTAMP() WHERE id = ?', [user.id]);
  const session = await createSession({
    userId: user.id,
    accountId: memberships[0].account_id,
    userAgent,
    ipAddress,
  });

  const full = await getSessionByToken(session.token);
  return { ...full, token: session.token, expiresAt: session.expiresAt };
}

export async function getSessionByToken(rawToken) {
  if (!rawToken) return null;
  const rows = await query(
    `SELECT
       s.id AS session_id,
       s.account_id,
       s.expires_at,
       u.id AS user_id,
       u.email,
       u.name AS user_name,
       u.last_login_at,
       u.created_at AS user_created_at,
       a.name AS account_name,
       a.owner_user_id,
       m.role
     FROM user_sessions s
     INNER JOIN users u ON u.id = s.user_id
     INNER JOIN accounts a ON a.id = s.account_id
     INNER JOIN account_members m ON m.account_id = s.account_id AND m.user_id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP() AND u.is_active = 1
     LIMIT 1`,
    [sha256(rawToken)]
  );

  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    sessionId: r.session_id,
    user: {
      id: r.user_id,
      name: r.user_name,
      email: r.email,
      lastLoginAt: r.last_login_at,
      createdAt: r.user_created_at,
    },
    account: {
      id: r.account_id,
      name: r.account_name,
      ownerUserId: r.owner_user_id,
    },
    role: r.role,
  };
}

export async function logout(rawToken) {
  if (!rawToken) return;
  await query('DELETE FROM user_sessions WHERE token_hash = ?', [sha256(rawToken)]);
}

export async function updateProfile(userId, { name, email }) {
  const cleanName = String(name || '').trim();
  const cleanEmail = normalizeEmail(email);
  if (!cleanName || cleanName.length < 2) {
    const err = new Error('El nombre debe tener al menos 2 caracteres');
    err.statusCode = 400;
    throw err;
  }
  if (!cleanEmail || !cleanEmail.includes('@')) {
    const err = new Error('Ingresa un correo electrónico válido');
    err.statusCode = 400;
    throw err;
  }

  const clash = await query('SELECT id FROM users WHERE email = ? AND id <> ? LIMIT 1', [cleanEmail, userId]);
  if (clash.length > 0) {
    const err = new Error('Ese correo electrónico ya está en uso por otro usuario');
    err.statusCode = 409;
    throw err;
  }

  await query('UPDATE users SET name = ?, email = ? WHERE id = ?', [cleanName, cleanEmail, userId]);
  const [user] = await query('SELECT id, name, email, last_login_at, created_at FROM users WHERE id = ?', [userId]);
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    lastLoginAt: user.last_login_at,
    createdAt: user.created_at,
  };
}

export async function changePassword(userId, { currentPassword, newPassword }) {
  validatePassword(newPassword);
  const rows = await query('SELECT password_hash FROM users WHERE id = ? LIMIT 1', [userId]);
  if (rows.length === 0 || !verifyPassword(currentPassword, rows[0].password_hash)) {
    const err = new Error('La contraseña actual es incorrecta');
    err.statusCode = 400;
    throw err;
  }
  await query('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(newPassword), userId]);
  return { ok: true };
}

export async function updateAccountName(accountId, name) {
  const clean = String(name || '').trim();
  if (!clean || clean.length < 2) {
    const err = new Error('El nombre de la cuenta debe tener al menos 2 caracteres');
    err.statusCode = 400;
    throw err;
  }
  await query('UPDATE accounts SET name = ? WHERE id = ?', [clean, accountId]);
  const [acc] = await query('SELECT id, name, owner_user_id FROM accounts WHERE id = ?', [accountId]);
  return { id: acc.id, name: acc.name, ownerUserId: acc.owner_user_id };
}

// --- Recuperación de contraseña ---

export async function requestPasswordReset(email, baseUrl) {
  const cleanEmail = normalizeEmail(email);
  const rows = await query('SELECT id, name, email FROM users WHERE email = ? AND is_active = 1 LIMIT 1', [cleanEmail]);

  if (rows.length === 0) {
    return {
      ok: true,
      message: 'Si el correo está registrado, recibirás un enlace para restablecer tu contraseña.',
    };
  }

  const user = rows[0];
  const { raw, hash } = generateToken();
  const expiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60 * 1000);

  await query(
    'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
    [user.id, hash, expiresAt]
  );

  const resetUrl = `${String(baseUrl || '').replace(/\/+$/, '')}/?resetToken=${raw}`;
  const mailRes = await emailService.sendTransactionalEmail({
    to: user.email,
    subject: '[PulseGrid] Recuperación de contraseña',
    body: `Hola ${user.name},\n\nRecibimos una solicitud para restablecer tu contraseña en PulseGrid. Este enlace expira en ${RESET_TTL_MINUTES} minutos.\n\nSi no realizaste esta solicitud, puedes ignorar este correo.`,
    actionLabel: 'Restablecer contraseña',
    actionUrl: resetUrl,
  });

  if (!mailRes.ok && mailRes.smtpConfigured === false) {
    return {
      ok: false,
      error: 'El servidor SMTP aún no está configurado para enviar correos de recuperación. Configúralo en la pestaña Alertas o en las variables SMTP_* de Hostinger.',
    };
  }

  return {
    ok: true,
    message: 'Si el correo está registrado, recibirás un enlace para restablecer tu contraseña.',
  };
}

export async function resetPassword({ token, newPassword }) {
  validatePassword(newPassword);
  const rows = await query(
    `SELECT * FROM password_reset_tokens
     WHERE token_hash = ? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP()
     LIMIT 1`,
    [sha256(token)]
  );

  if (rows.length === 0) {
    const err = new Error('El enlace de recuperación es inválido o ya expiró');
    err.statusCode = 400;
    throw err;
  }

  const resetRow = rows[0];
  await query('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(newPassword), resetRow.user_id]);
  await query('UPDATE password_reset_tokens SET used_at = UTC_TIMESTAMP() WHERE id = ?', [resetRow.id]);
  await query('DELETE FROM user_sessions WHERE user_id = ?', [resetRow.user_id]);

  return { ok: true };
}

// --- Miembros e Invitaciones a la Cuenta ---

export async function listAccountMembers(accountId) {
  const rows = await query(
    `SELECT m.id, m.role, m.created_at AS joined_at, u.id AS user_id, u.name, u.email, u.last_login_at
     FROM account_members m
     INNER JOIN users u ON u.id = m.user_id
     WHERE m.account_id = ?
     ORDER BY FIELD(m.role, 'owner', 'admin', 'member', 'viewer'), u.name ASC`,
    [accountId]
  );

  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    name: r.name,
    email: r.email,
    role: r.role,
    lastLoginAt: r.last_login_at,
    joinedAt: r.joined_at,
  }));
}

export async function listInvitations(accountId) {
  const rows = await query(
    `SELECT i.id, i.email, i.role, i.status, i.expires_at, i.accepted_at, i.created_at, u.name AS invited_by_name
     FROM account_invitations i
     INNER JOIN users u ON u.id = i.invited_by_user_id
     WHERE i.account_id = ?
     ORDER BY i.created_at DESC
     LIMIT 50`,
    [accountId]
  );

  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    status: r.status === 'pending' && new Date(r.expires_at).getTime() < Date.now() ? 'expired' : r.status,
    expiresAt: r.expires_at,
    acceptedAt: r.accepted_at,
    createdAt: r.created_at,
    invitedByName: r.invited_by_name,
  }));
}

export async function getInvitationPreview(rawToken) {
  const rows = await query(
    `SELECT i.email, i.role, i.expires_at, a.name AS account_name, u.name AS invited_by_name
     FROM account_invitations i
     INNER JOIN accounts a ON a.id = i.account_id
     INNER JOIN users u ON u.id = i.invited_by_user_id
     WHERE i.token_hash = ? AND i.status = 'pending' AND i.expires_at > UTC_TIMESTAMP()
     LIMIT 1`,
    [sha256(rawToken)]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    email: r.email,
    role: r.role,
    accountName: r.account_name,
    invitedByName: r.invited_by_name,
    expiresAt: r.expires_at,
  };
}

export async function createInvitation({ accountId, invitedByUserId, inviterName, accountName, email, role = 'member', baseUrl }) {
  const cleanEmail = normalizeEmail(email);
  if (!cleanEmail || !cleanEmail.includes('@')) {
    const err = new Error('Ingresa un correo electrónico válido para invitar');
    err.statusCode = 400;
    throw err;
  }
  const safeRole = ['admin', 'member', 'viewer'].includes(role) ? role : 'member';

  // Si el usuario ya existe en el sistema y ya pertenece a la cuenta, rechazar
  const existingMember = await query(
    `SELECT m.id FROM account_members m INNER JOIN users u ON u.id = m.user_id WHERE m.account_id = ? AND u.email = ? LIMIT 1`,
    [accountId, cleanEmail]
  );
  if (existingMember.length > 0) {
    const err = new Error('Este usuario ya es miembro de la cuenta');
    err.statusCode = 409;
    throw err;
  }

  // Si el usuario ya está registrado en PulseGrid, agregarlo directamente a la cuenta
  const existingUser = await query('SELECT id, name, email FROM users WHERE email = ? LIMIT 1', [cleanEmail]);
  if (existingUser.length > 0) {
    await query('INSERT INTO account_members (account_id, user_id, role) VALUES (?, ?, ?)', [
      accountId,
      existingUser[0].id,
      safeRole,
    ]);
    return {
      addedDirectly: true,
      emailSent: false,
      message: `${existingUser[0].name} ya tenía cuenta en PulseGrid y fue agregado directamente.`,
    };
  }

  // Revocar invitaciones pendientes anteriores para el mismo correo en esta cuenta
  await query(
    `UPDATE account_invitations SET status = 'revoked' WHERE account_id = ? AND email = ? AND status = 'pending'`,
    [accountId, cleanEmail]
  );

  const { raw, hash } = generateToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

  await query(
    `INSERT INTO account_invitations (account_id, invited_by_user_id, email, role, token_hash, status, expires_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    [accountId, invitedByUserId, cleanEmail, safeRole, hash, expiresAt]
  );

  const inviteUrl = `${String(baseUrl || '').replace(/\/+$/, '')}/?inviteToken=${raw}`;
  const mailRes = await emailService.sendTransactionalEmail({
    to: cleanEmail,
    subject: `[PulseGrid] ${inviterName} te invitó a "${accountName}"`,
    body: `Hola,\n\n${inviterName} te ha invitado a unirte a la cuenta "${accountName}" en PulseGrid con el rol de "${safeRole}".\n\nHaz clic en el enlace para crear tu contraseña y acceder (válido por ${INVITE_TTL_DAYS} días).`,
    actionLabel: 'Aceptar invitación',
    actionUrl: inviteUrl,
  });

  return {
    addedDirectly: false,
    emailSent: Boolean(mailRes.ok),
    inviteUrl,
    expiresAt: expiresAt.toISOString(),
  };
}

export async function revokeInvitation(accountId, invitationId) {
  const res = await query(
    `UPDATE account_invitations SET status = 'revoked' WHERE id = ? AND account_id = ? AND status = 'pending'`,
    [invitationId, accountId]
  );
  return res.affectedRows > 0;
}

export async function updateMemberRole(accountId, targetUserId, newRole) {
  if (!['admin', 'member', 'viewer'].includes(newRole)) {
    const err = new Error('Rol inválido (usa admin, member o viewer)');
    err.statusCode = 400;
    throw err;
  }
  const rows = await query('SELECT role FROM account_members WHERE account_id = ? AND user_id = ? LIMIT 1', [
    accountId,
    targetUserId,
  ]);
  if (rows.length === 0) {
    const err = new Error('Miembro no encontrado');
    err.statusCode = 404;
    throw err;
  }
  if (rows[0].role === 'owner') {
    const err = new Error('No se puede cambiar el rol del propietario de la cuenta');
    err.statusCode = 400;
    throw err;
  }

  await query('UPDATE account_members SET role = ? WHERE account_id = ? AND user_id = ?', [
    newRole,
    accountId,
    targetUserId,
  ]);
  return listAccountMembers(accountId);
}

export async function removeMember(accountId, targetUserId) {
  const rows = await query('SELECT role FROM account_members WHERE account_id = ? AND user_id = ? LIMIT 1', [
    accountId,
    targetUserId,
  ]);
  if (rows.length === 0) {
    const err = new Error('Miembro no encontrado');
    err.statusCode = 404;
    throw err;
  }
  if (rows[0].role === 'owner') {
    const err = new Error('No se puede eliminar al propietario de la cuenta');
    err.statusCode = 400;
    throw err;
  }

  await query('DELETE FROM account_members WHERE account_id = ? AND user_id = ?', [accountId, targetUserId]);
  await query('DELETE FROM user_sessions WHERE account_id = ? AND user_id = ?', [accountId, targetUserId]);
  return listAccountMembers(accountId);
}

export async function hasAnyUsers() {
  const [row] = await query('SELECT COUNT(*) AS cnt FROM users');
  return Number(row?.cnt || 0) > 0;
}

export default {
  register,
  login,
  getSessionByToken,
  logout,
  updateProfile,
  changePassword,
  updateAccountName,
  requestPasswordReset,
  resetPassword,
  listAccountMembers,
  listInvitations,
  getInvitationPreview,
  createInvitation,
  revokeInvitation,
  updateMemberRole,
  removeMember,
  hasAnyUsers,
};
