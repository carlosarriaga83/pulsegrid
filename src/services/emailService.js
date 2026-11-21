import nodemailer from 'nodemailer';
import env from '../config/env.js';
import { query } from '../config/db.js';
import { emitAlert } from '../sockets/socketManager.js';
import logger from '../utils/logger.js';

function parseJsonSafe(val, fallback = null) {
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'string') {
    try {
      return JSON.parse(val);
    } catch {
      return fallback;
    }
  }
  return val;
}

/**
 * Lee la configuración SMTP desde app_settings con fallback automático a .env.
 */
export async function getSmtpConfig(includePassword = false) {
  let dbCfg = {};
  try {
    const rows = await query(
      "SELECT setting_value FROM app_settings WHERE setting_key = 'smtp' LIMIT 1"
    );
    if (rows.length > 0) {
      dbCfg = parseJsonSafe(rows[0].setting_value, {}) || {};
    }
  } catch (err) {
    logger.warn('No se pudo leer configuración SMTP de app_settings', { error: err.message });
  }

  const resolved = {
    host: dbCfg.host || env.smtp.host || '',
    port: Number(dbCfg.port || env.smtp.port || 465),
    secure: dbCfg.secure !== undefined ? Boolean(dbCfg.secure) : env.smtp.secure,
    user: dbCfg.user || env.smtp.user || '',
    pass: dbCfg.pass || env.smtp.pass || '',
    fromName: dbCfg.fromName || env.smtp.fromName || 'PulseGrid Alertas',
    fromEmail: dbCfg.fromEmail || env.smtp.fromEmail || dbCfg.user || env.smtp.user || '',
  };

  const configured = Boolean(resolved.host && resolved.user && resolved.pass);

  if (includePassword) {
    return { ...resolved, configured };
  }

  return {
    host: resolved.host,
    port: resolved.port,
    secure: resolved.secure,
    user: resolved.user,
    hasPassword: Boolean(resolved.pass),
    fromName: resolved.fromName,
    fromEmail: resolved.fromEmail,
    configured,
  };
}

export async function saveSmtpConfig(payload) {
  const current = await getSmtpConfig(true);
  const next = {
    host: payload.host !== undefined ? String(payload.host).trim() : current.host,
    port: payload.port !== undefined ? Number(payload.port) : current.port,
    secure: payload.secure !== undefined ? Boolean(payload.secure) : current.secure,
    user: payload.user !== undefined ? String(payload.user).trim() : current.user,
    pass: payload.pass && String(payload.pass).trim() !== '' ? String(payload.pass) : current.pass,
    fromName: payload.fromName !== undefined ? String(payload.fromName).trim() : current.fromName,
    fromEmail: payload.fromEmail !== undefined ? String(payload.fromEmail).trim() : current.fromEmail,
  };

  await query(
    `INSERT INTO app_settings (setting_key, setting_value, description)
     VALUES ('smtp', ?, 'Configuración SMTP para alertas de correo')
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_at = CURRENT_TIMESTAMP`,
    [JSON.stringify(next)]
  );

  return getSmtpConfig(false);
}

// --- Destinatarios ---

export async function listRecipients() {
  const rows = await query('SELECT * FROM alert_recipients ORDER BY created_at DESC');
  return rows.map((r) => ({
    id: r.id,
    name: r.name || '',
    email: r.email,
    isActive: Boolean(r.is_active),
    receiveAutomationAlerts: Boolean(r.receive_automation_alerts),
    receiveOfflineAlerts: Boolean(r.receive_offline_alerts),
    createdAt: r.created_at,
  }));
}

export async function addRecipient({ name = '', email, receiveAutomationAlerts = true, receiveOfflineAlerts = true }) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes('@')) {
    const err = new Error('Ingresa un correo electrónico válido');
    err.statusCode = 400;
    throw err;
  }

  await query(
    `INSERT INTO alert_recipients (name, email, is_active, receive_automation_alerts, receive_offline_alerts)
     VALUES (?, ?, 1, ?, ?)
     ON DUPLICATE KEY UPDATE
       name = VALUES(name),
       is_active = 1,
       receive_automation_alerts = VALUES(receive_automation_alerts),
       receive_offline_alerts = VALUES(receive_offline_alerts)`,
    [name.trim() || null, cleanEmail, receiveAutomationAlerts ? 1 : 0, receiveOfflineAlerts ? 1 : 0]
  );

  return listRecipients();
}

