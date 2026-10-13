const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const https = require('https');
const cloudVersion = require('./package.json').version;
const AutomationModel = require('./automation-model');
const OpenMeteo = require('./open-meteo');

require('dotenv').config({ path: path.join(__dirname, '.env', 'local.env') });

const app = express();
const port = Number(process.env.PORT || 3000);
const root = __dirname;
const publicRoot = path.join(root, 'public');
let pool;
let schemaReady;
let automationTickRunning = false;
let tuyaTelemetrySyncRunning = false;
const tuyaTokens = new Map();
const automationTroubleshooting = new Map();
const tuyaSyncIntervalMs = Math.min(Math.max(Number(process.env.TUYA_SYNC_INTERVAL_MS) || 60000, 15000), 15 * 60 * 1000);
const automationSchedulerIntervalMs = 5000;

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

function fail(response, status, error) {
  return response.status(status).json({ error });
}

function hashApiKey(apiKey) {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

async function apiKeyOwner(apiKey) {
  if (!apiKey) return null;
  const [keys] = await database().execute('SELECT user_id FROM api_keys WHERE key_hash = ? LIMIT 1', [hashApiKey(apiKey)]);
  return keys[0] || null;
}

function createApiKey() {
  return `pg_live_${crypto.randomBytes(24).toString('base64url')}`;
}

const firmwareFiles = new Set(['main.py', 'pulsegrid.py', 'pulsegrid_min.py', 'webserver.py', 'webserver_min.py', 'cortina.py', 'stservo.py', 'ssd1306.py', 'captive_portal.py', 'motor_curtain.py', 'boot.py', 'ota_boot.py']);

function firmwareVersion(version) {
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(String(version || ''))) throw new Error('Invalid firmware version');
  return String(version);
}

function newFirmwareVersion(version) {
  const safeVersion = firmwareVersion(version);
  if (!/^\d{4}\.\d{2}\.\d{2}\.[A-Za-z0-9_-]+$/.test(safeVersion)) throw new Error('La version debe usar YYYY.MM.DD.X');
  return safeVersion;
}

function firmwareFileName(fileName) {
  if (!firmwareFiles.has(String(fileName || ''))) throw new Error('Archivo de firmware no permitido');
  return String(fileName);
}

function automationAction(action, position, speed, acceleration) {
  const payload = { speed, acceleration };
  if (action === 'open') return { command: 'curtain.open', payload };
  if (action === 'close') return { command: 'curtain.close', payload };
  if (action === 'position') return { command: 'curtain.move', payload: { servoId: 1, percent: position, ...payload } };
  throw new Error('Accion de automatizacion invalida');
}

function automationValueSource(source) {
  if (source == null) return null;
  if (!source || typeof source !== 'object' || Array.isArray(source) || Object.keys(source).some((key) => !['deviceId', 'path', 'transform', 'divisor'].includes(key))) throw new Error('La fuente de valor de automatizacion no es valida');
  const deviceId = String(source.deviceId || '').trim();
  const path = String(source.path || '').trim();
  const transform = String(source.transform || '').trim();
  const divisor = Number(source.divisor);
  if (!deviceId || deviceId.length > 80 || !AutomationModel.safePath(path) || !['copy', 'divide'].includes(transform) || !Number.isFinite(divisor) || divisor <= 0) throw new Error('La fuente de valor requiere parametro y transformacion validos');
  return { deviceId, path, transform, divisor };
}

function automationMotionValue(value, fallback, label, maximum) {
  const motion = value == null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(motion) || motion < 0 || motion > maximum) throw new Error(`${label} debe estar entre 0 y ${maximum}`);
  return motion;
}

function automationTimezone(timezone) {
  const safeTimezone = String(timezone || '').trim();
  if (!safeTimezone || safeTimezone.length > 64) throw new Error('Zona horaria invalida');
  try {
    Intl.DateTimeFormat('en-CA', { timeZone: safeTimezone }).format();
  } catch {
    throw new Error('Zona horaria invalida');
  }
  return safeTimezone;
}

function automationLocalTime(timezone, date = new Date()) {
  const parts = Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value;
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { date: `${value('year')}-${value('month')}-${value('day')}`, time: `${value('hour')}:${value('minute')}`, weekday: weekdays[value('weekday')] };
}

function automationWeekdays(weekdays) {
  if (!Array.isArray(weekdays)) throw new Error('Selecciona al menos un dia de la semana');
  const validDays = [...new Set(weekdays.map(Number))].sort((first, second) => first - second);
  if (!validDays.length || validDays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) throw new Error('Los dias de automatizacion no son validos');
  return validDays;
}

function automationCondition(condition) {
  if (condition == null || condition === '') return null;
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) throw new Error('La condicion de automatizacion no es valida');
  const deviceId = String(condition.deviceId || '').trim();
  const kind = condition.kind ?? 'parameter';
  const path = String(condition.path || '').trim();
  const operator = String(condition.operator || '').trim();
  const value = condition.value;
  const weather = deviceId === OpenMeteo.WEATHER_DEVICE_ID;
  const fields = kind === 'parameter' ? ['kind', 'deviceId', 'path', 'operator', 'value', ...(weather ? ['latitude', 'longitude', 'timezone'] : [])] : ['kind', 'deviceId', 'commandName', 'commandCode', 'commandField', 'operator', 'value'];
  if (!['parameter', 'command'].includes(kind) || Object.keys(condition).some((key) => !fields.includes(key))) throw new Error('La condicion debe elegir solo parametro o comando');
  if (!deviceId || deviceId.length > 80 || !['eq', 'neq', 'gt', 'gte', 'lt', 'lte'].includes(operator)) throw new Error('La condicion requiere dispositivo y operador validos');
  if (value === undefined || value === null || (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean')) throw new Error('El valor de la condicion no es valido');
  if (typeof value === 'number' && !Number.isFinite(value) || typeof value === 'string' && value.length > 1000) throw new Error('El valor de la condicion no es valido');
  if (kind === 'parameter') {
    if (!AutomationModel.safePath(path)) throw new Error('Ruta de parametro invalida');
    if (weather) {
      if (['sunrise', 'sunset'].includes(path) && (operator !== 'eq' || value !== true)) throw new Error('El evento solar requiere una condicion de evento valida');
      const location = OpenMeteo.config(condition);
      return { kind, deviceId, path, operator, value, latitude: location.latitude, longitude: location.longitude, timezone: location.timezone };
    }
    return { kind, deviceId, path, operator, value };
  }
  const { commandName, commandCode, commandField } = condition;
  if (typeof commandName !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(commandName)) throw new Error('Comando de condicion invalido');
  if (commandName === 'tuya.set') {
    if (!AutomationModel.safePath(commandCode) || commandField !== 'value') throw new Error('El comando Tuya requiere codigo y campo value');
    return { kind, deviceId, commandName, commandCode, commandField, operator, value };
  }
  if (commandCode !== undefined || commandField !== 'status' || typeof value !== 'string' || !['eq', 'neq'].includes(operator)) throw new Error('El comando nativo compara su estado con = o !=');
  return { kind, deviceId, commandName, commandField, operator, value };
}

function automationConditions(conditions, legacyCondition) {
  if (conditions !== undefined && !Array.isArray(conditions)) throw new Error('Las condiciones deben ser una lista');
  const source = Array.isArray(conditions) ? conditions : legacyCondition == null ? [] : [legacyCondition];
  if (source.length > 20 || source.some((condition) => !condition)) throw new Error('Lista de condiciones invalida');
  return source.map((condition) => automationCondition(condition));
}

function automationCheckInterval(value) {
  if (value == null || value === '') return 30;
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 3600) throw new Error('La frecuencia de revision debe estar entre 5 segundos y 1 hora');
  return seconds;
}

function automationInput(body = {}) {
  const name = String(body.name || '').trim();
  const deviceId = String(body.deviceId || '').trim();
  const triggerTime = String(body.triggerTime || '').trim();
  const action = String(body.action || '').trim();
  const commandName = String(body.commandName || '').trim();
  const commandPayload = body.commandPayload;
  const valueSource = automationValueSource(body.valueSource);
  const position = Number(body.position);
  const speed = automationMotionValue(body.speed, 800, 'Velocidad', 3073);
  const acceleration = automationMotionValue(body.acceleration, 50, 'Aceleracion', 150);
  const timezone = automationTimezone(body.timezone);
  const weekdays = automationWeekdays(body.weekdays);
  const conditions = automationConditions(body.conditions, body.condition);
  const checkIntervalSeconds = automationCheckInterval(body.checkIntervalSeconds);
  if (!name || name.length > 120 || !deviceId || (triggerTime !== 'anytime' && !['sunrise', 'sunset'].includes(triggerTime) && !/^\d{2}:\d{2}$/.test(triggerTime))) throw new Error('Nombre, dispositivo y horario son obligatorios');
  if (['sunrise', 'sunset'].includes(triggerTime) && !conditions.some((condition) => condition.deviceId === OpenMeteo.WEATHER_DEVICE_ID)) throw new Error('El evento solar requiere una condicion de ubicacion Open-Meteo');
  if (!['anytime', 'sunrise', 'sunset'].includes(triggerTime)) {
    const [hours, minutes] = triggerTime.split(':').map(Number);
    if (hours > 23 || minutes > 59) throw new Error('Hora de automatizacion invalida');
  }
  if (commandName) {
    if (commandName !== 'tuya.set' || !commandPayload || typeof commandPayload !== 'object' || Array.isArray(commandPayload) || Object.keys(commandPayload).some((key) => !['code', 'value'].includes(key)) || !AutomationModel.safePath(commandPayload.code) || (!valueSource && !Object.hasOwn(commandPayload, 'value'))) throw new Error('El comando de automatizacion no es valido');
    return { name, deviceId, triggerTime, action: 'open', position: null, valueSource, speed: 800, acceleration: 50, timezone, weekdays, conditions, checkIntervalSeconds, commandName, commandPayload };
  }
  if (valueSource && action !== 'position') throw new Error('La fuente de valor requiere un comando Tuya o mover la cortina a una posicion');
  if (action === 'position' && !valueSource && (!Number.isFinite(position) || position < 0 || position > 100)) throw new Error('La posicion debe estar entre 0 y 100');
  automationAction(action, position, speed, acceleration);
  return { name, deviceId, triggerTime, action, position: action === 'position' && !valueSource ? position : null, valueSource, speed, acceleration, timezone, weekdays, conditions, checkIntervalSeconds, commandName: null, commandPayload: null };
}

