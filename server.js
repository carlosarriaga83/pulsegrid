const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const https = require('https');
const cloudVersion = require('./package.json').version;

require('dotenv').config({ path: path.join(__dirname, '.env', 'local.env') });

const app = express();
const port = Number(process.env.PORT || 3000);
const root = __dirname;
const publicRoot = path.join(root, 'public');
let pool;
let schemaReady;
let automationTickRunning = false;

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

const firmwareFiles = new Set(['main.py', 'pulsegrid.py', 'webserver.py', 'cortina.py', 'stservo.py', 'ssd1306.py']);

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

function automationAction(action, position) {
  if (action === 'open') return { command: 'curtain.open', payload: {} };
  if (action === 'close') return { command: 'curtain.close', payload: {} };
  if (action === 'position') return { command: 'curtain.move', payload: { servoId: 1, percent: position, speed: 800, acceleration: 50 } };
  throw new Error('Accion de automatizacion invalida');
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

function automationInput(body = {}) {
  const name = String(body.name || '').trim();
  const deviceId = String(body.deviceId || '').trim();
  const triggerTime = String(body.triggerTime || '').trim();
  const action = String(body.action || '').trim();
  const position = Number(body.position);
  const timezone = automationTimezone(body.timezone);
  const weekdays = automationWeekdays(body.weekdays);
  if (!name || name.length > 120 || !deviceId || !/^\d{2}:\d{2}$/.test(triggerTime)) throw new Error('Nombre, dispositivo y hora HH:MM son obligatorios');
  const [hours, minutes] = triggerTime.split(':').map(Number);
  if (hours > 23 || minutes > 59) throw new Error('Hora de automatizacion invalida');
  if (action === 'position' && (!Number.isFinite(position) || position < 0 || position > 100)) throw new Error('La posicion debe estar entre 0 y 100');
  automationAction(action, position);
  return { name, deviceId, triggerTime, action, position: action === 'position' ? position : null, timezone, weekdays };
}

async function runScheduledAutomations() {
  if (automationTickRunning) return;
  automationTickRunning = true;
  try {
    await ensureSchema();
    const db = database();
    const [rules] = await db.execute('SELECT id, device_id AS deviceId, trigger_time AS triggerTime, action_name AS action, position, timezone, weekdays FROM automations WHERE enabled = 1 AND timezone IS NOT NULL');
    for (const rule of rules) {
      const localTime = automationLocalTime(rule.timezone);
      if (localTime.time !== rule.triggerTime || !String(rule.weekdays).split(',').map(Number).includes(localTime.weekday)) continue;
      const [claimed] = await db.execute('UPDATE automations SET last_run_at = NOW(), last_run_date = ? WHERE id = ? AND enabled = 1 AND (last_run_date IS NULL OR last_run_date <> ?)', [localTime.date, rule.id, localTime.date]);
      if (!claimed.affectedRows) continue;
      const action = automationAction(rule.action, rule.position);
      await db.execute('INSERT INTO commands (device_id, command_name, payload) VALUES (?, ?, ?)', [rule.deviceId, action.command, JSON.stringify(action.payload)]);
    }
  } catch (error) {
    console.error('Automation scheduler:', error.message);
  } finally {
    automationTickRunning = false;
  }
}

async function readFirmwareManifest(userId, version) {
  const [releases] = await database().execute(`SELECT id, version, notes AS whatsNew, is_active AS isActive, created_at AS createdAt FROM firmware_releases WHERE user_id = ? ${version ? 'AND version = ?' : 'AND is_active = 1'} ORDER BY created_at DESC LIMIT 1`, version ? [userId, firmwareVersion(version)] : [userId]);
  if (!releases[0]) return null;
  const [files] = await database().execute('SELECT name, OCTET_LENGTH(content) AS size, sha256 FROM firmware_files WHERE release_id = ? ORDER BY name', [releases[0].id]);
  if (!files.length) throw new Error('El manifiesto no contiene archivos');
  files.forEach((file) => firmwareFileName(file.name));
  return { ...releases[0], files };
}

async function readFirmwareReleases(userId) {
  const [releases] = await database().execute('SELECT id, version, notes AS whatsNew, is_active AS isActive, created_at AS createdAt FROM firmware_releases WHERE user_id = ? ORDER BY created_at DESC', [userId]);
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
    await db.execute("CREATE TABLE IF NOT EXISTS devices (id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, user_id INT UNSIGNED NOT NULL, device_id VARCHAR(80) NOT NULL, name VARCHAR(120) NOT NULL, type VARCHAR(60) NOT NULL, status ENUM('online','offline') NOT NULL DEFAULT 'offline', last_seen TIMESTAMP NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY user_device (user_id, device_id), CONSTRAINT devices_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE) ENGINE=InnoDB");
    await db.execute("CREATE TABLE IF NOT EXISTS telemetry (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, device_id INT UNSIGNED NOT NULL, payload JSON NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX telemetry_device (device_id), CONSTRAINT telemetry_device_fk FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE) ENGINE=InnoDB");
    await db.execute("CREATE TABLE IF NOT EXISTS commands (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, device_id INT UNSIGNED NOT NULL, command_name VARCHAR(80) NOT NULL, payload JSON NOT NULL, status VARCHAR(30) NOT NULL DEFAULT 'queued', error_message VARCHAR(500) NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, CONSTRAINT commands_device_fk FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE) ENGINE=InnoDB");
    try { await db.execute('ALTER TABLE commands ADD COLUMN error_message VARCHAR(500) NULL'); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
    await db.execute("CREATE TABLE IF NOT EXISTS automations (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, user_id INT UNSIGNED NOT NULL, device_id INT UNSIGNED NOT NULL, name VARCHAR(120) NOT NULL, trigger_time CHAR(5) NOT NULL, timezone VARCHAR(64) NULL, weekdays VARCHAR(13) NOT NULL DEFAULT '0,1,2,3,4,5,6', action_name ENUM('open','close','position') NOT NULL, position DECIMAL(5,2) NULL, enabled TINYINT(1) NOT NULL DEFAULT 1, last_run_at TIMESTAMP NULL, last_run_date CHAR(10) NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, INDEX automation_schedule (enabled, trigger_time, last_run_date), CONSTRAINT automations_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, CONSTRAINT automations_device_fk FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE) ENGINE=InnoDB");
    try { await db.execute('ALTER TABLE automations ADD COLUMN timezone VARCHAR(64) NULL AFTER trigger_time'); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
    try { await db.execute("ALTER TABLE automations ADD COLUMN weekdays VARCHAR(13) NOT NULL DEFAULT '0,1,2,3,4,5,6' AFTER timezone"); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
    try { await db.execute('ALTER TABLE automations ADD COLUMN last_run_date CHAR(10) NULL AFTER last_run_at'); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
    await db.execute("CREATE TABLE IF NOT EXISTS firmware_releases (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, user_id INT UNSIGNED NOT NULL, version VARCHAR(40) NOT NULL, notes VARCHAR(280) NOT NULL DEFAULT '', is_active TINYINT(1) NOT NULL DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY firmware_user_version (user_id, version), INDEX firmware_active (user_id, is_active), CONSTRAINT firmware_releases_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE) ENGINE=InnoDB");
    try { await db.execute("ALTER TABLE firmware_releases ADD COLUMN notes VARCHAR(280) NOT NULL DEFAULT ''"); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
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
  const [rows] = await database().execute("SELECT devices.device_id AS id, devices.name, devices.type, CASE WHEN devices.last_seen IS NOT NULL AND devices.last_seen >= DATE_SUB(NOW(), INTERVAL 90 SECOND) THEN 'online' ELSE 'offline' END AS status, devices.last_seen AS report, (SELECT telemetry.payload FROM telemetry WHERE telemetry.device_id = devices.id ORDER BY telemetry.id DESC LIMIT 1) AS telemetry FROM devices WHERE devices.user_id = (SELECT id FROM users WHERE email = ?) ORDER BY devices.created_at DESC", [request.session.user.email]);
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

app.get('/api/telemetry', requireSession, apiReady, async (request, response) => {
  const deviceId = String(request.query.deviceId || '').trim();
  const limit = Math.min(Math.max(Number.parseInt(request.query.limit, 10) || 30, 1), 100);
  if (!deviceId) return fail(response, 422, 'deviceId es obligatorio');
  const [rows] = await database().execute('SELECT telemetry.payload, telemetry.created_at AS createdAt FROM telemetry JOIN devices ON devices.id = telemetry.device_id WHERE devices.user_id = (SELECT id FROM users WHERE email = ?) AND devices.device_id = ? ORDER BY telemetry.id DESC LIMIT ?', [request.session.user.email, deviceId, limit]);
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
  const version = request.query.version ? `?version=${encodeURIComponent(request.query.version)}` : '';
  relayCloud(request, response, 'GET', `/api/firmware/manifest${version}`);
});

app.get('/api/relay/firmware/files/:version/:file', (request, response) => {
  if (!request.get('x-api-key')) return fail(response, 401, 'X-API-Key is required');
  relayCloud(request, response, 'GET', `/api/firmware/files/${encodeURIComponent(request.params.version)}/${encodeURIComponent(request.params.file)}`);
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
  await db.execute('INSERT INTO telemetry (device_id, payload) VALUES (?, ?)', [devices[0].id, JSON.stringify(payload)]);
  await db.execute("UPDATE devices SET status = 'online', last_seen = NOW() WHERE id = ?", [devices[0].id]);
  await db.execute('UPDATE api_keys SET last_used_at = NOW() WHERE key_hash = ?', [hashApiKey(apiKey)]);
  response.status(201).json({ ok: true });
});

app.post('/api/commands', requireSession, apiReady, async (request, response) => {
  const { deviceId, command, payload = {} } = request.body || {};
  if (!deviceId || !command || typeof command !== 'string' || !payload || typeof payload !== 'object' || Array.isArray(payload)) return fail(response, 422, 'Device ID, comando y payload JSON son obligatorios');
  const db = database();
  const [devices] = await db.execute('SELECT id FROM devices WHERE user_id = (SELECT id FROM users WHERE email = ?) AND device_id = ? LIMIT 1', [request.session.user.email, String(deviceId).trim()]);
  if (!devices[0]) return fail(response, 404, 'Dispositivo no encontrado');
  const [result] = await db.execute('INSERT INTO commands (device_id, command_name, payload) VALUES (?, ?, ?)', [devices[0].id, command.trim(), JSON.stringify(payload)]);
  response.status(201).json({ ok: true, commandId: result.insertId, status: 'queued' });
});

app.get('/api/commands', requireSession, apiReady, async (request, response) => {
  const [rows] = await database().execute('SELECT commands.id, commands.command_name AS command, commands.status, commands.error_message AS errorMessage, commands.created_at AS createdAt, devices.device_id AS deviceId, devices.name AS deviceName FROM commands JOIN devices ON devices.id = commands.device_id WHERE devices.user_id = (SELECT id FROM users WHERE email = ?) ORDER BY commands.created_at DESC LIMIT 20', [request.session.user.email]);
  response.json({ commands: rows });
});

app.get('/api/automations', requireSession, apiReady, async (request, response) => {
  const timezone = request.query.timezone ? automationTimezone(request.query.timezone) : null;
  if (timezone) await database().execute('UPDATE automations SET timezone = ? WHERE user_id = (SELECT id FROM users WHERE email = ?) AND timezone IS NULL', [timezone, request.session.user.email]);
  const [rows] = await database().execute('SELECT automations.id, automations.name, devices.device_id AS deviceId, devices.name AS deviceName, automations.trigger_time AS triggerTime, automations.timezone, automations.weekdays, automations.action_name AS action, automations.position, automations.enabled, automations.last_run_at AS lastRunAt FROM automations JOIN devices ON devices.id = automations.device_id WHERE automations.user_id = (SELECT id FROM users WHERE email = ?) ORDER BY automations.trigger_time, automations.id', [request.session.user.email]);
  response.json({ automations: rows.map((rule) => ({ ...rule, weekdays: String(rule.weekdays).split(',').map(Number) })) });
});

app.post('/api/automations', requireSession, apiReady, async (request, response) => {
  try {
    const rule = automationInput(request.body);
    const db = database();
    const [devices] = await db.execute('SELECT id FROM devices WHERE user_id = (SELECT id FROM users WHERE email = ?) AND device_id = ? LIMIT 1', [request.session.user.email, rule.deviceId]);
    if (!devices[0]) return fail(response, 404, 'Dispositivo no encontrado');
    const [result] = await db.execute('INSERT INTO automations (user_id, device_id, name, trigger_time, timezone, weekdays, action_name, position) VALUES ((SELECT id FROM users WHERE email = ?), ?, ?, ?, ?, ?, ?, ?)', [request.session.user.email, devices[0].id, rule.name, rule.triggerTime, rule.timezone, rule.weekdays.join(','), rule.action, rule.position]);
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
      const [result] = await db.execute('UPDATE automations SET enabled = ? WHERE id = ? AND user_id = (SELECT id FROM users WHERE email = ?)', [body.enabled, request.params.id, request.session.user.email]);
      if (!result.affectedRows) return fail(response, 404, 'Automatizacion no encontrada');
      return response.json({ ok: true });
    }
    const rule = automationInput(body);
    const [devices] = await db.execute('SELECT id FROM devices WHERE user_id = (SELECT id FROM users WHERE email = ?) AND device_id = ? LIMIT 1', [request.session.user.email, rule.deviceId]);
    if (!devices[0]) return fail(response, 404, 'Dispositivo no encontrado');
    const [result] = await db.execute('UPDATE automations SET device_id = ?, name = ?, trigger_time = ?, timezone = ?, weekdays = ?, action_name = ?, position = ?, last_run_at = NULL, last_run_date = NULL WHERE id = ? AND user_id = (SELECT id FROM users WHERE email = ?)', [devices[0].id, rule.name, rule.triggerTime, rule.timezone, rule.weekdays.join(','), rule.action, rule.position, request.params.id, request.session.user.email]);
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
    await database().execute('UPDATE firmware_releases SET is_active = CASE WHEN version = ? THEN 1 ELSE 0 END WHERE user_id = ?', [version, userId]);
    response.json({ release: await readFirmwareManifest(userId, version) });
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
    const { version, whatsNew, files } = request.body || {};
    const safeVersion = newFirmwareVersion(version);
    const safeWhatsNew = String(whatsNew || '').trim();
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
      await connection.execute('UPDATE firmware_releases SET is_active = 0 WHERE user_id = ?', [userId]);
      const [release] = await connection.execute('INSERT INTO firmware_releases (user_id, version, notes, is_active) VALUES (?, ?, ?, 1)', [userId, safeVersion, safeWhatsNew]);
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
    const manifest = await readFirmwareManifest(keyOwner.user_id, request.query.version);
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
    const manifest = await readFirmwareManifest(keyOwner.user_id, version);
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
  setInterval(runScheduledAutomations, 30 * 1000);
});
