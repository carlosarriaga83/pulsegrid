const path = require('path');
const express = require('express');
const session = require('express-session');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

require('dotenv').config({ path: path.join(__dirname, '.env', 'local.env') });

const app = express();
const port = Number(process.env.PORT || 3000);
const root = __dirname;
const publicRoot = path.join(root, 'public');
let pool;
let schemaReady;

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

function fail(response, status, error) {
  return response.status(status).json({ error });
}

function database() {
  if (pool) return pool;
  const { DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD } = process.env;
  if (!DB_HOST || !DB_NAME || !DB_USER || !DB_PASSWORD) throw new Error('Database environment is not configured');
  pool = mysql.createPool({ host: DB_HOST, port: Number(DB_PORT || 3306), database: DB_NAME, user: DB_USER, password: DB_PASSWORD, waitForConnections: true, connectionLimit: 5, charset: 'utf8mb4' });
  return pool;
}

let sessionTableReady;

function ensureSessionTable() {
  if (!sessionTableReady) sessionTableReady = database().execute("CREATE TABLE IF NOT EXISTS sessions (session_id VARCHAR(128) PRIMARY KEY, data JSON NOT NULL, expires DATETIME NOT NULL, INDEX sessions_expires (expires)) ENGINE=InnoDB");
  return sessionTableReady;
}

class MySqlSessionStore extends session.Store {
  async get(sessionId, callback) {
    try {
      await ensureSessionTable();
      const [rows] = await database().execute('SELECT data FROM sessions WHERE session_id = ? AND expires > NOW()', [sessionId]);
      callback(null, rows[0] ? JSON.parse(rows[0].data) : null);
    } catch (error) { callback(error); }
  }

  async set(sessionId, sessionData, callback) {
    try {
      await ensureSessionTable();
      const expires = sessionData.cookie?.expires ? new Date(sessionData.cookie.expires) : new Date(Date.now() + 1000 * 60 * 60 * 24 * 7);
      await database().execute('INSERT INTO sessions (session_id, data, expires) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data), expires = VALUES(expires)', [sessionId, JSON.stringify(sessionData), expires]);
      callback?.(null);
    } catch (error) { callback?.(error); }
  }

  async destroy(sessionId, callback) {
    try {
      await ensureSessionTable();
      await database().execute('DELETE FROM sessions WHERE session_id = ?', [sessionId]);
      callback?.(null);
    } catch (error) { callback?.(error); }
  }
}

app.use(session({
  name: 'pulsegrid.sid',
  secret: process.env.SESSION_SECRET || 'replace-this-in-hostinger',
  store: new MySqlSessionStore(),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

async function ensureSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const db = database();
    await db.execute("CREATE TABLE IF NOT EXISTS users (id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(120) NOT NULL, email VARCHAR(190) NOT NULL UNIQUE, password_hash VARCHAR(255) NOT NULL, role ENUM('admin','operator','viewer') NOT NULL DEFAULT 'viewer', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB");
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

app.post('/api/logout', (request, response) => request.session.destroy(() => response.json({ ok: true })));

app.get('/api/devices', apiReady, async (request, response) => {
  if (!request.session.user) return fail(response, 401, 'Authentication required');
  const [rows] = await database().execute('SELECT device_id AS id, name, type, status, last_seen AS report FROM devices WHERE user_id = (SELECT id FROM users WHERE email = ?) ORDER BY created_at DESC', [request.session.user.email]);
  response.json({ devices: rows });
});

app.post('/api/devices', apiReady, async (request, response) => {
  if (!request.session.user) return fail(response, 401, 'Authentication required');
  const { id, name, type } = request.body || {};
  if (!id || !name || !type) return fail(response, 422, 'Device ID, nombre y tipo son obligatorios');
  try {
    const [result] = await database().execute("INSERT INTO devices (user_id, device_id, name, type, status, last_seen) VALUES ((SELECT id FROM users WHERE email = ?), ?, ?, ?, 'online', NOW())", [request.session.user.email, String(id).trim(), String(name).trim(), String(type).trim()]);
    response.status(201).json({ ok: true, id: result.insertId });
  } catch (error) { fail(response, error.code === 'ER_DUP_ENTRY' ? 409 : 500, error.code === 'ER_DUP_ENTRY' ? 'El Device ID ya existe en este workspace' : 'No fue posible crear el dispositivo'); }
});

app.use(express.static(publicRoot));
app.get('/', (request, response) => response.sendFile(path.join(publicRoot, 'index.html')));
app.all('/api/*splat', (request, response) => fail(response, 404, 'Unknown action'));
app.use((request, response) => response.status(404).send('Not found'));

app.listen(port, () => console.log(`Pulsegrid running on port ${port}`));