function automationConditionValue(payload, path) {
  if (!AutomationModel.safePath(path)) return undefined;
  if (path.split('.').length === 1 && Array.isArray(payload?.status)) return payload.status.find((item) => item && item.code === path)?.value;
  if (path.split('.').length === 1 && payload?.status && typeof payload.status === 'object' && Object.hasOwn(payload.status, path)) return payload.status[path];
  return path.split('.').reduce((current, key) => {
    if (Array.isArray(current)) return current.find((item) => item && item.code === key)?.value;
    return current && typeof current === 'object' && Object.hasOwn(current, key) ? current[key] : undefined;
  }, payload);
}

function automationSourceValue(payload, path) {
  return automationConditionValue(payload, path);
}

function automationConditionMatches(condition, payload) {
  if (!condition) return true;
  const actual = automationConditionValue(payload, condition.path);
  if (actual === undefined || actual === null) return false;
  const expected = condition.value;
  if (condition.operator === 'eq') return actual === expected;
  if (condition.operator === 'neq') return actual !== expected;
  const actualNumber = Number(actual);
  const expectedNumber = Number(expected);
  if (!Number.isFinite(actualNumber) || !Number.isFinite(expectedNumber)) return false;
  if (condition.operator === 'gt') return actualNumber > expectedNumber;
  if (condition.operator === 'gte') return actualNumber >= expectedNumber;
  if (condition.operator === 'lt') return actualNumber < expectedNumber;
  if (condition.operator === 'lte') return actualNumber <= expectedNumber;
  return false;
}

async function automationConditionEvaluation(db, rule) {
  if (!rule.conditionJson) return { met: true, conditions: [] };
  const stored = typeof rule.conditionJson === 'string' ? JSON.parse(rule.conditionJson) : rule.conditionJson;
  const conditions = Array.isArray(stored) ? stored : stored ? [stored] : [];
  const evaluations = [];
  for (const condition of conditions) {
    automationCondition(condition);
    if (condition.deviceId === OpenMeteo.WEATHER_DEVICE_ID) {
      const weather = await OpenMeteo.getWeatherSnapshot(condition);
      if (condition.kind === 'parameter' && ['sunrise', 'sunset'].includes(condition.path)) { evaluations.push({ ...condition, actual: null, met: true }); continue; }
      const actual = weather.telemetry[condition.path];
      const met = automationConditionMatches(condition, weather.telemetry);
      evaluations.push({ ...condition, actual: actual ?? null, met });
      if (!met) return { met: false, conditions: evaluations };
      continue;
    }
    if (condition.kind === 'command') {
      const tuya = condition.commandName === 'tuya.set';
      const [commands] = await db.execute(`SELECT payload, status FROM commands WHERE device_id = (SELECT id FROM devices WHERE device_id = ? AND user_id = ?) AND command_name = ?${tuya ? " AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.code')) = ?" : ''} ORDER BY created_at DESC, id DESC LIMIT 1`, [condition.deviceId, rule.userId, condition.commandName, ...(tuya ? [condition.commandCode] : [])]);
      if (!commands[0]) { evaluations.push({ ...condition, actual: null, met: false }); return { met: false, conditions: evaluations }; }
      const payload = typeof commands[0].payload === 'string' ? JSON.parse(commands[0].payload) : commands[0].payload;
      const actual = tuya ? payload?.value : commands[0].status;
      const met = automationConditionMatches({ ...condition, path: 'value' }, { value: actual });
      evaluations.push({ ...condition, actual, met });
      if (!met) return { met: false, conditions: evaluations };
      continue;
    }
    const [rows] = await db.execute('SELECT payload FROM telemetry WHERE device_id = (SELECT id FROM devices WHERE device_id = ? AND user_id = ?) ORDER BY created_at DESC, id DESC LIMIT 1', [condition.deviceId, rule.userId]);
    if (!rows[0]) { evaluations.push({ ...condition, actual: null, met: false }); return { met: false, conditions: evaluations }; }
    const payload = typeof rows[0].payload === 'string' ? JSON.parse(rows[0].payload) : rows[0].payload;
    const actual = automationConditionValue(payload, condition.path);
    const met = automationConditionMatches(condition, payload);
    evaluations.push({ ...condition, actual: actual ?? null, met });
    if (!met) return { met: false, conditions: evaluations };
  }
  return { met: evaluations.every((condition) => condition.met), conditions: evaluations };
}

async function automationConditionIsMet(db, rule) {
  return (await automationConditionEvaluation(db, rule)).met;
}

async function runScheduledAutomations() {
  if (automationTickRunning) return;
  automationTickRunning = true;
  try {
    await ensureSchema();
    const db = database();
    const [rules] = await db.execute('SELECT id, user_id AS userId, device_id AS deviceId, trigger_time AS triggerTime, action_name AS action, position, value_source AS valueSource, speed, acceleration, command_name AS commandName, command_payload AS commandPayload, condition_json AS conditionJson, timezone, weekdays, check_interval_seconds AS checkIntervalSeconds, condition_active AS conditionActive FROM automations WHERE enabled = 1 AND timezone IS NOT NULL AND (last_checked_at IS NULL OR last_checked_at <= DATE_SUB(NOW(), INTERVAL check_interval_seconds SECOND))');
    for (const rule of rules) {
      const [checked] = await db.execute('UPDATE automations SET last_checked_at = NOW() WHERE id = ? AND enabled = 1', [rule.id]);
      if (!checked.affectedRows) continue;
      const localTime = automationLocalTime(rule.timezone);
      const onScheduledDay = String(rule.weekdays).split(',').map(Number).includes(localTime.weekday);
      let triggerTime = rule.triggerTime;
      if (['sunrise', 'sunset'].includes(rule.triggerTime)) {
        if (!onScheduledDay) continue;
        const storedConditions = typeof rule.conditionJson === 'string' ? JSON.parse(rule.conditionJson) : rule.conditionJson;
        const weatherCondition = (Array.isArray(storedConditions) ? storedConditions : storedConditions ? [storedConditions] : []).find((condition) => condition.deviceId === OpenMeteo.WEATHER_DEVICE_ID);
        if (!weatherCondition) continue;
        triggerTime = OpenMeteo.solarTime(await OpenMeteo.getWeatherSnapshot(weatherCondition), rule.triggerTime, new Date());
      }
      if (rule.triggerTime !== 'anytime' && (!onScheduledDay || localTime.time !== triggerTime)) continue;
      const evaluation = await automationConditionEvaluation(db, rule);
      const valueSource = typeof rule.valueSource === 'string' ? JSON.parse(rule.valueSource) : rule.valueSource;
      const reactive = evaluation.conditions.length > 0 || Boolean(valueSource);
      if (!evaluation.met) continue;
      if (rule.triggerTime === 'anytime' && !onScheduledDay) continue;
      let command = rule.commandName ? { command: rule.commandName, payload: typeof rule.commandPayload === 'string' ? JSON.parse(rule.commandPayload) : rule.commandPayload } : automationAction(rule.action, rule.position, rule.speed, rule.acceleration);
      if (valueSource) {
        const [sourceRows] = await db.execute('SELECT id FROM devices WHERE device_id = ? AND user_id = ? LIMIT 1', [valueSource.deviceId, rule.userId]);
        if (!sourceRows[0]) continue;
        const [telemetryRows] = await db.execute('SELECT payload FROM telemetry WHERE device_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', [sourceRows[0].id]);
        const payload = telemetryRows[0] ? (typeof telemetryRows[0].payload === 'string' ? JSON.parse(telemetryRows[0].payload) : telemetryRows[0].payload) : null;
        const raw = automationSourceValue(payload, valueSource.path);
        const value = valueSource.transform === 'divide' ? Number(raw) / valueSource.divisor : raw;
        if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean' || typeof value === 'number' && !Number.isFinite(value)) continue;
        if (rule.commandName === 'tuya.set') {
          const payload = typeof rule.commandPayload === 'string' ? JSON.parse(rule.commandPayload) : rule.commandPayload;
          command = { command: 'tuya.set', payload: { ...payload, value } };
        }
        else {
          if (Number(value) < 0 || Number(value) > 100) continue;
          command = automationAction('position', Number(value), rule.speed, rule.acceleration);
        }
      }
      const [claimed] = rule.triggerTime === 'anytime' && reactive
        ? await db.execute('UPDATE automations SET last_run_at = NOW(), condition_active = 0 WHERE id = ? AND enabled = 1', [rule.id])
        : await db.execute('UPDATE automations SET last_run_at = NOW(), last_run_date = ?, condition_active = 0 WHERE id = ? AND enabled = 1 AND (last_run_date IS NULL OR last_run_date <> ?)', [localTime.date, rule.id, localTime.date]);
      if (!claimed.affectedRows) continue;
      const [devices] = await db.execute('SELECT id, user_id AS userId, device_id, provider, capabilities FROM devices WHERE id = ? LIMIT 1', [rule.deviceId]);
      if (devices[0]) await dispatchDeviceCommand(db, devices[0], command.command, command.payload, { ruleId: rule.id });
    }
  } catch (error) {
    console.error('Automation scheduler:', error.message);
  } finally {
    automationTickRunning = false;
  }
}

async function readFirmwareManifest(userId, version, targetModel) {
  const safeTargetModel = targetModel ? String(targetModel).trim() : '';
  const targetCondition = safeTargetModel ? "AND (target_model = ? OR target_model = 'Todos los dispositivos')" : '';
  const order = safeTargetModel ? "CASE WHEN target_model = ? THEN 0 ELSE 1 END, created_at DESC" : 'created_at DESC';
  const parameters = version ? [userId, firmwareVersion(version)] : [userId];
  if (safeTargetModel) parameters.push(safeTargetModel);
  if (safeTargetModel) parameters.push(safeTargetModel);
  const [releases] = await database().execute(`SELECT id, version, target_model AS targetModel, notes AS whatsNew, is_active AS isActive, created_at AS createdAt FROM firmware_releases WHERE user_id = ? ${version ? 'AND version = ?' : 'AND is_active = 1'} ${targetCondition} ORDER BY ${order} LIMIT 1`, parameters);
  if (!releases[0]) return null;
  const [files] = await database().execute('SELECT name, OCTET_LENGTH(content) AS size, sha256 FROM firmware_files WHERE release_id = ? ORDER BY name', [releases[0].id]);
  if (!files.length) throw new Error('El manifiesto no contiene archivos');
  files.forEach((file) => firmwareFileName(file.name));
  return { ...releases[0], files };
}

