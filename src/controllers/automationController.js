import automationEngine from '../services/automationEngine.js';

export async function list(_req, res, next) {
  try {
    const data = await automationEngine.listAutomations();
    res.json({ ok: true, count: data.length, data });
  } catch (err) {
    next(err);
  }
}

export async function getOne(req, res, next) {
  try {
    const rule = await automationEngine.getAutomationById(req.params.id);
    if (!rule) return res.status(404).json({ ok: false, error: 'Automatización no encontrada' });
    res.json({ ok: true, data: rule });
  } catch (err) {
    next(err);
  }
}

export async function create(req, res, next) {
  try {
    const body = req.body || {};
    if (!body.name || !String(body.name).trim()) {
      return res.status(400).json({ ok: false, error: 'El nombre de la regla es obligatorio' });
    }
    if (!Array.isArray(body.actions) || body.actions.length === 0) {
      return res.status(400).json({ ok: false, error: 'Agrega al menos una acción en el bloque ENTONCES' });
    }
    const created = await automationEngine.createAutomation(body);
    // Evaluación inicial en modo dryRun para poblar el snapshot en vivo inmediatamente
    await automationEngine.evaluateRule(created, { dryRun: true }).catch(() => {});
    const fresh = await automationEngine.getAutomationById(created.id);
    res.status(201).json({ ok: true, data: fresh });
  } catch (err) {
    next(err);
  }
}

export async function update(req, res, next) {
  try {
    const updated = await automationEngine.updateAutomation(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ ok: false, error: 'Automatización no encontrada' });
    await automationEngine.evaluateRule(updated, { dryRun: true }).catch(() => {});
    const fresh = await automationEngine.getAutomationById(updated.id);
    res.json({ ok: true, data: fresh });
  } catch (err) {
    next(err);
  }
}

export async function toggle(req, res, next) {
  try {
    const { isEnabled } = req.body || {};
    const updated = await automationEngine.toggleAutomation(req.params.id, Boolean(isEnabled));
    if (!updated) return res.status(404).json({ ok: false, error: 'Automatización no encontrada' });
    res.json({ ok: true, data: updated });
  } catch (err) {
    next(err);
  }
}

export async function remove(req, res, next) {
  try {
    const deleted = await automationEngine.deleteAutomation(req.params.id);
    if (!deleted) return res.status(404).json({ ok: false, error: 'Automatización no encontrada' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

export async function evaluateOne(req, res, next) {
  try {
    const rule = await automationEngine.getAutomationById(req.params.id);
    if (!rule) return res.status(404).json({ ok: false, error: 'Automatización no encontrada' });
    const dryRun = Boolean(req.body?.dryRun);
    const result = await automationEngine.evaluateRule(rule, { dryRun });
    const updatedRule = await automationEngine.getAutomationById(rule.id);
    res.json({ ok: true, result, rule: updatedRule });
  } catch (err) {
    next(err);
  }
}

export async function evaluateAll(_req, res, next) {
  try {
    const summary = await automationEngine.evaluateAllRules();
    const rules = await automationEngine.listAutomations();
    res.json({ ok: true, summary, data: rules });
  } catch (err) {
    next(err);
  }
}

export async function logs(req, res, next) {
  try {
    const data = await automationEngine.getAutomationLogs(req.params.id, req.query.limit || 25);
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
}

export default {
  list,
  getOne,
  create,
  update,
  toggle,
  remove,
  evaluateOne,
  evaluateAll,
  logs,
};
