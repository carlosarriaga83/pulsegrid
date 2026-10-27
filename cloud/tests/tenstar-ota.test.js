const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const version = '2026.10.26.tenstar-r9';
const device = { id: 'T1', name: 'Tenstar', status: 'online', provider: 'pulsegrid', telemetry: { firmwareTarget: 'tenstar', moving: false, calibration: { calibrated: true } } };
const release = { version, targetModel: 'tenstar', isActive: true, files: [{ name: 'main.py' }, { name: 'tenstar_loop.py' }] };

function slice(source, first, next) {
  const start = source.indexOf(first);
  const end = source.indexOf(next, start);
  assert.ok(start >= 0 && end > start, `Missing ${first}`);
  return source.slice(start, end);
}

function frontend(folder, t) {
  const source = fs.readFileSync(path.join(root, folder, 'app.js'), 'utf8');
  const dom = new JSDOM('', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom;
  const requests = [];
  const notices = [];
  const context = dom.getInternalVMContext();
  Object.assign(window, {
    $: (selector) => window.document.querySelector(selector),
    $$: (selector) => [...window.document.querySelectorAll(selector)],
    parseTelemetry: (value) => typeof value === 'string' ? JSON.parse(value) : value || {},
    renderIcons: () => {},
    loadFirmwareReleases: async () => {},
    loadCommandHistory: async () => {},
    loadDevices: async () => {},
    showToast: (text) => notices.push(text),
    firmwareFilePayload: async (file) => ({ name: file.name, content: 'cHJpbnQoMSk=', encoding: 'base64' }),
    apiRequest: async (endpoint, options) => {
      if (options?.method === 'POST') {
        requests.push({ endpoint, ...JSON.parse(options.body) });
        return { release };
      }
      if (endpoint === 'devices') return { devices: [{ ...device, telemetry: { ...device.telemetry, firmwareVersion: version } }] };
      return { releases: [release] };
    },
    executeTrackedDeviceCommand: async (...args) => { requests.push(args); return { status: 'succeeded' }; }
  });
  window.confirm = () => true;
  window.setTimeout = (callback) => { callback(); return 1; };
  vm.runInContext(slice(source, 'function ensureFirmwareBypass(', 'function automationsViewMarkup('), context);
  vm.runInContext(slice(source, 'function bindFirmwareViewControls(', 'function setupFirmwareView('), context);
  vm.runInContext(slice(source, 'async function waitForTenstarFirmware(', 'function openDeviceMenu('), context);
  window.document.body.innerHTML = window.firmwareViewMarkup();
  return { window, requests, notices, source };
}

for (const folder of ['', 'public', 'public_html', 'legacy-root']) {
  test(`${folder || 'root'}: publishes a Tenstar release and sends only the OTA command`, async (t) => {
    const f = frontend(folder, t);
    const { window } = f;
    window.bindFirmwareViewControls();
    const $ = (selector) => window.document.querySelector(selector);
    $('#firmware-release-target').value = 'tenstar';
    $('#firmware-release-target').dispatchEvent(new window.Event('change'));
    assert.equal($('#firmware-release-bypass').disabled, true);
    assert.match($('[data-firmware-help]').textContent, /sin COM ni USB/);
    $('#firmware-release-version').value = version;
    assert.equal($('#firmware-release-version').validity.patternMismatch, false);
    $('#firmware-release-version').value = 'invalid';
    assert.equal($('#firmware-release-version').validity.patternMismatch, true);
    $('#firmware-release-version').value = version;
    $('#firmware-release-whats-new').value = 'OTA Tenstar';
    Object.defineProperty($('#firmware-release-files'), 'files', { value: [{ name: 'main.py' }, { name: 'tenstar_loop.py' }] });
    $('#firmware-release-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await new Promise(setImmediate);
    assert.equal(f.requests[0].endpoint, 'firmware/releases');
    assert.equal(f.requests[0].targetModel, 'tenstar');
    assert.equal(f.requests[0].bypassFileRestriction, false);
    assert.equal(f.requests[0].files[1].name, 'tenstar_loop.py');
    await window.queueFirmwareUpdate(device);
    assert.equal(f.requests[1][0], 'T1');
    assert.equal(f.requests[1][1], 'firmware.update');
    assert.deepEqual(JSON.parse(JSON.stringify(f.requests[1][2])), { version, targetModel: 'tenstar' });
    assert.equal(f.requests[1][3].timeoutMs, 600000);
    assert.match(f.notices.at(-1), /completada/);
    assert.equal((f.source.match(/option value="tenstar"/g) || []).length, 2);
  });
}

test('Tenstar OTA rejects offline, moving, unknown motion and active calibration; cancel sends nothing', async (t) => {
  const f = frontend('public', t);
  for (const updated of [
    { ...device, status: 'offline' },
    { ...device, telemetry: { ...device.telemetry, moving: true } },
    { ...device, telemetry: { firmwareTarget: 'tenstar' } },
    { ...device, telemetry: { ...device.telemetry, calibration: { active: true } } }
  ]) await assert.rejects(f.window.queueFirmwareUpdate(updated), /Tenstar/);
  f.window.confirm = () => false;
  await f.window.queueFirmwareUpdate(device);
  assert.equal(f.requests.length, 0);
});

test('Tenstar OTA never selects archived or generic releases and reports download/boot errors', async (t) => {
  const f = frontend('public', t);
  f.window.apiRequest = async () => ({ releases: [{ ...release, isActive: false }, { ...release, targetModel: 'Todos los dispositivos' }] });
  await assert.rejects(f.window.queueFirmwareUpdate(device), /No hay/);
  f.window.apiRequest = async () => ({ releases: [release] });
  f.window.executeTrackedDeviceCommand = async () => ({ status: 'failed', errorMessage: 'TLS ENOMEM' });
  f.window.trackedCommandMessage = (record) => record.errorMessage;
  await f.window.queueFirmwareUpdate(device);
  assert.equal(f.notices.at(-1), 'TLS ENOMEM');
  f.window.executeTrackedDeviceCommand = async () => ({ status: 'succeeded' });
  let now = 0;
  f.window.Date.now = () => { now += 45000; return now; };
  await assert.rejects(f.window.queueFirmwareUpdate(device), /no confirmó/);
  assert.equal(f.notices.some((message) => message.includes('completada')), false);
});

function backend(extra = {}) {
  const context = vm.createContext({ ...extra });
  vm.runInContext(slice(server, 'const firmwareFiles =', 'function automationAction('), context);
  vm.runInContext(slice(server, 'async function dispatchDeviceCommand(', 'function validateTenstarCommand('), context);
  return context;
}

test('Tenstar OTA allowlist matches the firmware manifest and never permits config/state or another profile', () => {
  const b = backend();
  const main = fs.readFileSync(path.join(root, '..', 'dispositivos', 'tenstar', 'main.py'), 'utf8');
  const manifest = main.match(/FIRMWARE_FILES = \(([^)]*)\)/)[1];
  const files = [...manifest.matchAll(/'([^']+)'/g)].map((item) => ({ name: item[1] }));
  assert.doesNotThrow(() => b.validateTenstarFirmwareFiles(files));
  for (const name of ['config.py', 'tenstar_calibration.json', 'tenstar_calibration.json.0', 'tenstar_calibration.json.moving', 'pulsegrid_firmware.py', 'stservo.py']) {
    assert.throws(() => b.validateTenstarFirmwareFiles([{ name }]), /no compatible/);
  }
});

test('backend queues OTA only for a recent, stopped Tenstar with an owned, active, compatible release', async () => {
  let telemetry = { ...device.telemetry, online: true };
  let lastSeen = new Date();
  let manifest = structuredClone(release);
  const inserted = [];
  const db = { execute: async (sql, args) => {
    if (sql.startsWith('SELECT telemetry.payload')) return [[{ payload: JSON.stringify(telemetry), lastSeen }]];
    if (sql.startsWith('INSERT INTO commands')) { inserted.push(args); return [{ insertId: 99 }]; }
    throw new Error(sql);
  } };
  const b = backend({ readFirmwareManifest: async (userId, requested, target) => {
    assert.equal(userId, 42);
    assert.equal(requested, version);
    assert.equal(target, 'tenstar');
    return manifest;
  } });
  const commandDevice = { id: 8, userId: 42, provider: 'pulsegrid' };
  const payload = { version, targetModel: 'tenstar' };
  await b.dispatchDeviceCommand(db, commandDevice, 'firmware.update', payload);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0][1], 'firmware.update');
  for (const change of [{ moving: true }, { moving: undefined }, { calibration: { active: true } }, { online: false }]) {
    telemetry = { ...device.telemetry, online: true, ...change };
    await assert.rejects(b.dispatchDeviceCommand(db, commandDevice, 'firmware.update', payload));
  }
  telemetry = { ...device.telemetry, online: true };
  lastSeen = new Date(Date.now() - 30000);
  await assert.rejects(b.dispatchDeviceCommand(db, commandDevice, 'firmware.update', payload), /reciente/);
  lastSeen = new Date();
  for (const bad of [null, { ...release, isActive: false }, { ...release, files: [{ name: 'stservo.py' }] }]) {
    manifest = bad;
    await assert.rejects(b.dispatchDeviceCommand(db, commandDevice, 'firmware.update', payload));
  }
  manifest = release;
  for (const bad of [{}, { ...payload, targetModel: 'servo' }, { ...payload, version: '../bad' }, { ...payload, unsafe: true }]) {
    await assert.rejects(b.dispatchDeviceCommand(db, commandDevice, 'firmware.update', bad));
  }
  assert.equal(inserted.length, 1);
});