async function readFirmwareReleases(userId) {
  const [releases] = await database().execute('SELECT id, version, target_model AS targetModel, notes AS whatsNew, is_active AS isActive, created_at AS createdAt FROM firmware_releases WHERE user_id = ? ORDER BY created_at DESC', [userId]);
  if (!releases.length) return [];
  const placeholders = releases.map(() => '?').join(',');
  const [files] = await database().execute(`SELECT release_id AS releaseId, name, OCTET_LENGTH(content) AS size, sha256 FROM firmware_files WHERE release_id IN (${placeholders}) ORDER BY name`, releases.map((release) => release.id));
  return releases.map((release) => ({ ...release, files: files.filter((file) => String(file.releaseId) === String(release.id)).map(({ releaseId, ...file }) => file) }));
}

async function sessionUserId(email) {
  const [users] = await database().execute('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);
  return users[0]?.id;
}

function relayCloud(request, response, method, cloudPath) {
  const target = new URL(`https://pulse.2api2.com${cloudPath}`);
  const payload = method === 'GET' ? '' : JSON.stringify(request.body || {});
  const headers = { 'X-API-Key': request.get('x-api-key') };
  if (payload) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }
  const upstream = https.request({
    hostname: target.hostname,
    port: 443,
    path: `${target.pathname}${target.search}`,
    method,
    headers
  }, (upstreamResponse) => {
    response.status(upstreamResponse.statusCode || 502);
    if (upstreamResponse.headers['content-type']) response.set('Content-Type', upstreamResponse.headers['content-type']);
    if (cloudPath.startsWith('/api/firmware/')) {
      const chunks = [];
      upstreamResponse.on('data', (chunk) => chunks.push(chunk));
      upstreamResponse.on('end', () => {
        const content = Buffer.concat(chunks);
        response.set('Content-Length', String(content.length)).end(content);
      });
      return;
    }
    if (upstreamResponse.headers['content-length']) response.set('Content-Length', upstreamResponse.headers['content-length']);
    upstreamResponse.pipe(response);
  });
  upstream.on('error', (error) => fail(response, 502, `Cloud relay failed: ${error.message}`));
  upstream.end(payload);
}

function database() {
  if (pool) return pool;
  const { DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD } = process.env;
  if (!DB_HOST || !DB_NAME || !DB_USER || !DB_PASSWORD) throw new Error('Database environment is not configured');
  pool = mysql.createPool({ host: DB_HOST, port: Number(DB_PORT || 3306), database: DB_NAME, user: DB_USER, password: DB_PASSWORD, waitForConnections: true, connectionLimit: 5, charset: 'utf8mb4' });
  return pool;
}

function tuyaEncryptionKey() {
  return crypto.scryptSync(process.env.TUYA_CREDENTIALS_KEY || process.env.SESSION_SECRET || 'replace-this-in-hostinger', 'pulsegrid-tuya', 32);
}

function encryptTuyaSecret(secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', tuyaEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${encrypted.toString('base64')}`;
}

function decryptTuyaSecret(ciphertext) {
  const [iv, tag, encrypted] = String(ciphertext || '').split('.').map((part) => Buffer.from(part, 'base64'));
  if (!iv || !tag || !encrypted) throw new Error('La credencial Tuya guardada no es valida');
  const decipher = crypto.createDecipheriv('aes-256-gcm', tuyaEncryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function tuyaEndpoint(endpoint) {
  const url = new URL(String(endpoint || 'https://openapi.tuyaus.com'));
  if (url.protocol !== 'https:' || !/^openapi(?:-[a-z0-9]+)?\.tuya(?:us|eu|cn|in)?\.com$/i.test(url.hostname)) throw new Error('El endpoint Tuya no es valido');
  return url.origin;
}

async function tuyaConfiguration(userId) {
  if (userId) {
    const [rows] = await database().execute('SELECT client_id AS clientId, secret_ciphertext AS secretCiphertext, endpoint, tuya_user_id AS tuyaUserId, reference_device_id AS referenceDeviceId FROM tuya_connections WHERE user_id = ? LIMIT 1', [userId]);
    if (rows[0]) return { ...rows[0], clientSecret: decryptTuyaSecret(rows[0].secretCiphertext), endpoint: tuyaEndpoint(rows[0].endpoint) };
  }
  const clientId = process.env.TUYA_CLIENT_ID || process.env.TUYA_ACCESS_ID;
  const clientSecret = process.env.TUYA_CLIENT_SECRET || process.env.TUYA_ACCESS_SECRET;
  if (!clientId || !clientSecret) throw new Error('Tuya no esta configurado en el servidor');
  return { clientId, clientSecret, endpoint: tuyaEndpoint(process.env.TUYA_ENDPOINT), tuyaUserId: String(process.env.TUYA_USER_ID || '').trim(), referenceDeviceId: String(process.env.TUYA_REFERENCE_DEVICE_ID || '').trim() };
}

function tuyaHttp(method, endpoint, pathName, headers, bodyText = '') {
  return new Promise((resolve, reject) => {
    const target = new URL(`${endpoint}${pathName}`);
    const request = https.request({ hostname: target.hostname, port: 443, path: `${target.pathname}${target.search}`, method, headers: { ...headers, ...(bodyText ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyText) } : {}) }, timeout: 15000 }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch { reject(new Error('Respuesta invalida de Tuya')); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Tuya no respondio a tiempo')));
    request.on('error', reject);
    request.end(bodyText);
  });
}

function tuyaSignature(config, token, timestamp, method, pathName, bodyText = '') {
  const stringToSign = `${method}\n${crypto.createHash('sha256').update(bodyText).digest('hex')}\n\n${pathName}`;
  const source = token ? `${config.clientId}${token}${timestamp}${stringToSign}` : `${config.clientId}${timestamp}${stringToSign}`;
  return crypto.createHmac('sha256', config.clientSecret).update(source).digest('hex').toUpperCase();
}

async function tuyaToken(userId) {
  const config = await tuyaConfiguration(userId);
  const tokenKey = String(userId || `environment:${config.clientId}`);
  const cached = tuyaTokens.get(tokenKey);
  if (cached && Date.now() < cached.expiresAt) return { config, token: cached.token };
  const pathName = '/v1.0/token?grant_type=1';
  const timestamp = String(Date.now());
  const response = await tuyaHttp('GET', config.endpoint, pathName, { client_id: config.clientId, t: timestamp, sign: tuyaSignature(config, null, timestamp, 'GET', pathName), sign_method: 'HMAC-SHA256' });
  if (!response.success || !response.result?.access_token) throw new Error(response.msg || 'No fue posible autenticar con Tuya');
  const token = response.result.access_token;
  tuyaTokens.set(tokenKey, { token, expiresAt: Date.now() + Math.max(60000, (Number(response.result.expire_time) - 60) * 1000) });
  return { config, token };
}

async function tuyaRequest(userId, method, pathName, body) {
  const trace = await tuyaRequestRaw(userId, method, pathName, body);
  return trace.response.result;
}

async function tuyaRequestRaw(userId, method, pathName, body) {
  const { config, token } = await tuyaToken(userId);
  const bodyText = body ? JSON.stringify(body) : '';
  const timestamp = String(Date.now());
  const response = await tuyaHttp(method, config.endpoint, pathName, { client_id: config.clientId, access_token: token, t: timestamp, sign: tuyaSignature(config, token, timestamp, method, pathName, bodyText), sign_method: 'HMAC-SHA256' }, bodyText);
  const trace = { request: body || null, response };
  if (!response.success) {
    if ([1010, 1011, 28841105].includes(Number(response.code))) tuyaTokens.delete(String(userId || `environment:${config.clientId}`));
    const error = new Error(response.msg || 'Tuya rechazo la solicitud');
    error.tuyaTrace = trace;
    throw error;
  }
  return trace;
}

function recordAutomationTroubleshooting(userId, entry) {
  const key = String(userId);
  const entries = automationTroubleshooting.get(key) || [];
  entries.unshift({ timestamp: new Date().toISOString(), ...entry });
  automationTroubleshooting.set(key, entries.slice(0, 30));
}

function normalizeTelemetry(value) {
  if (Array.isArray(value)) return value.map(normalizeTelemetry);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalizeTelemetry(value[key])]));
  return value;
}

async function storeTelemetryIfChanged(db, deviceId, payload) {
  const [rows] = await db.execute('SELECT payload FROM telemetry WHERE device_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', [deviceId]);
  const current = rows[0]?.payload;
  const previous = typeof current === 'string' ? JSON.parse(current) : current;
  if (previous && JSON.stringify(normalizeTelemetry(previous)) === JSON.stringify(normalizeTelemetry(payload))) return false;
  await db.execute('INSERT INTO telemetry (device_id, payload) VALUES (?, ?)', [deviceId, JSON.stringify(payload)]);
  return true;
}