export async function updateRecipient(id, payload) {
  const fields = [];
  const params = [];

  if (payload.name !== undefined) {
    fields.push('name = ?');
    params.push(String(payload.name).trim() || null);
  }
  if (payload.isActive !== undefined) {
    fields.push('is_active = ?');
    params.push(payload.isActive ? 1 : 0);
  }
  if (payload.receiveAutomationAlerts !== undefined) {
    fields.push('receive_automation_alerts = ?');
    params.push(payload.receiveAutomationAlerts ? 1 : 0);
  }
  if (payload.receiveOfflineAlerts !== undefined) {
    fields.push('receive_offline_alerts = ?');
    params.push(payload.receiveOfflineAlerts ? 1 : 0);
  }

  if (fields.length > 0) {
    params.push(id);
    await query(`UPDATE alert_recipients SET ${fields.join(', ')} WHERE id = ?`, params);
  }
  return listRecipients();
}

export async function deleteRecipient(id) {
  const res = await query('DELETE FROM alert_recipients WHERE id = ?', [id]);
  return res.affectedRows > 0;
}

// --- Cooldown y Envío ---

async function isInCooldown(alertType, sourceId, cooldownMinutes) {
  if (!cooldownMinutes || cooldownMinutes <= 0 || !sourceId) return false;
  const rows = await query(
    `SELECT sent_at FROM alert_logs
     WHERE alert_type = ? AND source_id = ? AND delivery_status = 'sent'
     ORDER BY sent_at DESC LIMIT 1`,
    [alertType, String(sourceId)]
  );
  if (rows.length === 0) return false;
  const elapsedMin = (Date.now() - new Date(rows[0].sent_at).getTime()) / 60000;
  return elapsedMin < cooldownMinutes;
}

function buildHtmlTemplate({ subject, body, alertType }) {
  const badgeColor =
    alertType === 'device_offline'
      ? '#f43f5e'
      : alertType === 'automation'
        ? '#38bdf8'
        : '#10b981';

  return `
    <div style="font-family:system-ui,-apple-system,sans-serif;background:#020617;color:#f8fafc;padding:24px;border-radius:12px;max-width:560px;margin:auto;border:1px solid #1e293b;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;">
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${badgeColor};"></span>
        <strong style="font-size:15px;letter-spacing:0.3px;">PulseGrid IoT</strong>
      </div>
      <h2 style="margin:0 0 12px;font-size:18px;color:#f8fafc;">${subject}</h2>
      <p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#cbd5e1;white-space:pre-line;">${body}</p>
      <div style="border-top:1px solid #1e293b;padding-top:12px;font-size:11px;color:#64748b;">
        Enviado automáticamente por PulseGrid · ${new Date().toLocaleString()} · <a href="${env.appUrl}" style="color:#38bdf8;text-decoration:none;">Abrir Panel</a>
      </div>
    </div>
  `;
}

/**
 * Envía una alerta por email respetando cooldown y registrando auditoría en alert_logs.
 */