test('publication endpoint rejects incompatible Tenstar files even with bypass enabled', async () => {
  const routes = new Map();
  const b = backend({
    crypto, Buffer, app: { post: (url, ...handlers) => routes.set(url, handlers.at(-1)) },
    requireSession() {}, apiReady() {}, sessionUserId: async () => 42,
    fail: (response, status, error) => response.status(status).json({ error }),
    database: () => { throw new Error('Rejected files must not open a transaction'); }
  });
  vm.runInContext(slice(server, "app.post('/api/firmware/releases'", "app.get('/api/firmware/manifest'"), b);
  const handler = routes.get('/api/firmware/releases');
  for (const name of ['config.py', 'stservo.py', 'tenstar_calibration.json.0']) {
    const response = { status(code) { this.code = code; return this; }, json(value) { this.value = value; } };
    await handler({ session: { user: { email: 'test@example.test' } }, body: { version, targetModel: 'tenstar', whatsNew: 'OTA', bypassFileRestriction: true, files: [{ name, content: 'test' }] } }, response);
    assert.equal(response.code, 422);
    assert.match(response.value.error, /no compatible/);
  }
});

test('publication endpoint stores Tenstar file bytes/checksums transactionally and returns its manifest', async () => {
  const routes = new Map();
  const queries = [];
  const events = [];
  const connection = {
    beginTransaction: async () => events.push('begin'),
    commit: async () => events.push('commit'),
    rollback: async () => events.push('rollback'),
    release: () => events.push('release'),
    execute: async (sql, args) => { queries.push({ sql, args }); return [{ insertId: 7 }]; }
  };
  const b = backend({
    crypto, Buffer, app: { post: (url, ...handlers) => routes.set(url, handlers.at(-1)) },
    requireSession() {}, apiReady() {}, sessionUserId: async () => 42,
    fail: (response, status, error) => response.status(status).json({ error }),
    database: () => ({ getConnection: async () => connection }),
    readFirmwareManifest: async (userId, requested) => {
      assert.equal(userId, 42);
      assert.equal(requested, version);
      return release;
    }
  });
  vm.runInContext(slice(server, "app.post('/api/firmware/releases'", "app.get('/api/firmware/manifest'"), b);
  const content = Buffer.from('print("Tenstar OTA")\n', 'utf8');
  const response = { status(code) { this.code = code; return this; }, json(value) { this.value = value; } };
  await routes.get('/api/firmware/releases')({
    session: { user: { email: 'test@example.test' } },
    body: { version, targetModel: 'tenstar', whatsNew: 'OTA', files: [{ name: 'main.py', content: content.toString('base64'), encoding: 'base64' }] }
  }, response);
  assert.equal(response.code, 201, JSON.stringify(response.value));
  assert.equal(response.value.release, release);
  assert.deepEqual(events, ['begin', 'commit', 'release']);
  const stored = queries.find(({ sql }) => sql.startsWith('INSERT INTO firmware_files')).args;
  assert.equal(stored[1], 'main.py');
  assert.deepEqual(stored[2], content);
  assert.equal(stored[3], crypto.createHash('sha256').update(content).digest('hex'));
});