function telemetryDateParameter(value, label) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} no es una fecha valida`);
  return date;
}

async function tuyaAccountDevices(ownerId) {
  const config = await tuyaConfiguration(ownerId);
  if (config.tuyaUserId) return tuyaRequest(ownerId, 'GET', `/v1.0/users/${encodeURIComponent(config.tuyaUserId)}/devices`);
  const referenceId = String(config.referenceDeviceId || '').trim();
  if (referenceId) {
    const reference = await tuyaRequest(ownerId, 'GET', `/v1.0/devices/${encodeURIComponent(referenceId)}`);
    if (reference?.uid) return tuyaRequest(ownerId, 'GET', `/v1.0/users/${encodeURIComponent(reference.uid)}/devices`);
  }
  const result = await tuyaRequest(ownerId, 'GET', '/v2.0/cloud/thing/device?page_no=1&page_size=100');
  return result?.list || result || [];
}

function tuyaFunctions(capabilities) {
  const values = typeof capabilities === 'string' ? JSON.parse(capabilities || '[]') : capabilities;
  return Array.isArray(values) ? values : [];
}

function validateTuyaCommand(device, command, payload, valueSource = null) {
  if (device.provider !== 'tuya') throw new Error('El dispositivo no usa el protocolo Tuya');
  if (command !== 'tuya.set' || !payload || typeof payload.code !== 'string' || (!valueSource && !Object.hasOwn(payload, 'value'))) throw new Error('Usa tuya.set con code y value');
  const option = AutomationModel.writable(device).find((item) => item.value === payload.code);
  if (!option) throw new Error('La funcion Tuya no pertenece a este dispositivo');
  if (!valueSource && AutomationModel.typedValue(payload.value, option) !== payload.value) throw new Error('El valor Tuya debe usar el tipo declarado');
}

function validateDeviceConfiguration(device, command, payload) {
  if (command !== 'device.configure' || device.provider === 'tuya') throw new Error('La configuracion remota solo aplica a dispositivos Pulsegrid');
  if (!payload || typeof payload.apiUrl !== 'string' || !/^https?:\/\/[^\s]+$/i.test(payload.apiUrl.trim()) || typeof payload.apiKey !== 'string' || !/^[A-Za-z0-9_.:-]{8,200}$/.test(payload.apiKey.trim()) || typeof payload.deviceId !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(payload.deviceId.trim())) throw new Error('API URL, API key y device ID no son validos');
  if (Object.hasOwn(payload, 'reversed') && typeof payload.reversed !== 'boolean') throw new Error('reversed debe ser booleano');
}

function validateDirectionConfiguration(device, command, payload) {
  if (command !== 'direction.configure' || device.provider === 'tuya' || !AutomationModel.curtain(device)) throw new Error('La configuracion de sentido solo aplica a cortinas Pulsegrid');
  if (!payload || typeof payload.reversed !== 'boolean' || Object.keys(payload).some((key) => key !== 'reversed')) throw new Error('reversed debe ser booleano');
}

async function validateAutomationDevices(db, email, target, rule) {
  if (rule.commandName) validateTuyaCommand(target, rule.commandName, rule.commandPayload, rule.valueSource);
  else {
    const [readings] = await db.execute('SELECT payload FROM telemetry WHERE device_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', [target.id]);
    if (!AutomationModel.curtain({ ...target, telemetry: readings[0]?.payload })) throw new Error('El dispositivo destino no declara un protocolo de cortina compatible');
  }
  if (rule.valueSource) {
    const [sources] = await db.execute('SELECT id FROM devices WHERE user_id = (SELECT id FROM users WHERE email = ?) AND device_id = ? LIMIT 1', [email, rule.valueSource.deviceId]);
    if (!sources[0]) throw new Error('Dispositivo fuente no encontrado');
  }
  for (const condition of rule.conditions) {
    if (condition.deviceId === OpenMeteo.WEATHER_DEVICE_ID) {
      if (condition.kind !== 'parameter' || !OpenMeteo.parameters().some((item) => item.value === condition.path)) throw new Error('Parametro de Open-Meteo invalido');
      OpenMeteo.config(condition);
      continue;
    }
    const [sources] = await db.execute('SELECT id, provider, type, capabilities FROM devices WHERE user_id = (SELECT id FROM users WHERE email = ?) AND device_id = ? LIMIT 1', [email, condition.deviceId]);
    if (!sources[0]) throw new Error('Dispositivo de condicion no encontrado');
    if (condition.kind !== 'command') continue;
    const source = sources[0];
    if (condition.commandName === 'tuya.set') {
      const option = AutomationModel.writable(source).find((item) => item.value === condition.commandCode);
      if (!option || AutomationModel.typedValue(condition.value, option) !== condition.value) throw new Error('Codigo o tipo de condicion Tuya invalido');
    } else {
      const [readings] = await db.execute('SELECT payload FROM telemetry WHERE device_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', [source.id]);
      if (!AutomationModel.commands({ ...source, telemetry: readings[0]?.payload }, true).some((item) => item.commandName === condition.commandName)) throw new Error('Comando fuente no compatible con el dispositivo');
    }
  }
}

async function dispatchDeviceCommand(db, device, command, payload, context = {}) {
  if (device.provider !== 'tuya') {
    if (command === 'device.configure') validateDeviceConfiguration(device, command, payload);
    if (command === 'direction.configure') {
      const [readings] = await db.execute('SELECT payload FROM telemetry WHERE device_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', [device.id]);
      const latestTelemetry = readings[0]?.payload;
      validateDirectionConfiguration({ ...device, telemetry: latestTelemetry }, command, payload);
    }
    const [result] = await db.execute('INSERT INTO commands (device_id, command_name, payload) VALUES (?, ?, ?)', [device.id, command, JSON.stringify(payload)]);
    return { id: result.insertId, status: 'queued' };
  }
  validateTuyaCommand(device, command, payload);
  const option = AutomationModel.writable(device).find((item) => item.value === payload.code);
  const typedPayload = { code: payload.code, value: AutomationModel.typedValue(payload.value, option) };
  const [result] = await db.execute("INSERT INTO commands (device_id, command_name, payload, status) VALUES (?, ?, ?, 'running')", [device.id, command, JSON.stringify(typedPayload)]);
  try {
    const requestPayload = { commands: [typedPayload] };
    const trace = await tuyaRequestRaw(device.userId, 'POST', `/v1.0/devices/${encodeURIComponent(device.device_id)}/commands`, requestPayload);
    await db.execute("UPDATE commands SET status = 'succeeded' WHERE id = ?", [result.insertId]);
    const troubleshooting = { deviceId: device.device_id, ruleId: context.ruleId || null, command, request: requestPayload, response: trace.response };
    recordAutomationTroubleshooting(device.userId, troubleshooting);
    return { id: result.insertId, status: 'succeeded', troubleshooting };
  } catch (error) {
    await db.execute("UPDATE commands SET status = 'failed', error_message = ? WHERE id = ?", [String(error.message).slice(0, 500), result.insertId]);
    const troubleshooting = { deviceId: device.device_id, ruleId: context.ruleId || null, command, request: { commands: [typedPayload] }, response: error.tuyaTrace?.response || { error: error.message } };
    recordAutomationTroubleshooting(device.userId, troubleshooting);
    error.troubleshooting = troubleshooting;
    throw error;
  }
}

async function syncTuyaDevice(db, device) {
  const values = {};
  const errors = [];
  let received = false;
  try {
    const status = await tuyaRequest(device.userId, 'GET', `/v1.0/devices/${encodeURIComponent(device.device_id)}/status`);
    const entries = Array.isArray(status) ? status : Object.entries(status || {}).map(([code, value]) => ({ code, value }));
    entries.forEach((item) => { if (item?.code) values[item.code] = item.value; });
    received = entries.length > 0;
  } catch (error) {
    errors.push(error.message);
  }
  try {
    const shadow = await tuyaRequest(device.userId, 'GET', `/v2.0/cloud/thing/${encodeURIComponent(device.device_id)}/shadow/properties`);
    const properties = Array.isArray(shadow?.properties) ? shadow.properties : [];
    properties.forEach((item) => { if (item?.code) values[item.code] = item.value; });
    received = received || properties.length > 0;
  } catch (error) {
    errors.push(error.message);
  }
  const accountStatus = device.accountDevice?.status || device.accountDevice?.dps;
  if (Array.isArray(accountStatus)) {
    accountStatus.forEach((item) => { if (item?.code) values[item.code] = item.value; });
    received = received || accountStatus.length > 0;
  } else if (accountStatus && typeof accountStatus === 'object') {
    Object.assign(values, accountStatus);
    received = true;
  }
  if (!received) throw new Error(errors.filter(Boolean).join('; ') || 'Tuya no devolvio datos para este dispositivo');
  const online = typeof device.accountDevice?.online === 'boolean' ? device.accountDevice.online : null;
  const payload = { provider: 'tuya', status: values };
  await storeTelemetryIfChanged(db, device.id, payload);
  await db.execute("UPDATE devices SET status = COALESCE(?, status), last_seen = NOW() WHERE id = ?", [online === null ? null : online ? 'online' : 'offline', device.id]);
  return payload;
}

async function syncTuyaDevicesForUser(db, userId) {
  const [devices] = await db.execute("SELECT id, user_id AS userId, device_id FROM devices WHERE user_id = ? AND provider = 'tuya'", [userId]);
  if (!devices.length) return { synced: 0, failed: 0 };
  const accountDevices = await tuyaAccountDevices(userId);
  const accountById = new Map(accountDevices.map((item) => [String(item.id), item]));
  const results = await Promise.all(devices.map(async (device) => {
    try {
      await syncTuyaDevice(db, { ...device, accountDevice: accountById.get(String(device.device_id)) });
      return true;
    } catch (error) {
      console.warn(`Tuya sync failed for ${device.device_id}: ${error.message}`);
      return false;
    }
  }));
  return { synced: results.filter(Boolean).length, failed: results.filter((result) => !result).length };
}

async function runTuyaTelemetrySync() {
  if (tuyaTelemetrySyncRunning) return;
  tuyaTelemetrySyncRunning = true;
  try {
    await ensureSchema();
    const db = database();
    const [connections] = await db.execute("SELECT DISTINCT devices.user_id AS userId FROM devices INNER JOIN tuya_connections ON tuya_connections.user_id = devices.user_id WHERE devices.provider = 'tuya'");
    for (const connection of connections) {
      try {
        const result = await syncTuyaDevicesForUser(db, connection.userId);
        if (result.failed) console.warn(`Tuya sync user ${connection.userId}: ${result.synced} synced, ${result.failed} failed`);
      } catch (error) {
        console.warn(`Tuya sync user ${connection.userId} failed: ${error.message}`);
      }
    }
  } catch (error) {
    console.error('Tuya telemetry scheduler:', error.message);
  } finally {
    tuyaTelemetrySyncRunning = false;
  }
}

app.use(cookieSession({
  name: 'pulsegrid.sid',
  keys: [process.env.SESSION_SECRET || 'replace-this-in-hostinger'],
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 1000 * 60 * 60 * 24 * 7
}));

async function ensureSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const db = database();
    await db.execute("CREATE TABLE IF NOT EXISTS users (id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(120) NOT NULL, email VARCHAR(190) NOT NULL UNIQUE, password_hash VARCHAR(255) NOT NULL, role ENUM('admin','operator','viewer') NOT NULL DEFAULT 'viewer', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB");
    await db.execute("CREATE TABLE IF NOT EXISTS api_keys (id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, user_id INT UNSIGNED NOT NULL UNIQUE, key_hash CHAR(64) NOT NULL UNIQUE, key_hint VARCHAR(16) NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, last_used_at TIMESTAMP NULL, CONSTRAINT api_keys_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE) ENGINE=InnoDB");
    await db.execute("CREATE TABLE IF NOT EXISTS devices (id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, user_id INT UNSIGNED NOT NULL, device_id VARCHAR(80) NOT NULL, name VARCHAR(120) NOT NULL, type VARCHAR(60) NOT NULL, provider VARCHAR(20) NOT NULL DEFAULT 'pulsegrid', capabilities JSON NULL, status ENUM('online','offline') NOT NULL DEFAULT 'offline', last_seen TIMESTAMP NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY user_device (user_id, device_id), CONSTRAINT devices_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE) ENGINE=InnoDB");
    try { await db.execute("ALTER TABLE devices ADD COLUMN provider VARCHAR(20) NOT NULL DEFAULT 'pulsegrid' AFTER type"); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
    try { await db.execute('ALTER TABLE devices ADD COLUMN capabilities JSON NULL AFTER provider'); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
    await db.execute("CREATE TABLE IF NOT EXISTS tuya_connections (user_id INT UNSIGNED PRIMARY KEY, client_id VARCHAR(120) NOT NULL, secret_ciphertext TEXT NOT NULL, endpoint VARCHAR(160) NOT NULL, tuya_user_id VARCHAR(120) NULL, reference_device_id VARCHAR(120) NULL, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, CONSTRAINT tuya_connections_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE) ENGINE=InnoDB");
    await db.execute("CREATE TABLE IF NOT EXISTS telemetry (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, device_id INT UNSIGNED NOT NULL, payload JSON NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX telemetry_device (device_id), CONSTRAINT telemetry_device_fk FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE) ENGINE=InnoDB");
    try { await db.execute('ALTER TABLE telemetry ADD INDEX telemetry_device_created (device_id, created_at)'); } catch (error) { if (error.code !== 'ER_DUP_KEYNAME') throw error; }
    await db.execute("CREATE TABLE IF NOT EXISTS commands (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, device_id INT UNSIGNED NOT NULL, command_name VARCHAR(80) NOT NULL, payload JSON NOT NULL, status VARCHAR(30) NOT NULL DEFAULT 'queued', error_message VARCHAR(500) NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, CONSTRAINT commands_device_fk FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE) ENGINE=InnoDB");
    try { await db.execute('ALTER TABLE commands ADD COLUMN error_message VARCHAR(500) NULL'); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
    await db.execute("CREATE TABLE IF NOT EXISTS automations (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, user_id INT UNSIGNED NOT NULL, device_id INT UNSIGNED NOT NULL, name VARCHAR(120) NOT NULL, trigger_time VARCHAR(10) NOT NULL, timezone VARCHAR(64) NULL, weekdays VARCHAR(13) NOT NULL DEFAULT '0,1,2,3,4,5,6', action_name ENUM('open','close','position') NOT NULL, position DECIMAL(5,2) NULL, speed SMALLINT UNSIGNED NOT NULL DEFAULT 800, acceleration TINYINT UNSIGNED NOT NULL DEFAULT 50, condition_json JSON NULL, check_interval_seconds SMALLINT UNSIGNED NOT NULL DEFAULT 30, enabled TINYINT(1) NOT NULL DEFAULT 1, last_checked_at TIMESTAMP NULL, last_run_at TIMESTAMP NULL, last_run_date CHAR(10) NULL, condition_active TINYINT(1) NOT NULL DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, INDEX automation_schedule (enabled, trigger_time, last_run_date), CONSTRAINT automations_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, CONSTRAINT automations_device_fk FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE) ENGINE=InnoDB");
    await db.execute('ALTER TABLE automations MODIFY COLUMN trigger_time VARCHAR(10) NOT NULL');
    try { await db.execute('ALTER TABLE automations ADD COLUMN timezone VARCHAR(64) NULL AFTER trigger_time'); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
    try { await db.execute("ALTER TABLE automations ADD COLUMN weekdays VARCHAR(13) NOT NULL DEFAULT '0,1,2,3,4,5,6' AFTER timezone"); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
    try { await db.execute('ALTER TABLE automations ADD COLUMN last_run_date CHAR(10) NULL AFTER last_run_at'); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
    try { await db.execute('ALTER TABLE automations ADD COLUMN condition_active TINYINT(1) NOT NULL DEFAULT 0 AFTER last_run_date'); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
    try { await db.execute('ALTER TABLE automations ADD COLUMN command_name VARCHAR(80) NULL AFTER action_name'); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
    try { await db.execute('ALTER TABLE automations ADD COLUMN command_payload JSON NULL AFTER command_name'); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
    try { await db.execute('ALTER TABLE automations ADD COLUMN speed SMALLINT UNSIGNED NOT NULL DEFAULT 800 AFTER position'); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
    try { await db.execute('ALTER TABLE automations ADD COLUMN acceleration TINYINT UNSIGNED NOT NULL DEFAULT 50 AFTER speed'); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
    try { await db.execute('ALTER TABLE automations ADD COLUMN condition_json JSON NULL AFTER acceleration'); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
    try { await db.execute('ALTER TABLE automations ADD COLUMN value_source JSON NULL AFTER position'); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
    try { await db.execute('ALTER TABLE automations ADD COLUMN check_interval_seconds SMALLINT UNSIGNED NOT NULL DEFAULT 30 AFTER condition_json'); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
    try { await db.execute('ALTER TABLE automations ADD COLUMN last_checked_at TIMESTAMP NULL AFTER enabled'); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
    await db.execute("CREATE TABLE IF NOT EXISTS firmware_releases (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, user_id INT UNSIGNED NOT NULL, version VARCHAR(40) NOT NULL, target_model VARCHAR(120) NOT NULL DEFAULT 'Todos los dispositivos', notes VARCHAR(280) NOT NULL DEFAULT '', is_active TINYINT(1) NOT NULL DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY firmware_user_version (user_id, version), INDEX firmware_active (user_id, is_active), CONSTRAINT firmware_releases_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE) ENGINE=InnoDB");
    try { await db.execute("ALTER TABLE firmware_releases ADD COLUMN notes VARCHAR(280) NOT NULL DEFAULT ''"); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
    try { await db.execute("ALTER TABLE firmware_releases ADD COLUMN target_model VARCHAR(120) NOT NULL DEFAULT 'Todos los dispositivos' AFTER version"); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
    await db.execute("CREATE TABLE IF NOT EXISTS firmware_files (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, release_id BIGINT UNSIGNED NOT NULL, name VARCHAR(80) NOT NULL, content MEDIUMBLOB NOT NULL, sha256 CHAR(64) NOT NULL, UNIQUE KEY firmware_release_file (release_id, name), CONSTRAINT firmware_files_release_fk FOREIGN KEY (release_id) REFERENCES firmware_releases(id) ON DELETE CASCADE) ENGINE=InnoDB");
  })();
  return schemaReady;
}

async function apiReady(request, response, next) {
  try { await ensureSchema(); next(); }
  catch (error) { console.error(error.message); fail(response, 503, error.message === 'Database environment is not configured' ? error.message : 'Database connection failed'); }
}

function userPayload(user) {
  return { name: user.name, email: user.email, role: user.role.charAt(0).toUpperCase() + user.role.slice(1) };
}

function hashPassword(password) {
  return new Promise((resolve, reject) => require('crypto').scrypt(password, 'pulsegrid', 64, (error, key) => error ? reject(error) : resolve(key.toString('hex'))));
}

app.get('/api/me', (request, response) => response.json({ user: request.session.user || null }));

app.post('/api/register', apiReady, async (request, response) => {
  const { name = '', email = '', password = '' } = request.body || {};
  if (name.trim().length < 2 || !/^\S+@\S+\.\S+$/.test(email) || password.length < 8) return fail(response, 422, 'Nombre, correo valido y contrasena de 8 caracteres son obligatorios');
  try {
    const [result] = await database().execute('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)', [name.trim(), email.trim().toLowerCase(), await bcrypt.hash(password, 12), 'admin']);
    const user = { id: result.insertId, name: name.trim(), email: email.trim().toLowerCase(), role: 'admin' };
    request.session.user = userPayload(user);
    response.status(201).json({ user: request.session.user });
  } catch (error) { fail(response, error.code === 'ER_DUP_ENTRY' ? 409 : 500, error.code === 'ER_DUP_ENTRY' ? 'Ese correo ya esta registrado' : 'No fue posible crear la cuenta'); }
});

app.post('/api/login', apiReady, async (request, response) => {
  const { email = '', password = '' } = request.body || {};
  const [rows] = await database().execute('SELECT id, name, email, password_hash, role FROM users WHERE email = ? LIMIT 1', [email.trim().toLowerCase()]);
  const user = rows[0];
  if (!user) return fail(response, 401, 'Correo o contrasena incorrectos');
  const usesBcrypt = user.password_hash.startsWith('$2');
  const validPassword = usesBcrypt
    ? await bcrypt.compare(password, user.password_hash)
    : await hashPassword(password) === user.password_hash;
  if (!validPassword) return fail(response, 401, 'Correo o contrasena incorrectos');
  if (!usesBcrypt) await database().execute('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(password, 12), user.id]);
  request.session.user = userPayload(user);
  response.json({ user: request.session.user });
});

app.post('/api/logout', (request, response) => {
  request.session = null;
  response.json({ ok: true });
});

function requireSession(request, response, next) {
  if (!request.session.user) return fail(response, 401, 'Authentication required');
  next();
}

app.get('/api/api-key', requireSession, apiReady, async (request, response) => {
  const [rows] = await database().execute('SELECT key_hint AS hint, created_at AS createdAt, last_used_at AS lastUsedAt FROM api_keys WHERE user_id = (SELECT id FROM users WHERE email = ?) LIMIT 1', [request.session.user.email]);
  response.json({ apiKey: rows[0] || null });
});

app.post('/api/api-key', requireSession, apiReady, async (request, response) => {
  const apiKey = createApiKey();
  const keyHint = `${apiKey.slice(0, 11)}...${apiKey.slice(-4)}`;
  await database().execute('INSERT INTO api_keys (user_id, key_hash, key_hint) VALUES ((SELECT id FROM users WHERE email = ?), ?, ?) ON DUPLICATE KEY UPDATE key_hash = VALUES(key_hash), key_hint = VALUES(key_hint), created_at = CURRENT_TIMESTAMP, last_used_at = NULL', [request.session.user.email, hashApiKey(apiKey), keyHint]);
  response.status(201).json({ apiKey, hint: keyHint });
});

app.get('/api/devices', apiReady, async (request, response) => {
  if (!request.session.user) return fail(response, 401, 'Authentication required');
  const [rows] = await database().execute("SELECT devices.device_id AS id, devices.name, devices.type, devices.provider, devices.capabilities, CASE WHEN devices.provider = 'tuya' THEN devices.status WHEN devices.last_seen IS NOT NULL AND devices.last_seen >= DATE_SUB(NOW(), INTERVAL 90 SECOND) THEN 'online' ELSE 'offline' END AS status, devices.last_seen AS report, (SELECT telemetry.payload FROM telemetry WHERE telemetry.device_id = devices.id ORDER BY telemetry.id DESC LIMIT 1) AS telemetry, (SELECT commands.status FROM commands WHERE commands.device_id = devices.id ORDER BY commands.id DESC LIMIT 1) AS lastCommandStatus, (SELECT commands.error_message FROM commands WHERE commands.device_id = devices.id ORDER BY commands.id DESC LIMIT 1) AS lastCommandError FROM devices WHERE devices.user_id = (SELECT id FROM users WHERE email = ?) ORDER BY devices.created_at DESC", [request.session.user.email]);
  response.json({ devices: rows });
});

app.post('/api/devices', apiReady, async (request, response) => {
  if (!request.session.user) return fail(response, 401, 'Authentication required');
  const { id, name, type } = request.body || {};
  if (!id || !name || !type) return fail(response, 422, 'Device ID, nombre y tipo son obligatorios');
  try {
    const [result] = await database().execute("INSERT INTO devices (user_id, device_id, name, type, status) VALUES ((SELECT id FROM users WHERE email = ?), ?, ?, ?, 'offline')", [request.session.user.email, String(id).trim(), String(name).trim(), String(type).trim()]);
    response.status(201).json({ ok: true, id: result.insertId });
  } catch (error) { fail(response, error.code === 'ER_DUP_ENTRY' ? 409 : 500, error.code === 'ER_DUP_ENTRY' ? 'El Device ID ya existe en este workspace' : 'No fue posible crear el dispositivo'); }
});

app.delete('/api/devices/:deviceId', requireSession, apiReady, async (request, response) => {
  const [result] = await database().execute('DELETE FROM devices WHERE user_id = (SELECT id FROM users WHERE email = ?) AND device_id = ?', [request.session.user.email, String(request.params.deviceId).trim()]);
  if (!result.affectedRows) return fail(response, 404, 'Dispositivo no encontrado');
  response.json({ ok: true });
});

app.get('/api/integrations/tuya/config', requireSession, apiReady, async (request, response) => {
  const [rows] = await database().execute('SELECT client_id AS clientId, endpoint, tuya_user_id AS tuyaUserId, reference_device_id AS referenceDeviceId FROM tuya_connections WHERE user_id = (SELECT id FROM users WHERE email = ?) LIMIT 1', [request.session.user.email]);
  const config = rows[0];
  response.json({ configured: Boolean(config), config: config ? { clientIdHint: `${config.clientId.slice(0, 6)}...${config.clientId.slice(-4)}`, endpoint: config.endpoint, tuyaUserId: config.tuyaUserId || '', referenceDeviceId: config.referenceDeviceId || '' } : null });
});

app.post('/api/integrations/tuya/config', requireSession, apiReady, async (request, response) => {
  try {
    const clientIdInput = String(request.body?.clientId || '').trim();
    const clientSecret = String(request.body?.clientSecret || '').trim();
    const endpoint = tuyaEndpoint(request.body?.endpoint);
    const tuyaUserId = String(request.body?.tuyaUserId || '').trim();
    const referenceDeviceId = String(request.body?.referenceDeviceId || '').trim();
    if ((tuyaUserId && referenceDeviceId) || (!tuyaUserId && !referenceDeviceId)) throw new Error('Indica un usuario o dispositivo de referencia Tuya');
    const userId = await sessionUserId(request.session.user.email);
    const [existing] = await database().execute('SELECT client_id AS clientId, secret_ciphertext AS secretCiphertext FROM tuya_connections WHERE user_id = ? LIMIT 1', [userId]);
    const clientId = clientIdInput || existing[0]?.clientId;
    if (!clientId || clientId.length > 120) throw new Error('Client ID es obligatorio');
    if (!clientSecret && !existing[0]) throw new Error('Client Secret es obligatorio al crear la conexion');
    await database().execute('INSERT INTO tuya_connections (user_id, client_id, secret_ciphertext, endpoint, tuya_user_id, reference_device_id) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE client_id = VALUES(client_id), secret_ciphertext = VALUES(secret_ciphertext), endpoint = VALUES(endpoint), tuya_user_id = VALUES(tuya_user_id), reference_device_id = VALUES(reference_device_id)', [userId, clientId, clientSecret ? encryptTuyaSecret(clientSecret) : existing[0].secretCiphertext, endpoint, tuyaUserId || null, referenceDeviceId || null]);
    tuyaTokens.delete(String(userId));
    response.json({ ok: true });
  } catch (error) { fail(response, 422, error.message); }
});

app.get('/api/integrations/tuya/devices', requireSession, apiReady, async (request, response) => {
  try {
    const devices = await tuyaAccountDevices(await sessionUserId(request.session.user.email));
    response.json({ devices: devices.map((device) => ({ id: device.id, name: device.name || device.product_name || device.id, type: device.category || 'Tuya', productName: device.product_name || '', online: Boolean(device.online) })) });
  } catch (error) { fail(response, 503, error.message); }
});

app.post('/api/integrations/tuya/sync', requireSession, apiReady, async (request, response) => {
  try {
    const result = await syncTuyaDevicesForUser(database(), await sessionUserId(request.session.user.email));
    response.json({ ok: true, ...result });
  } catch (error) { fail(response, 503, error.message); }
});

app.post('/api/integrations/tuya/import', requireSession, apiReady, async (request, response) => {
  const requestedIds = Array.isArray(request.body?.deviceIds) ? [...new Set(request.body.deviceIds.map(String))] : [];
  if (!requestedIds.length) return fail(response, 422, 'Selecciona al menos un dispositivo Tuya');
  try {
    const userId = await sessionUserId(request.session.user.email);
    const accountDevices = await tuyaAccountDevices(userId);
    const selected = accountDevices.filter((device) => requestedIds.includes(String(device.id)));
    if (!selected.length) return fail(response, 404, 'Los dispositivos ya no estan disponibles en Tuya');
    const db = database();
    let limitedControls = 0;
    for (const device of selected) {
      let capabilities = [];
      try {
        const functions = await tuyaRequest(userId, 'GET', `/v1.0/devices/${encodeURIComponent(device.id)}/functions`);
        capabilities = (functions?.functions || []).map(({ code, name, desc, type, values }) => ({ code, name: name || desc || code, type, values }));
      } catch (error) {
        limitedControls += 1;
        console.warn(`Tuya functions unavailable for ${device.id}: ${error.message}`);
      }
      await db.execute("INSERT INTO devices (user_id, device_id, name, type, provider, capabilities, status, last_seen) VALUES ((SELECT id FROM users WHERE email = ?), ?, ?, ?, 'tuya', ?, ?, NOW()) ON DUPLICATE KEY UPDATE name = VALUES(name), type = VALUES(type), provider = 'tuya', capabilities = VALUES(capabilities), status = VALUES(status), last_seen = NOW()", [request.session.user.email, String(device.id), String(device.name || device.product_name || device.id).slice(0, 120), String(device.category || device.product_name || 'Tuya').slice(0, 60), JSON.stringify(capabilities), device.online ? 'online' : 'offline']);
    }
    response.status(201).json({ ok: true, imported: selected.length, limitedControls });
  } catch (error) { fail(response, 503, error.message); }
});

app.get('/api/telemetry', requireSession, apiReady, async (request, response) => {
  const deviceId = String(request.query.deviceId || '').trim();
  if (!deviceId) return fail(response, 422, 'deviceId es obligatorio');
  let from;
  let to;
  try {
    from = telemetryDateParameter(request.query.from, 'Fecha inicial');
    to = telemetryDateParameter(request.query.to, 'Fecha final');
    if (from && to && from > to) throw new Error('La fecha inicial debe ser anterior a la fecha final');
  } catch (error) { return fail(response, 422, error.message); }
  const db = database();
  const [devices] = await db.execute('SELECT id, user_id AS userId, device_id, provider FROM devices WHERE user_id = (SELECT id FROM users WHERE email = ?) AND device_id = ? LIMIT 1', [request.session.user.email, deviceId]);
  if (!devices[0]) return fail(response, 404, 'Dispositivo no encontrado');
  if (devices[0].provider === 'tuya' && request.query.refresh === 'true') {
    try { await syncTuyaDevice(db, devices[0]); } catch (error) { return fail(response, 503, error.message); }
  }
  const conditions = ['telemetry.device_id = ?'];
  const parameters = [devices[0].id];
  if (from) { conditions.push('telemetry.created_at >= ?'); parameters.push(from); }
  if (to) { conditions.push('telemetry.created_at <= ?'); parameters.push(to); }
  const [rows] = await db.execute(`SELECT telemetry.payload, telemetry.created_at AS createdAt FROM telemetry WHERE ${conditions.join(' AND ')} ORDER BY telemetry.created_at DESC, telemetry.id DESC`, parameters);
  response.json({ telemetry: rows.map((row) => ({ ...row, payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload })) });
});

app.post('/api/relay/telemetry', (request, response) => {
  if (!request.get('x-api-key')) return fail(response, 401, 'X-API-Key is required');
  relayCloud(request, response, 'POST', '/api/telemetry');
});

app.get('/api/relay/device-commands', (request, response) => {
  if (!request.get('x-api-key')) return fail(response, 401, 'X-API-Key is required');
  const deviceId = String(request.query.deviceId || '').trim();
  if (!deviceId) return fail(response, 422, 'deviceId es obligatorio');
  relayCloud(request, response, 'GET', `/api/device-commands?deviceId=${encodeURIComponent(deviceId)}`);
});

app.post('/api/relay/device-commands/:commandId/ack', (request, response) => {
  if (!request.get('x-api-key')) return fail(response, 401, 'X-API-Key is required');
  relayCloud(request, response, 'POST', `/api/device-commands/${encodeURIComponent(request.params.commandId)}/ack`);
});

app.get('/api/relay/firmware/manifest', (request, response) => {
  if (!request.get('x-api-key')) return fail(response, 401, 'X-API-Key is required');
  const query = new URLSearchParams();
  if (request.query.version) query.set('version', request.query.version);
  if (request.query.targetModel) query.set('targetModel', request.query.targetModel);
  relayCloud(request, response, 'GET', `/api/firmware/manifest${query.toString() ? `?${query}` : ''}`);
});

app.get('/api/relay/firmware/files/:version/:file', (request, response) => {
  if (!request.get('x-api-key')) return fail(response, 401, 'X-API-Key is required');
  const target = request.query.targetModel ? `?targetModel=${encodeURIComponent(request.query.targetModel)}` : '';
  relayCloud(request, response, 'GET', `/api/firmware/files/${encodeURIComponent(request.params.version)}/${encodeURIComponent(request.params.file)}${target}`);
});

app.post('/api/telemetry', apiReady, async (request, response) => {
  const apiKey = request.get('x-api-key');
  const { deviceId, ...payload } = request.body || {};
  if (!apiKey || !deviceId || Object.keys(payload).length === 0) return fail(response, 422, 'X-API-Key, deviceId y al menos una lectura son obligatorios');
  const db = database();
  const keyOwner = await apiKeyOwner(apiKey);
  if (!keyOwner) return fail(response, 401, 'Invalid API key');
  const [devices] = await db.execute('SELECT id FROM devices WHERE user_id = ? AND device_id = ? LIMIT 1', [keyOwner.user_id, String(deviceId).trim()]);
  if (!devices[0]) return fail(response, 404, 'Device not found for this API key');
  const stored = await storeTelemetryIfChanged(db, devices[0].id, payload);
  await db.execute("UPDATE devices SET status = 'online', last_seen = NOW() WHERE id = ?", [devices[0].id]);
  await db.execute('UPDATE api_keys SET last_used_at = NOW() WHERE key_hash = ?', [hashApiKey(apiKey)]);
  response.status(stored ? 201 : 200).json({ ok: true, stored, unchanged: !stored });
});

app.post('/api/commands', requireSession, apiReady, async (request, response) => {
  const { deviceId, command, payload = {} } = request.body || {};
  if (!deviceId || !command || typeof command !== 'string' || !payload || typeof payload !== 'object' || Array.isArray(payload)) return fail(response, 422, 'Device ID, comando y payload JSON son obligatorios');
  const db = database();
  const [devices] = await db.execute('SELECT id, user_id AS userId, device_id, provider, capabilities FROM devices WHERE user_id = (SELECT id FROM users WHERE email = ?) AND device_id = ? LIMIT 1', [request.session.user.email, String(deviceId).trim()]);
  if (!devices[0]) return fail(response, 404, 'Dispositivo no encontrado');
  try {
    const result = await dispatchDeviceCommand(db, devices[0], command.trim(), payload);
    response.status(201).json({ ok: true, commandId: result.id, status: result.status, troubleshooting: result.troubleshooting || null });
  } catch (error) { response.status(422).json({ error: error.message, troubleshooting: error.troubleshooting || null }); }
});

app.get('/api/automation-troubleshooting', requireSession, apiReady, async (request, response) => {
  const userId = await sessionUserId(request.session.user.email);
  const db = database();
  const [rules] = await db.execute('SELECT id, user_id AS userId, trigger_time AS triggerTime, timezone, weekdays, condition_json AS conditionJson, condition_active AS conditionActive FROM automations WHERE user_id = ?', [userId]);
  const evaluations = await Promise.all(rules.map(async (rule) => {
    const localTime = automationLocalTime(rule.timezone || 'UTC');
    const evaluation = await automationConditionEvaluation(db, rule);
    const onScheduledDay = String(rule.weekdays).split(',').map(Number).includes(localTime.weekday);
    return { ruleId: rule.id, ...evaluation, scheduleMet: onScheduledDay && (rule.triggerTime === 'anytime' || localTime.time === rule.triggerTime), conditionActive: Boolean(rule.conditionActive), evaluatedAt: new Date().toISOString() };
  }));
  response.json({ entries: automationTroubleshooting.get(String(userId)) || [], evaluations });
});

app.get('/api/commands', requireSession, apiReady, async (request, response) => {
  const [rows] = await database().execute('SELECT commands.id, commands.command_name AS command, commands.status, commands.error_message AS errorMessage, commands.created_at AS createdAt, devices.device_id AS deviceId, devices.name AS deviceName FROM commands JOIN devices ON devices.id = commands.device_id WHERE devices.user_id = (SELECT id FROM users WHERE email = ?) ORDER BY commands.created_at DESC LIMIT 20', [request.session.user.email]);
  response.json({ commands: rows });
});

app.get('/api/automations', requireSession, apiReady, async (request, response) => {
  const timezone = request.query.timezone ? automationTimezone(request.query.timezone) : null;
  if (timezone) await database().execute('UPDATE automations SET timezone = ? WHERE user_id = (SELECT id FROM users WHERE email = ?) AND timezone IS NULL', [timezone, request.session.user.email]);
    const [rows] = await database().execute('SELECT automations.id, automations.name, devices.device_id AS deviceId, devices.name AS deviceName, devices.provider, devices.capabilities, automations.trigger_time AS triggerTime, automations.timezone, automations.weekdays, automations.action_name AS action, automations.position, automations.value_source AS valueSource, automations.speed, automations.acceleration, automations.check_interval_seconds AS checkIntervalSeconds, automations.condition_json AS conditionJson, automations.command_name AS commandName, automations.command_payload AS commandPayload, automations.enabled, automations.last_run_at AS lastRunAt FROM automations JOIN devices ON devices.id = automations.device_id WHERE automations.user_id = (SELECT id FROM users WHERE email = ?) ORDER BY automations.trigger_time, automations.id', [request.session.user.email]);
  response.json({ automations: rows.map((rule) => { const storedConditions = typeof rule.conditionJson === 'string' ? JSON.parse(rule.conditionJson) : rule.conditionJson; const conditions = Array.isArray(storedConditions) ? storedConditions : storedConditions ? [storedConditions] : []; return { ...rule, conditions, condition: conditions[0] || null, valueSource: typeof rule.valueSource === 'string' ? JSON.parse(rule.valueSource) : rule.valueSource, commandPayload: typeof rule.commandPayload === 'string' ? JSON.parse(rule.commandPayload) : rule.commandPayload, weekdays: String(rule.weekdays).split(',').map(Number) }; }) });
});

app.post('/api/automations', requireSession, apiReady, async (request, response) => {
  try {
    const rule = automationInput(request.body);
    const db = database();
    const [devices] = await db.execute('SELECT id, user_id AS userId, provider, type, capabilities FROM devices WHERE user_id = (SELECT id FROM users WHERE email = ?) AND device_id = ? LIMIT 1', [request.session.user.email, rule.deviceId]);
    if (!devices[0]) return fail(response, 404, 'Dispositivo no encontrado');
    await validateAutomationDevices(db, request.session.user.email, devices[0], rule);
    const [result] = await db.execute('INSERT INTO automations (user_id, device_id, name, trigger_time, timezone, weekdays, action_name, position, value_source, speed, acceleration, condition_json, check_interval_seconds, command_name, command_payload) VALUES ((SELECT id FROM users WHERE email = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [request.session.user.email, devices[0].id, rule.name, rule.triggerTime, rule.timezone, rule.weekdays.join(','), rule.action, rule.position, rule.valueSource ? JSON.stringify(rule.valueSource) : null, rule.speed, rule.acceleration, rule.conditions.length ? JSON.stringify(rule.conditions) : null, rule.checkIntervalSeconds, rule.commandName, rule.commandPayload ? JSON.stringify(rule.commandPayload) : null]);
    response.status(201).json({ ok: true, id: result.insertId });
  } catch (error) {
    fail(response, 422, error.message);
  }
});

app.patch('/api/automations/:id', requireSession, apiReady, async (request, response) => {
  try {
    const body = request.body || {};
    const db = database();
    if (typeof body.enabled === 'boolean' && Object.keys(body).length === 1) {
      const [result] = await db.execute('UPDATE automations SET enabled = ?, condition_active = 0 WHERE id = ? AND user_id = (SELECT id FROM users WHERE email = ?)', [body.enabled, request.params.id, request.session.user.email]);
      if (!result.affectedRows) return fail(response, 404, 'Automatizacion no encontrada');
      return response.json({ ok: true });
    }
    const rule = automationInput(body);
    const [devices] = await db.execute('SELECT id, user_id AS userId, provider, type, capabilities FROM devices WHERE user_id = (SELECT id FROM users WHERE email = ?) AND device_id = ? LIMIT 1', [request.session.user.email, rule.deviceId]);
    if (!devices[0]) return fail(response, 404, 'Dispositivo no encontrado');
    await validateAutomationDevices(db, request.session.user.email, devices[0], rule);
    const [result] = await db.execute('UPDATE automations SET device_id = ?, name = ?, trigger_time = ?, timezone = ?, weekdays = ?, action_name = ?, position = ?, value_source = ?, speed = ?, acceleration = ?, condition_json = ?, check_interval_seconds = ?, command_name = ?, command_payload = ?, last_checked_at = NULL, last_run_at = NULL, last_run_date = NULL, condition_active = 0 WHERE id = ? AND user_id = (SELECT id FROM users WHERE email = ?)', [devices[0].id, rule.name, rule.triggerTime, rule.timezone, rule.weekdays.join(','), rule.action, rule.position, rule.valueSource ? JSON.stringify(rule.valueSource) : null, rule.speed, rule.acceleration, rule.conditions.length ? JSON.stringify(rule.conditions) : null, rule.checkIntervalSeconds, rule.commandName, rule.commandPayload ? JSON.stringify(rule.commandPayload) : null, request.params.id, request.session.user.email]);
    if (!result.affectedRows) return fail(response, 404, 'Automatizacion no encontrada');
    response.json({ ok: true });
  } catch (error) {
    fail(response, 422, error.message);
  }
});

app.delete('/api/automations/:id', requireSession, apiReady, async (request, response) => {
  const [result] = await database().execute('DELETE FROM automations WHERE id = ? AND user_id = (SELECT id FROM users WHERE email = ?)', [request.params.id, request.session.user.email]);
  if (!result.affectedRows) return fail(response, 404, 'Automatizacion no encontrada');
  response.json({ ok: true });
});

app.get('/api/firmware/releases', requireSession, apiReady, async (request, response) => {
  try {
    response.json({ releases: await readFirmwareReleases(await sessionUserId(request.session.user.email)) });
  } catch (error) {
    fail(response, 500, error.message);
  }
});

app.post('/api/firmware/releases/:version/activate', requireSession, apiReady, async (request, response) => {
  try {
    const userId = await sessionUserId(request.session.user.email);
    const version = firmwareVersion(request.params.version);
    const [existing] = await database().execute('SELECT id FROM firmware_releases WHERE user_id = ? AND version = ? LIMIT 1', [userId, version]);
    if (!existing[0]) return fail(response, 404, 'Firmware release not found');
    const [target] = await database().execute('SELECT target_model AS targetModel FROM firmware_releases WHERE user_id = ? AND version = ? LIMIT 1', [userId, version]);
    await database().execute('UPDATE firmware_releases SET is_active = CASE WHEN version = ? THEN 1 ELSE 0 END WHERE user_id = ? AND target_model = ?', [version, userId, target[0].targetModel]);
    response.json({ release: await readFirmwareManifest(userId, version, target[0].targetModel) });
  } catch (error) {
    fail(response, 422, error.message);
  }
});

app.delete('/api/firmware/releases/:version', requireSession, apiReady, async (request, response) => {
  try {
    const userId = await sessionUserId(request.session.user.email);
    const version = firmwareVersion(request.params.version);
    const [release] = await database().execute('SELECT is_active AS isActive FROM firmware_releases WHERE user_id = ? AND version = ? LIMIT 1', [userId, version]);
    if (!release[0]) return fail(response, 404, 'Firmware release not found');
    if (release[0].isActive) return fail(response, 409, 'Activa otra version antes de eliminar esta release');
    await database().execute('DELETE FROM firmware_releases WHERE user_id = ? AND version = ?', [userId, version]);
    response.json({ ok: true });
  } catch (error) {
    fail(response, 422, error.message);
  }
});

app.post('/api/firmware/releases', requireSession, apiReady, async (request, response) => {
  try {
    const { version, targetModel, whatsNew, files } = request.body || {};
    const safeVersion = newFirmwareVersion(version);
    const safeTargetModel = String(targetModel || 'Todos los dispositivos').trim();
    const safeWhatsNew = String(whatsNew || '').trim();
    if (!safeTargetModel || safeTargetModel.length > 120) return fail(response, 422, 'Modelo objetivo debe contener entre 1 y 120 caracteres');
    if (!safeWhatsNew || safeWhatsNew.length > 280) return fail(response, 422, 'Whats new debe contener entre 1 y 280 caracteres');
    if (!Array.isArray(files) || files.length === 0 || files.length > 20) return fail(response, 422, 'files debe contener entre 1 y 20 archivos');
    const userId = await sessionUserId(request.session.user.email);
    const preparedFiles = files.map((file) => {
      const name = firmwareFileName(file.name);
      if (typeof file.content !== 'string' || file.content.length > 500000) throw new Error('Contenido de firmware invalido');
      const content = file.encoding === 'base64' ? Buffer.from(file.content, 'base64') : Buffer.from(file.content, 'utf8');
      if (!content.length || content.length > 500000) throw new Error('Contenido de firmware invalido');
      return { name, content, size: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex') };
    });
    if (new Set(preparedFiles.map((file) => file.name)).size !== preparedFiles.length) return fail(response, 422, 'No repitas archivos en una version');
    const connection = await database().getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute('DELETE FROM firmware_releases WHERE user_id = ? AND version = ?', [userId, safeVersion]);
      await connection.execute('UPDATE firmware_releases SET is_active = 0 WHERE user_id = ? AND target_model = ?', [userId, safeTargetModel]);
      const [release] = await connection.execute('INSERT INTO firmware_releases (user_id, version, target_model, notes, is_active) VALUES (?, ?, ?, ?, 1)', [userId, safeVersion, safeTargetModel, safeWhatsNew]);
      for (const file of preparedFiles) {
        await connection.execute('INSERT INTO firmware_files (release_id, name, content, sha256) VALUES (?, ?, ?, ?)', [release.insertId, file.name, file.content, file.sha256]);
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    response.status(201).json({ release: await readFirmwareManifest(userId, safeVersion) });
  } catch (error) {
    fail(response, 422, error.message);
  }
});

app.get('/api/firmware/manifest', apiReady, async (request, response) => {
  const keyOwner = await apiKeyOwner(request.get('x-api-key'));
  if (!keyOwner) return fail(response, 401, 'Invalid API key');
  try {
    const manifest = await readFirmwareManifest(keyOwner.user_id, request.query.version, request.query.targetModel);
    if (!manifest) return fail(response, 404, 'Firmware release not found');
    response.json(manifest);
  } catch (error) {
    fail(response, 422, error.message);
  }
});

app.get('/api/firmware/files/:version/:file', apiReady, async (request, response) => {
  const keyOwner = await apiKeyOwner(request.get('x-api-key'));
  if (!keyOwner) return fail(response, 401, 'Invalid API key');
  try {
    const version = firmwareVersion(request.params.version);
    const fileName = firmwareFileName(request.params.file);
    const manifest = await readFirmwareManifest(keyOwner.user_id, version, request.query.targetModel);
    if (!manifest) return fail(response, 404, 'Firmware release not found');
    if (!manifest.files.some((file) => file.name === fileName)) return fail(response, 404, 'Firmware file not found');
    const [files] = await database().execute('SELECT content FROM firmware_files WHERE release_id = ? AND name = ? LIMIT 1', [manifest.id, fileName]);
    response.type('text/plain').send(files[0].content);
  } catch (error) {
    fail(response, 422, error.message);
  }
});

app.get('/api/device-commands', apiReady, async (request, response) => {
  const apiKey = request.get('x-api-key');
  const deviceId = String(request.query.deviceId || '').trim();
  const keyOwner = await apiKeyOwner(apiKey);
  if (!keyOwner) return fail(response, 401, 'Invalid API key');
  if (!deviceId) return fail(response, 422, 'deviceId es obligatorio');
  const db = database();
  const [devices] = await db.execute('SELECT id FROM devices WHERE user_id = ? AND device_id = ? LIMIT 1', [keyOwner.user_id, deviceId]);
  if (!devices[0]) return fail(response, 404, 'Device not found for this API key');
  const [commands] = await db.execute("SELECT id, command_name AS name, payload FROM commands WHERE device_id = ? AND status IN ('queued', 'delivered') ORDER BY created_at ASC LIMIT 1", [devices[0].id]);
  if (!commands[0]) return response.json({ command: null });
  await db.execute("UPDATE commands SET status = 'delivered' WHERE id = ? AND status = 'queued'", [commands[0].id]);
  response.json({ command: { id: commands[0].id, name: commands[0].name, payload: typeof commands[0].payload === 'string' ? JSON.parse(commands[0].payload) : commands[0].payload } });
});

app.post('/api/device-commands/:commandId/ack', apiReady, async (request, response) => {
  const apiKey = request.get('x-api-key');
  const deviceId = String((request.body || {}).deviceId || '').trim();
  const status = (request.body || {}).status;
  const errorMessage = String((request.body || {}).error || '').slice(0, 500) || null;
  const keyOwner = await apiKeyOwner(apiKey);
  if (!keyOwner) return fail(response, 401, 'Invalid API key');
  if (!deviceId || !['succeeded', 'failed'].includes(status)) return fail(response, 422, 'deviceId y estado valido son obligatorios');
  const [result] = await database().execute('UPDATE commands SET status = ?, error_message = ? WHERE id = ? AND device_id = (SELECT id FROM devices WHERE user_id = ? AND device_id = ? LIMIT 1)', [status, status === 'failed' ? errorMessage : null, request.params.commandId, keyOwner.user_id, deviceId]);
  if (!result.affectedRows) return fail(response, 404, 'Comando no encontrado');
  response.json({ ok: true });
});

app.get('/api/version', (request, response) => response.json({ version: cloudVersion }));

app.use(express.static(publicRoot));
app.get('/', (request, response) => response.sendFile(path.join(publicRoot, 'index.html')));
app.all('/api/*splat', (request, response) => fail(response, 404, 'Unknown action'));
app.use((request, response) => response.status(404).send('Not found'));

app.listen(port, () => {
  console.log(`Pulsegrid running on port ${port}`);
  runScheduledAutomations();
  setInterval(runScheduledAutomations, automationSchedulerIntervalMs);
  runTuyaTelemetrySync();
  setInterval(runTuyaTelemetrySync, tuyaSyncIntervalMs);
});