export async function sendAlert({
  alertType = 'system',
  sourceId = null,
  subject,
  body,
  cooldownMinutes = 0,
  overrideRecipients = null,
}) {
  // 1. Verificar cooldown
  if (await isInCooldown(alertType, sourceId, cooldownMinutes)) {
    await query(
      `INSERT INTO alert_logs (alert_type, source_id, subject, body, recipients, delivery_status, error_message)
       VALUES (?, ?, ?, ?, ?, 'suppressed_cooldown', ?)`,
      [alertType, sourceId ? String(sourceId) : null, subject, body, JSON.stringify([]), `Suprimido por cooldown (${cooldownMinutes} min)`]
    );
    return { ok: true, suppressed: true, reason: 'cooldown' };
  }

  // 2. Obtener destinatarios
  let recipientEmails = Array.isArray(overrideRecipients) ? overrideRecipients : [];
  if (recipientEmails.length === 0) {
    const all = await listRecipients();
    recipientEmails = all
      .filter((r) => {
        if (!r.isActive) return false;
        if (alertType === 'automation') return r.receiveAutomationAlerts;
        if (alertType === 'device_offline') return r.receiveOfflineAlerts;
        return true;
      })
      .map((r) => r.email);
  }

  if (recipientEmails.length === 0) {
    const msg = 'No hay destinatarios activos configurados para este tipo de alerta';
    await query(
      `INSERT INTO alert_logs (alert_type, source_id, subject, body, recipients, delivery_status, error_message)
       VALUES (?, ?, ?, ?, ?, 'failed', ?)`,
      [alertType, sourceId ? String(sourceId) : null, subject, body, JSON.stringify([]), msg]
    );
    return { ok: false, error: msg };
  }

  // 3. Verificar configuración SMTP
  const smtp = await getSmtpConfig(true);
  if (!smtp.configured) {
    const msg = 'SMTP no configurado (define host, usuario y contraseña en Alertas o .env)';
    await query(
      `INSERT INTO alert_logs (alert_type, source_id, subject, body, recipients, delivery_status, error_message)
       VALUES (?, ?, ?, ?, ?, 'failed', ?)`,
      [alertType, sourceId ? String(sourceId) : null, subject, body, JSON.stringify(recipientEmails), msg]
    );
    return { ok: false, error: msg };
  }

  // 4. Enviar con Nodemailer
  try {
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: { user: smtp.user, pass: smtp.pass },
      connectionTimeout: 10000,
    });

    await transporter.sendMail({
      from: `"${smtp.fromName}" <${smtp.fromEmail || smtp.user}>`,
      to: recipientEmails.join(', '),
      subject,
      text: body,
      html: buildHtmlTemplate({ subject, body, alertType }),
    });

    await query(
      `INSERT INTO alert_logs (alert_type, source_id, subject, body, recipients, delivery_status)
       VALUES (?, ?, ?, ?, ?, 'sent')`,
      [alertType, sourceId ? String(sourceId) : null, subject, body, JSON.stringify(recipientEmails)]
    );

    emitAlert({ alertType, sourceId, subject, deliveryStatus: 'sent', recipients: recipientEmails });
    logger.info(`Alerta enviada (${alertType}): "${subject}" -> ${recipientEmails.length} destinatario(s)`);
    return { ok: true, sent: true, recipients: recipientEmails };
  } catch (err) {
    logger.error('Error enviando correo SMTP', err);
    await query(
      `INSERT INTO alert_logs (alert_type, source_id, subject, body, recipients, delivery_status, error_message)
       VALUES (?, ?, ?, ?, ?, 'failed', ?)`,
      [alertType, sourceId ? String(sourceId) : null, subject, body, JSON.stringify(recipientEmails), err.message]
    );
    return { ok: false, error: err.message };
  }
}

/**
 * Envía alerta de desconexión offline para un dispositivo respetando su cooldown individual.
 */
export async function sendDeviceOfflineAlert(device) {
  if (!device || !device.notifyOnOffline) return { ok: true, skipped: true };
  return sendAlert({
    alertType: 'device_offline',
    sourceId: device.id,
    subject: `[PulseGrid] Dispositivo desconectado: ${device.displayName}`,
    body: `El dispositivo "${device.displayName}" (${device.room || 'Sin zona'}) se ha desconectado (Offline).\nID Tuya: ${device.id}`,
    cooldownMinutes: device.offlineCooldownMinutes || 60,
  });
}

export async function getAlertLogs(limit = 40) {
  const safeLimit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 40));
  const rows = await query(`SELECT * FROM alert_logs ORDER BY sent_at DESC LIMIT ${safeLimit}`);
  return rows.map((r) => ({
    id: r.id,
    alertType: r.alert_type,
    sourceId: r.source_id,
    subject: r.subject,
    body: r.body,
    recipients: parseJsonSafe(r.recipients, []),
    deliveryStatus: r.delivery_status,
    errorMessage: r.error_message,
    sentAt: r.sent_at,
  }));
}

export default {
  getSmtpConfig,
  saveSmtpConfig,
  listRecipients,
  addRecipient,
  updateRecipient,
  deleteRecipient,
  sendAlert,
  sendDeviceOfflineAlert,
  getAlertLogs,
};
