import cron from 'node-cron';
import env from '../config/env.js';
import { query } from '../config/db.js';
import tuyaService from './tuyaService.js';
import weatherService, { getSolarEventTime } from './weatherService.js';
import { emitDeviceUpdate, emitAlert, getIO } from '../sockets/socketManager.js';
import logger from '../utils/logger.js';

let evaluationTask = null;
let pollingTask = null;
let cleanupTask = null;
let isEvaluating = false;
let emailDispatcher = null; // Hook conectable por emailService en Fase 5

export function registerEmailDispatcher(fn) {
  emailDispatcher = fn;
}

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

function formatRuleRow(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    isEnabled: Boolean(row.is_enabled),
    conditionLogic: row.condition_logic || 'ALL',
    conditions: parseJsonSafe(row.conditions_json, []),
    schedule: parseJsonSafe(row.schedule_json, { mode: 'anytime', days: [0, 1, 2, 3, 4, 5, 6] }),
    actions: parseJsonSafe(row.actions_json, []),
    cooldownMinutes: Number(row.cooldown_minutes ?? 5),
    lastTriggeredAt: row.last_triggered_at,
    lastEvaluatedAt: row.last_evaluated_at,
    lastEvalSnapshot: parseJsonSafe(row.last_eval_snapshot, null),
    triggerCount: Number(row.trigger_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Obtiene el valor humano (escalado según dpSchema.scale) de un DP de un dispositivo.
 */
function getScaledDpValue(device, dpCode) {
  if (!device || !device.status || device.status[dpCode] === undefined) {
    return { exists: false, raw: undefined, scaled: undefined, unit: '' };
  }
  const raw = device.status[dpCode];
  const specs = [...(device.dpSchema?.functions || []), ...(device.dpSchema?.status || [])];
  const spec = specs.find((s) => s.code === dpCode);
  const scale = Number(spec?.parsedValues?.scale || 0);
  const unit = spec?.parsedValues?.unit || '';

  if (typeof raw === 'number' && scale > 0) {
    return {
      exists: true,
      raw,
      scaled: Number((raw / Math.pow(10, scale)).toFixed(scale)),
      unit,
    };
  }

  return { exists: true, raw, scaled: raw, unit };
}

/**
 * Convierte un valor humano de acción al entero escalado de Tuya si el DP tiene scale > 0.
 */
function scaleActionValueForTuya(device, dpCode, value) {
  const fns = device?.dpSchema?.functions || [];
  const spec = fns.find((f) => f.code === dpCode);
  if (!spec) return value;

  const type = String(spec.type || '').toLowerCase();
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    return value === 'true' || value === '1' || value === 1;
  }
  if (type === 'integer') {
    const scale = Number(spec.parsedValues?.scale || 0);
    const num = Number(value);
    if (Number.isNaN(num)) return value;
    return scale > 0 ? Math.round(num * Math.pow(10, scale)) : Math.round(num);
  }
  return value;
}

function compareValues(left, operator, right) {
  // Normalizar booleanos y números
  const normalize = (v) => {
    if (typeof v === 'boolean') return v;
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v !== '' && v !== null && v !== undefined && !Number.isNaN(Number(v))) {
      return Number(v);
    }
    return String(v ?? '').toLowerCase();
  };

  const a = normalize(left);
  const b = normalize(right);

  switch (operator) {
    case '>':
      return typeof a === 'number' && typeof b === 'number' && a > b;
    case '<':
      return typeof a === 'number' && typeof b === 'number' && a < b;
    case '>=':
      return typeof a === 'number' && typeof b === 'number' && a >= b;
    case '<=':
      return typeof a === 'number' && typeof b === 'number' && a <= b;
    case '==':
      return a === b;
    case '!=':
      return a !== b;
    default:
      return false;
  }
}

/**
 * Obtiene hora, minuto y día de semana (0=Dom..6=Sáb) en la zona horaria IANA configurada.
 */
function getLocalClock(now, timeZone) {
  const tz = timeZone || env.weather.timezone || 'America/Mexico_City';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const map = {};
  for (const p of parts) map[p.type] = p.value;

  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hour = Number(map.hour) % 24;
  const minute = Number(map.minute);

  return {
    timeZone: tz,
    dayOfWeek: dayMap[map.weekday] ?? now.getDay(),
    hour,
    minute,
    totalMinutes: hour * 60 + minute,
    formattedTime: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  };
}

