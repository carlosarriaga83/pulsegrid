import emailService from '../services/emailService.js';

export async function getConfig(_req, res, next) {
  try {
    const smtp = await emailService.getSmtpConfig(false);
    const recipients = await emailService.listRecipients();
    res.json({ ok: true, data: { smtp, recipients } });
  } catch (err) {
    next(err);
  }
}

export async function updateSmtp(req, res, next) {
  try {
    const smtp = await emailService.saveSmtpConfig(req.body || {});
    res.json({ ok: true, data: smtp });
  } catch (err) {
    next(err);
  }
}

export async function addRecipient(req, res, next) {
  try {
    const recipients = await emailService.addRecipient(req.body || {});
    res.status(201).json({ ok: true, data: recipients });
  } catch (err) {
    next(err);
  }
}

export async function updateRecipient(req, res, next) {
  try {
    const recipients = await emailService.updateRecipient(req.params.id, req.body || {});
    res.json({ ok: true, data: recipients });
  } catch (err) {
    next(err);
  }
}

export async function deleteRecipient(req, res, next) {
  try {
    const deleted = await emailService.deleteRecipient(req.params.id);
    if (!deleted) return res.status(404).json({ ok: false, error: 'Destinatario no encontrado' });
    const recipients = await emailService.listRecipients();
    res.json({ ok: true, data: recipients });
  } catch (err) {
    next(err);
  }
}

export async function sendTest(req, res, next) {
  try {
    const targetEmail = req.body?.email ? [String(req.body.email).trim()] : null;
    const result = await emailService.sendAlert({
      alertType: 'test',
      sourceId: 'manual_test',
      subject: '[PulseGrid] Prueba de configuración SMTP',
      body: '¡Excelente! Si recibiste este mensaje, el sistema de alertas SMTP de PulseGrid está funcionando correctamente.',
      cooldownMinutes: 0,
      overrideRecipients: targetEmail,
    });
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    next(err);
  }
}

export async function listLogs(req, res, next) {
  try {
    const logs = await emailService.getAlertLogs(req.query.limit || 40);
    res.json({ ok: true, data: logs });
  } catch (err) {
    next(err);
  }
}

export default {
  getConfig,
  updateSmtp,
  addRecipient,
  updateRecipient,
  deleteRecipient,
  sendTest,
  listLogs,
};
