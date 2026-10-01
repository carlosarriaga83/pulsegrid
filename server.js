const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const https = require('https');

require('dotenv').config({ path: path.join(__dirname, '.env', 'local.env') });

const app = express();
const port = Number(process.env.PORT || 3000);
const root = __dirname;
const publicRoot = path.join(root, 'public');
let pool;
let schemaReady;

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));

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
    await db.execute("CREATE TABLE IF NOT EXISTS commands (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, device_id INT UNSIGNED NOT NULL, command_name VARCHAR(80) NOT NULL, payload JSON NOT NULL, status VARCHAR(30) NOT NULL DEFAULT 'queued', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, CONSTRAINT commands_device_fk FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE) ENGINE=InnoDB");
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
  const [rows] = await database().execute('SELECT commands.id, commands.command_name AS command, commands.status, commands.created_at AS createdAt, devices.device_id AS deviceId, devices.name AS deviceName FROM commands JOIN devices ON devices.id = commands.device_id WHERE devices.user_id = (SELECT id FROM users WHERE email = ?) ORDER BY commands.created_at DESC LIMIT 20', [request.session.user.email]);
  response.json({ commands: rows });
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
  const keyOwner = await apiKeyOwner(apiKey);
  if (!keyOwner) return fail(response, 401, 'Invalid API key');
  if (!deviceId || !['succeeded', 'failed'].includes(status)) return fail(response, 422, 'deviceId y estado valido son obligatorios');
  const [result] = await database().execute('UPDATE commands SET status = ? WHERE id = ? AND device_id = (SELECT id FROM devices WHERE user_id = ? AND device_id = ? LIMIT 1)', [status, request.params.commandId, keyOwner.user_id, deviceId]);
  if (!result.affectedRows) return fail(response, 404, 'Comando no encontrado');
  response.json({ ok: true });
});

app.use(express.static(publicRoot));
app.get('/', (request, response) => response.sendFile(path.join(publicRoot, 'index.html')));
app.all('/api/*splat', (request, response) => fail(response, 404, 'Unknown action'));
app.use((request, response) => response.status(404).send('Not found'));

app.listen(port, () => console.log(`Pulsegrid running on port ${port}`));