function parseHHMM(str) {
  if (!str || !String(str).includes(':')) return null;
  const [h, m] = String(str).split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

/**
 * Evalúa el bloque CUANDO (días, horario, amanecer/atardecer con offset, clima exterior).
 */
function evaluateSchedule(schedule, weather, now) {
  const cfg = schedule || { mode: 'anytime', days: [0, 1, 2, 3, 4, 5, 6] };
  const tz = weather?.timezone || weather?.location?.timezone || env.weather.timezone;
  const clock = getLocalClock(now, tz);

  // 1. Días de la semana
  const allowedDays = Array.isArray(cfg.days) && cfg.days.length > 0 ? cfg.days.map(Number) : [0, 1, 2, 3, 4, 5, 6];
  const dayMet = allowedDays.includes(clock.dayOfWeek);

  // 2. Ventana de tiempo / solar
  let timeMet = true;
  let timeDetail = `Hora local ${clock.formattedTime} (cualquier hora)`;

  if (cfg.mode === 'time_range') {
    const startMin = parseHHMM(cfg.startTime);
    const endMin = parseHHMM(cfg.endTime);
    if (startMin !== null && endMin !== null) {
      if (startMin <= endMin) {
        timeMet = clock.totalMinutes >= startMin && clock.totalMinutes <= endMin;
      } else {
        // Rango que cruza medianoche (ej. 22:00 a 06:00)
        timeMet = clock.totalMinutes >= startMin || clock.totalMinutes <= endMin;
      }
      timeDetail = `${clock.formattedTime} dentro de ${cfg.startTime}–${cfg.endTime}`;
    }
  } else if (cfg.mode === 'solar') {
    const solarRule = cfg.solarRule || 'after_sunset';
    const offsetMinutes = Number(cfg.offsetMinutes || 0);

    if (!weather?.solar?.sunrise || !weather?.solar?.sunset) {
      timeMet = false;
      timeDetail = 'Datos solares de Open-Meteo no disponibles';
    } else {
      const sunriseTarget = getSolarEventTime(weather, 'sunrise', solarRule.includes('sunrise') ? offsetMinutes : 0);
      const sunsetTarget = getSolarEventTime(weather, 'sunset', solarRule.includes('sunset') ? offsetMinutes : 0);

      // Comparar minutos del día en zona local
      const toLocalMinutes = (dateObj) => {
        if (!dateObj) return null;
        return getLocalClock(dateObj, tz).totalMinutes;
      };

      const srMin = toLocalMinutes(sunriseTarget);
      const ssMin = toLocalMinutes(sunsetTarget);
      const curMin = clock.totalMinutes;

      if (solarRule === 'after_sunset') {
        timeMet = curMin >= ssMin;
        timeDetail = `${clock.formattedTime} >= atardecer (${offsetMinutes >= 0 ? '+' : ''}${offsetMinutes} min)`;
      } else if (solarRule === 'before_sunset') {
        timeMet = curMin < ssMin;
        timeDetail = `${clock.formattedTime} < atardecer (${offsetMinutes >= 0 ? '+' : ''}${offsetMinutes} min)`;
      } else if (solarRule === 'after_sunrise') {
        timeMet = curMin >= srMin;
        timeDetail = `${clock.formattedTime} >= amanecer (${offsetMinutes >= 0 ? '+' : ''}${offsetMinutes} min)`;
      } else if (solarRule === 'before_sunrise') {
        timeMet = curMin < srMin;
        timeDetail = `${clock.formattedTime} < amanecer (${offsetMinutes >= 0 ? '+' : ''}${offsetMinutes} min)`;
      } else if (solarRule === 'night') {
        timeMet = curMin >= ssMin || curMin < srMin;
        timeDetail = `Noche (${clock.formattedTime})`;
      } else if (solarRule === 'day') {
        timeMet = curMin >= srMin && curMin < ssMin;
        timeDetail = `Día (${clock.formattedTime})`;
      }
    }
  }

  // 3. Restricción opcional de clima exterior
  let weatherMet = true;
  let weatherDetail = 'Cualquier clima';
  if (cfg.weatherCondition && cfg.weatherCondition !== 'any') {
    const actualCat = weather?.current?.weatherCategory || 'unknown';
    weatherMet = actualCat === cfg.weatherCondition;
    weatherDetail = `Clima actual: ${weather?.current?.weatherLabel || actualCat} (requiere: ${cfg.weatherCondition})`;
  }

  return {
    met: dayMet && timeMet && weatherMet,
    dayMet,
    timeMet,
    weatherMet,
    localTime: clock.formattedTime,
    timeZone: tz,
    detail: `${dayMet ? 'Día OK' : 'Día fuera de rango'} · ${timeDetail}${cfg.weatherCondition && cfg.weatherCondition !== 'any' ? ` · ${weatherDetail}` : ''}`,
  };
}

/**
 * Evalúa una sola condición del bloque SI.
 */
function evaluateCondition(cond, deviceMap, weather) {
  const type = cond.type || 'device_vs_value';
  const op = cond.operator || '==';

  if (type === 'weather') {
    const metric = cond.weatherMetric || 'temperature';
    const current = weather?.current?.[metric];
    if (current === undefined || current === null) {
      return {
        type,
        met: false,
        label: `Clima (${metric}) ${op} ${cond.value}`,
        actualValue: null,
        targetValue: cond.value,
        reason: 'Sin datos de clima',
      };
    }
    const met = compareValues(current, op, cond.value);
    return {
      type,
      met,
      label: `Clima exterior · ${metric} ${op} ${cond.value}`,
      actualValue: current,
      targetValue: cond.value,
      reason: met ? 'Cumplida' : `Actual: ${current}`,
    };
  }

  const devA = deviceMap.get(cond.deviceId);
  if (!devA) {
    return {
      type,
      met: false,
      label: `Dispositivo ${cond.deviceId} · ${cond.dpCode}`,
      actualValue: null,
      targetValue: cond.value,
      reason: 'Dispositivo no encontrado',
    };
  }

  const valA = getScaledDpValue(devA, cond.dpCode);
  if (!valA.exists) {
    return {
      type,
      met: false,
      label: `${devA.displayName} (${cond.dpCode})`,
      actualValue: null,
      targetValue: cond.value,
      reason: `DP '${cond.dpCode}' sin valor`,
    };
  }

  if (type === 'device_vs_device') {
    const devB = deviceMap.get(cond.targetDeviceId);
    if (!devB) {
      return {
        type,
        met: false,
        label: `${devA.displayName} (${cond.dpCode}) ${op} Dispositivo B`,
        actualValue: valA.scaled,
        targetValue: null,
        reason: 'Dispositivo B no encontrado',
      };
    }
    const valB = getScaledDpValue(devB, cond.targetDpCode);
    if (!valB.exists) {
      return {
        type,
        met: false,
        label: `${devA.displayName} (${cond.dpCode}) ${op} ${devB.displayName} (${cond.targetDpCode})`,
        actualValue: valA.scaled,
        targetValue: null,
        reason: `DP '${cond.targetDpCode}' sin valor en ${devB.displayName}`,
      };
    }
    const met = compareValues(valA.scaled, op, valB.scaled);
    return {
      type,
      met,
      label: `${devA.displayName} (${cond.dpCode}) ${op} ${devB.displayName} (${cond.targetDpCode})`,
      actualValue: `${valA.scaled}${valA.unit ? ` ${valA.unit}` : ''}`,
      targetValue: `${valB.scaled}${valB.unit ? ` ${valB.unit}` : ''}`,
      reason: met ? 'Cumplida' : `${valA.scaled} no es ${op} ${valB.scaled}`,
    };
  }

  // device_vs_value
  const met = compareValues(valA.scaled, op, cond.value);
  return {
    type,
    met,
    label: `${devA.displayName} (${cond.dpCode}) ${op} ${cond.value}${valA.unit ? ` ${valA.unit}` : ''}`,
    actualValue: `${valA.scaled}${valA.unit ? ` ${valA.unit}` : ''}`,
    targetValue: `${cond.value}${valA.unit ? ` ${valA.unit}` : ''}`,
    reason: met ? 'Cumplida' : `Actual: ${valA.scaled}${valA.unit ? ` ${valA.unit}` : ''}`,
  };
}

/**
 * Ejecuta el bloque ENTONCES (múltiples acciones a dispositivos + alerta email opcional).
 */
async function executeActions(rule, deviceMap, evaluationSnapshot) {
  const results = [];
  let hasErrors = false;

  // Agrupar comandos por dispositivo para aprovechar envío por lotes si hay varios DPs al mismo equipo
  const deviceCommandsMap = new Map();
  const emailActions = [];

  for (const action of rule.actions || []) {
    if (action.type === 'send_email') {
      emailActions.push(action);
    } else if (action.type === 'device_command' && action.deviceId && action.code) {
      const dev = deviceMap.get(action.deviceId);
      const scaledValue = scaleActionValueForTuya(dev, action.code, action.value);
      if (!deviceCommandsMap.has(action.deviceId)) {
        deviceCommandsMap.set(action.deviceId, []);
      }
      deviceCommandsMap.get(action.deviceId).push({ code: action.code, value: scaledValue });
    }
  }

  for (const [deviceId, commands] of deviceCommandsMap.entries()) {
    try {
      const res = await tuyaService.sendDeviceCommands(deviceId, commands);
      emitDeviceUpdate(res.device);
      results.push({ type: 'device_command', deviceId, commands, ok: true });
    } catch (err) {
      hasErrors = true;
      results.push({ type: 'device_command', deviceId, commands, ok: false, error: err.message });
    }
  }

  for (const mail of emailActions) {
    const subject = mail.subject || `[PulseGrid] Regla activada: ${rule.name}`;
    const message = mail.message || `La regla "${rule.name}" se cumplió y ejecutó sus acciones.`;

    emitAlert({
      alertType: 'automation',
      sourceId: String(rule.id),
      title: subject,
      message,
    });

    if (typeof emailDispatcher === 'function') {
      try {
        const mailRes = await emailDispatcher({
          alertType: 'automation',
          sourceId: String(rule.id),
          subject,
          body: message,
          cooldownMinutes: rule.cooldownMinutes,
          evaluationSnapshot,
        });
        results.push({ type: 'send_email', subject, ok: mailRes.ok !== false, detail: mailRes });
      } catch (err) {
        hasErrors = true;
        results.push({ type: 'send_email', subject, ok: false, error: err.message });
      }
    } else {
      results.push({
        type: 'send_email',
        subject,
        ok: true,
        detail: 'Evento emitido en tiempo real (envío SMTP activo a partir de Fase 5)',
      });
    }
  }

  return { results, hasErrors };
}

/**
 * Evalúa una regla específica y opcionalmente ejecuta sus acciones.
 */
export async function evaluateRule(rule, { deviceMap, weather, dryRun = false } = {}) {
  const now = new Date();
  const devices = deviceMap || new Map((await tuyaService.getDevices(false)).map((d) => [d.id, d]));
  let weatherData = weather;
  if (!weatherData) {
    try {
      weatherData = await weatherService.getWeather(false);
    } catch {
      weatherData = null;
    }
  }

  const condResults = (rule.conditions || []).map((c) => evaluateCondition(c, devices, weatherData));
  const conditionsMet =
    condResults.length === 0
      ? true
      : rule.conditionLogic === 'ANY'
        ? condResults.some((r) => r.met)
        : condResults.every((r) => r.met);

  const scheduleResult = evaluateSchedule(rule.schedule, weatherData, now);
  const allMet = conditionsMet && scheduleResult.met;

  // Verificar cooldown
  let inCooldown = false;
  let cooldownRemainingSec = 0;
  if (rule.lastTriggeredAt && rule.cooldownMinutes > 0) {
    const lastMs = new Date(rule.lastTriggeredAt).getTime();
    const diffSec = (now.getTime() - lastMs) / 1000;
    const requiredSec = rule.cooldownMinutes * 60;
    if (diffSec < requiredSec) {
      inCooldown = true;
      cooldownRemainingSec = Math.ceil(requiredSec - diffSec);
    }
  }

  const snapshot = {
    evaluatedAt: now.toISOString(),
    conditionsMet,
    scheduleMet: scheduleResult.met,
    allMet,
    inCooldown,
    cooldownRemainingSec,
    conditions: condResults,
    schedule: scheduleResult,
  };

  let status = 'evaluated';
  let actionsResult = null;

  if (allMet && !dryRun) {
    if (inCooldown) {
      status = 'skipped_cooldown';
    } else {
      const exec = await executeActions(rule, devices, snapshot);
      actionsResult = exec.results;
      const allFailed = exec.results.length > 0 && exec.results.every((r) => !r.ok);
      status = allFailed ? 'error' : exec.hasErrors ? 'partial_error' : 'triggered';

      await query(
        `UPDATE automations
         SET last_triggered_at = NOW(), last_evaluated_at = NOW(), last_eval_snapshot = ?, trigger_count = trigger_count + 1
         WHERE id = ?`,
        [JSON.stringify(snapshot), rule.id]
      );

      await query(
        `INSERT INTO automation_logs (automation_id, status, evaluation_details, actions_result, error_message)
         VALUES (?, ?, ?, ?, ?)`,
        [
          rule.id,
          status,
          JSON.stringify(snapshot),
          JSON.stringify(actionsResult),
          exec.hasErrors ? 'Una o más acciones reportaron error' : null,
        ]
      );

      const io = getIO();
      if (io) {
        io.emit('automation:triggered', {
          automationId: rule.id,
          name: rule.name,
          status,
          snapshot,
          actionsResult,
          timestamp: now.toISOString(),
        });
      }

      return { ruleId: rule.id, status, snapshot, actionsResult };
    }
  }

  // Persistir último snapshot de evaluación en vivo
  await query(
    'UPDATE automations SET last_evaluated_at = NOW(), last_eval_snapshot = ? WHERE id = ?',
    [JSON.stringify(snapshot), rule.id]
  );

  const io = getIO();
  if (io) {
    io.emit('automation:evaluated', {
      automationId: rule.id,
      snapshot,
    });
  }

  return { ruleId: rule.id, status, snapshot, actionsResult };
}

/**
 * Ejecuta un ciclo de evaluación sobre todas las reglas activas.
 */
export async function evaluateAllRules() {
  if (isEvaluating) return { skipped: true, reason: 'Ciclo en progreso' };
  isEvaluating = true;

  try {
    const rows = await query('SELECT * FROM automations WHERE is_enabled = 1 ORDER BY id ASC');
    if (rows.length === 0) return { evaluated: 0, triggered: 0, results: [] };

    const deviceList = await tuyaService.getDevices(false);
    const deviceMap = new Map(deviceList.map((d) => [d.id, d]));

    let weather = null;
    try {
      weather = await weatherService.getWeather(false);
    } catch (err) {
      logger.warn('Evaluación de reglas sin clima Open-Meteo', { error: err.message });
    }

    const results = [];
    let triggered = 0;

    for (const row of rows) {
      const rule = formatRuleRow(row);
      try {
        const res = await evaluateRule(rule, { deviceMap, weather, dryRun: false });
        if (res.status === 'triggered' || res.status === 'partial_error') triggered += 1;
        results.push(res);
      } catch (err) {
        logger.error(`Error evaluando regla #${rule.id} (${rule.name})`, err);
      }
    }

    return { evaluated: rows.length, triggered, results };
  } finally {
    isEvaluating = false;
  }
}

// --- CRUD de Automatizaciones ---

export async function listAutomations() {
  const rows = await query('SELECT * FROM automations ORDER BY created_at DESC');
  return rows.map(formatRuleRow);
}

export async function getAutomationById(id) {
  const rows = await query('SELECT * FROM automations WHERE id = ? LIMIT 1', [id]);
  return rows.length > 0 ? formatRuleRow(rows[0]) : null;
}

export async function createAutomation(payload) {
  const {
    name,
    description = '',
    isEnabled = true,
    conditionLogic = 'ALL',
    conditions = [],
    schedule = { mode: 'anytime', days: [0, 1, 2, 3, 4, 5, 6] },
    actions = [],
    cooldownMinutes = 5,
  } = payload;

  const [result] = await (await import('../config/db.js')).pool.execute(
    `INSERT INTO automations (name, description, is_enabled, condition_logic, conditions_json, schedule_json, actions_json, cooldown_minutes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      String(name).trim(),
      description ? String(description).trim() : null,
      isEnabled ? 1 : 0,
      conditionLogic === 'ANY' ? 'ANY' : 'ALL',
      JSON.stringify(conditions),
      JSON.stringify(schedule),
      JSON.stringify(actions),
      Math.max(0, Number.parseInt(cooldownMinutes, 10) || 0),
    ]
  );

  return getAutomationById(result.insertId);
}

export async function updateAutomation(id, payload) {
  const existing = await getAutomationById(id);
  if (!existing) return null;

  await query(
    `UPDATE automations
     SET name = ?, description = ?, is_enabled = ?, condition_logic = ?,
         conditions_json = ?, schedule_json = ?, actions_json = ?, cooldown_minutes = ?
     WHERE id = ?`,
    [
      String(payload.name ?? existing.name).trim(),
      payload.description !== undefined ? String(payload.description).trim() : existing.description,
      payload.isEnabled !== undefined ? (payload.isEnabled ? 1 : 0) : existing.isEnabled ? 1 : 0,
      (payload.conditionLogic ?? existing.conditionLogic) === 'ANY' ? 'ANY' : 'ALL',
      JSON.stringify(payload.conditions ?? existing.conditions),
      JSON.stringify(payload.schedule ?? existing.schedule),
      JSON.stringify(payload.actions ?? existing.actions),
      Math.max(0, Number.parseInt(payload.cooldownMinutes ?? existing.cooldownMinutes, 10) || 0),
      id,
    ]
  );

  return getAutomationById(id);
}

export async function toggleAutomation(id, isEnabled) {
  await query('UPDATE automations SET is_enabled = ? WHERE id = ?', [isEnabled ? 1 : 0, id]);
  return getAutomationById(id);
}

export async function deleteAutomation(id) {
  const res = await query('DELETE FROM automations WHERE id = ?', [id]);
  return res.affectedRows > 0;
}

export async function getAutomationLogs(automationId, limit = 25) {
  const safeLimit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 25));
  const rows = await query(
    `SELECT * FROM automation_logs WHERE automation_id = ? ORDER BY executed_at DESC LIMIT ${safeLimit}`,
    [automationId]
  );
  return rows.map((r) => ({
    id: r.id,
    automationId: r.automation_id,
    status: r.status,
    evaluationDetails: parseJsonSafe(r.evaluation_details, null),
    actionsResult: parseJsonSafe(r.actions_result, []),
    errorMessage: r.error_message,
    executedAt: r.executed_at,
  }));
}

/**
 * Inicia los jobs de node-cron: evaluación de reglas, polling Tuya y limpieza de logs.
 */
export function startScheduler() {
  const expr = cron.validate(env.polling.automationCron) ? env.polling.automationCron : '*/1 * * * *';

  evaluationTask = cron.schedule(expr, async () => {
    try {
      const summary = await evaluateAllRules();
      if (summary.triggered > 0) {
        logger.info(`Motor de automatizaciones: ${summary.triggered}/${summary.evaluated} regla(s) disparadas`);
      }
    } catch (err) {
      logger.error('Error en cron de automatizaciones', err);
    }
  });

  // Polling periódico de Tuya Cloud si hay credenciales configuradas
  pollingTask = cron.schedule('*/1 * * * *', async () => {
    if (!tuyaService.isTuyaConfigured()) return;
    try {
      const res = await tuyaService.syncDevices();
      if (res.changes?.length > 0) {
        for (const ch of res.changes) {
          emitDeviceUpdate(ch.device);
        }
      }
    } catch (err) {
      logger.warn('Error en polling periódico de Tuya', { error: err.message });
    }
  });

  // Limpieza diaria a las 03:30 AM de logs antiguos
  cleanupTask = cron.schedule('30 3 * * *', async () => {
    try {
      const days = env.polling.automationLogRetentionDays || 30;
      const res = await query(
        'DELETE FROM automation_logs WHERE executed_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
        [days]
      );
      if (res.affectedRows > 0) {
        logger.info(`Limpieza de automation_logs: ${res.affectedRows} registro(s) eliminados`);
      }
    } catch (err) {
      logger.warn('Error en limpieza de automation_logs', { error: err.message });
    }
  });

  logger.info(`Scheduler node-cron iniciado (automatizaciones: "${expr}")`);
}

export function stopScheduler() {
  evaluationTask?.stop();
  pollingTask?.stop();
  cleanupTask?.stop();
  logger.info('Scheduler node-cron detenido correctamente');
}

export default {
  registerEmailDispatcher,
  listAutomations,
  getAutomationById,
  createAutomation,
  updateAutomation,
  toggleAutomation,
  deleteAutomation,
  getAutomationLogs,
  evaluateRule,
  evaluateAllRules,
  startScheduler,
  stopScheduler,
};
