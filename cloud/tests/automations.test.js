const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const model = require('../automation-model');
const openMeteo = require('../open-meteo');
const blindCalibrationModel = require('../blind-calibration-model');
const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
// Evaluate only declarations, never server startup, dotenv, timers or a real database.
function backend(extra = {}) {
  const context = vm.createContext({ AutomationModel: model, BlindCalibrationModel: blindCalibrationModel, OpenMeteo: openMeteo, Intl, Date, console, ...extra });
  const injectedDispatch = extra.dispatchDeviceCommand;
  vm.runInContext(server.slice(server.indexOf('function automationAction('), server.indexOf('async function readFirmwareManifest(')), context);
  vm.runInContext(server.slice(server.indexOf('function validateTuyaCommand('), server.indexOf('async function dispatchDeviceCommand(')), context);
  vm.runInContext(server.slice(server.indexOf('function validateDirectionConfiguration('), server.indexOf('async function validateAutomationDevices(')), context);
  vm.runInContext(server.slice(server.indexOf('async function dispatchDeviceCommand('), server.indexOf('async function syncTuyaDevice(')), context);
  if (injectedDispatch) context.dispatchDeviceCommand = injectedDispatch;
  return context;
}
const power = { id: 'A', name: 'Power meter A', telemetry: JSON.stringify({ Power: 500, zero: 0, status: { Led1: false, mode: '001' } }), capabilities: [{ code: 'Power', name: 'Power', type: 'Integer' }] };
const led = { id: 'B', name: 'Device B', provider: 'tuya', capabilities: [{ code: 'Led1', name: 'Led1', type: 'Boolean' }] };
const param = (path = 'Power', value = 500, operator = 'eq') => ({ deviceId: 'A', path, operator, value });
const command = (overrides = {}) => ({ kind: 'command', deviceId: 'B', commandName: 'tuya.set', commandCode: 'Led1', commandField: 'value', operator: 'eq', value: true, ...overrides });
const input = (overrides = {}) => ({ name: 'Power -> Led1', deviceId: 'B', triggerTime: '12:00', timezone: 'UTC', weekdays: [0, 1, 2, 3, 4, 5, 6], action: 'open', commandName: 'tuya.set', commandPayload: { code: 'Led1', value: true }, conditions: [param()], ...overrides });

test('frontend derives Power, nested booleans, zero and strings, without invented fields', () => {
  const options = model.parameters(power);
  assert.deepEqual(options.map((item) => item.value), ['Power', 'zero', 'status.Led1', 'status.mode']);
  assert.equal(options[0].label, 'Power');
  for (const [key, raw, expected] of [['Power', '500', 500], ['zero', '0', 0], ['status.Led1', 'false', false], ['status.mode', '001', '001']]) {
    assert.equal(model.typedValue(raw, options.find((item) => item.value === key)), expected);
  }
  assert.deepEqual(model.parameters({}), []);
  assert.deepEqual(model.parameters({ telemetry: JSON.parse('{"constructor":1,"__proto__":{"Power":1},"status":{"prototype":3,"ok":true}}') }).map((item) => item.value), ['status.ok']);
});

test('frontend writable capabilities and command options are device-dependent', () => {
  assert.equal(model.typedValue('true', model.writable(led)[0]), true);
  assert.deepEqual(model.writable(power), []);
  assert.deepEqual(model.commands(power), []);
  assert.deepEqual(model.commands({ provider: 'pulsegrid', type: 'Controlador', telemetry: { Led1: true } }), []);
  assert.equal(model.commands({ telemetry: { kind: 'curtain' } }, true)[0].commandName, 'curtain.open');
  assert.match(model.commands(led, true)[0].label, /ultimo valor enviado/);
});

test('typed number, enum and boolean validation preserves types and rejects invalid values', () => {
  const number = model.metadata({ type: 'Integer', values: '{"min":0,"max":10,"step":2}' });
  for (const raw of ['', 'abc', '11', '1.5', '3']) assert.throws(() => model.typedValue(raw, number));
  assert.equal(model.typedValue('0', number), 0);
  const enumeration = model.metadata({ type: 'Enum', values: '{"range":["0","off"]}' });
  assert.equal(model.typedValue('0', enumeration), '0');
  assert.throws(() => model.typedValue('bad', enumeration));
  assert.throws(() => model.typedValue('0', { type: 'boolean' }));
});

test('backend validates exclusive shapes, dangerous paths and preserves legacy rules', () => {
  const b = backend();
  assert.equal(b.automationCondition(param()).kind, 'parameter');
  assert.equal(b.automationInput(input()).commandPayload.value, true);
  assert.equal(b.automationInput(input({ action: 'open', commandName: '', commandPayload: null, conditions: [] })).speed, 1800); // Default Servo wheel speed; NOT NULL database column.
  assert.deepEqual(JSON.parse(JSON.stringify(b.automationAction('position', 65, 210, 45))), { command: 'curtain.move', payload: { servoId: 1, percent: 65, speed: 210, acceleration: 45 } });
  assert.equal(b.automationInput(input({ checkIntervalSeconds: 5 })).checkIntervalSeconds, 5);
  assert.equal(b.automationInput(input()).checkIntervalSeconds, 30);
  assert.throws(() => b.automationInput(input({ action: 'open', commandName: '', commandPayload: null, conditions: [], speed: 0 })), /Velocidad debe estar entre 1 y 1800/);
  assert.throws(() => b.automationInput(input({ checkIntervalSeconds: 4 })));
  assert.equal(b.automationConditions(undefined, param())[0].path, 'Power');
  for (const value of [param('__proto__.x'), param('status.constructor.x'), param('a..b'), param('Power', NaN), { ...param(), commandName: 'tuya.set' }, { ...command(), path: 'Power' }, command({ commandCode: undefined }), command({ commandField: 'status' }), { ...param(), kind: 'other' }]) assert.throws(() => b.automationCondition(value));
  assert.throws(() => b.automationConditions({}));
  assert.throws(() => b.automationConditions([null]));
  assert.throws(() => b.automationInput(input({ commandPayload: { code: 'Led1', value: true, extra: 1 } })));
  assert.equal(b.automationConditionValue({ status: { Led1: false } }, 'status.Led1'), false);
  assert.equal(b.automationConditionValue({}, 'constructor'), undefined);
  assert.equal(b.automationConditionValue(Object.create({ Power: 500 }), 'Power'), undefined);
});

test('backend exact equality, boolean false, zero and all six legacy operators', () => {
  const b = backend();
  for (const [operator, expected, result] of [['eq', 500, true], ['neq', 501, true], ['gt', 499, true], ['gte', 500, true], ['lt', 501, true], ['lte', 500, true]]) assert.equal(b.automationConditionMatches(param('Power', expected, operator), { Power: 500 }), result);
  assert.equal(b.automationConditionMatches(param('Power', '500'), { Power: 500 }), false);
  assert.equal(b.automationConditionMatches(param('Power', false), { Power: false }), true);
  assert.equal(b.automationConditionMatches(param('Power', 0), { Power: 0 }), true);
  assert.equal(b.automationConditionMatches(param(), {}), false);
  assert.equal(b.automationConditionMatches(param('Power', 2, 'unknown'), { Power: 1 }), false);
  assert.equal(b.automationSourceValue({ provider: 'tuya', status: { bright_value_1: 63 } }, 'bright_value_1'), 63);
});

test('Tuya command condition reads last code-filtered payload.value, never dispatches', async () => {
  const b = backend(); const calls = [];
  const db = { execute: async (sql, args) => { calls.push([sql, args]); return [[{ payload: '{"code":"Led1","value":false}', status: 'failed' }]]; } };
  assert.equal(await b.automationConditionIsMet(db, { userId: 7, conditionJson: [command({ value: false })] }), true);
  assert.match(calls[0][0], /JSON_UNQUOTE\(JSON_EXTRACT\(payload, '\$\.code'\)\) = \?/);
  assert.match(calls[0][0], /user_id = \?/);
  assert.match(calls[0][0], /ORDER BY created_at DESC, id DESC LIMIT 1/);
  assert.deepEqual(Array.from(calls[0][1]), ['B', 7, 'tuya.set', 'Led1']);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0][0], /INSERT|UPDATE/);
});

test('native command condition compares recorded status string, missing commands fail closed', async () => {
  const b = backend();
  const condition = { kind: 'command', deviceId: 'curtain', commandName: 'curtain.open', commandField: 'status', operator: 'eq', value: 'succeeded' };
  const calls = [];
  assert.equal(await b.automationConditionIsMet({ execute: async (sql, args) => { calls.push([sql, args]); return [[{ status: 'succeeded', payload: '{}' }]]; } }, { userId: 9, conditionJson: JSON.stringify(condition) }), true);
  assert.deepEqual(Array.from(calls[0][1]), ['curtain', 9, 'curtain.open']);
  assert.doesNotMatch(calls[0][0], /JSON_EXTRACT/);
  assert.equal(await b.automationConditionIsMet({ execute: async () => [[]] }, { userId: 9, conditionJson: [condition] }), false);
  assert.throws(() => b.automationCondition({ ...condition, operator: 'gt' }));
});

test('multi-condition AND combines legacy telemetry and command history with short circuit', async () => {
  const b = backend(); let queries = 0;
  const db = { execute: async (sql, args) => { queries++; assert.equal(args[1], 5); return [[sql.includes('FROM telemetry') ? { payload: { Power: 500 } } : { payload: { value: true } }]]; } };
  assert.equal(await b.automationConditionIsMet(db, { userId: 5, conditionJson: [param(), command()] }), true);
  assert.equal(queries, 2);
  queries = 0;
  assert.equal(await b.automationConditionIsMet(db, { userId: 5, conditionJson: [param('Power', 501), command()] }), false);
  assert.equal(queries, 1);
  assert.equal(await b.automationConditionIsMet(db, { conditionJson: null }), true);
  assert.equal(await b.automationConditionIsMet(db, { userId: 5, conditionJson: JSON.stringify(param()) }), true);
});

test('ownership and capability validation reject non-owned sources and bad assignments', async () => {
  const b = backend();
  assert.throws(() => b.validateTuyaCommand(led, 'tuya.set', { code: 'Led1', value: 'true' }));
  assert.throws(() => b.validateTuyaCommand(led, 'tuya.set', { code: 'Power', value: 500 }));
  assert.throws(() => b.validateTuyaCommand({ ...led, provider: 'pulsegrid' }, 'tuya.set', { code: 'Led1', value: true }));
  const calls = [];
  await assert.rejects(b.validateAutomationDevices({ execute: async (sql, args) => { calls.push([sql, args]); return [[]]; } }, 'owner@example.test', led, b.automationInput(input())), /condicion no encontrado/);
  assert.match(calls[0][0], /user_id = \(SELECT id FROM users WHERE email = \?\)/);
  assert.deepEqual(Array.from(calls[0][1]), ['owner@example.test', 'A']);
  await assert.rejects(b.validateAutomationDevices({ execute: async () => [[]] }, 'owner@example.test', { id: 3, type: 'Sensor' }, { conditions: [], action: 'open' }), /protocolo de cortina/);
});

test('scheduler retains time/day gate and once-per-local-date claim before dispatch', async () => {
  const calls = []; const dispatched = [];
  const rule = { id: 1, userId: 7, deviceId: 3, timezone: 'UTC', weekdays: '3', triggerTime: '12:00', action: 'open', speed: 800, acceleration: 50, conditionJson: [param()] };
  let claimed = false;
  const db = { execute: async (sql, args) => {
    calls.push(sql);
    if (sql.startsWith('SELECT id, user_id AS userId, device_id')) return [[rule, { ...rule, id: 2, triggerTime: '13:00' }, { ...rule, id: 3, weekdays: '1' }]];
    if (sql.includes('FROM telemetry')) return [[{ payload: { Power: 500 } }]];
    if (sql.includes('last_checked_at = NOW()')) return [{ affectedRows: 1 }];
    if (sql.startsWith('UPDATE automations')) { assert.equal(args[0], '2026-10-07'); const affectedRows = claimed ? 0 : 1; claimed = true; return [{ affectedRows }]; }
    if (sql.includes('FROM devices')) return [[{ id: 3, userId: 7 }]];
    throw new Error(sql);
  } };
  const b = backend({ automationTickRunning: false, ensureSchema: async () => {}, database: () => db, dispatchDeviceCommand: async (...args) => dispatched.push(args) });
  b.automationLocalTime = () => ({ date: '2026-10-07', time: '12:00', weekday: 3 });
  await b.runScheduledAutomations(); await b.runScheduledAutomations();
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0][2], 'curtain.open');
  assert.equal(calls.filter((sql) => sql.includes('FROM telemetry')).length, 2);
  assert.ok(calls.some((sql) => sql.includes('last_checked_at <= DATE_SUB(NOW(), INTERVAL check_interval_seconds SECOND)')));
});


  test('user Tuya command dispatch uses the selected device ID alias in the OpenAPI URL', async () => {
    const requested = [];
    const calls = [];
    const db = {
      async execute(sql, params) {
        calls.push({ sql, params });
        if (sql.startsWith('SELECT id, user_id AS userId, device_id AS deviceId')) {
          return [[{ id: 7, userId: 42, deviceId: 'tuya-current-device', provider: 'tuya', capabilities: [{ code: 'switch', type: 'Boolean' }] }], []];
        }
        if (sql.startsWith('INSERT INTO commands')) return [{ insertId: 19 }, []];
        return [{ affectedRows: 1 }, []];
      }
    };
    const b = backend({
      tuyaRequestRaw: async (userId, method, url, payload) => {
        requested.push({ userId, method, url, payload });
        return { response: { success: true } };
      },
      recordAutomationTroubleshooting: () => {}
    });
    const result = await b.queueUserDeviceCommand(db, 'person@example.com', 'tuya-current-device', 'tuya.set', { code: 'switch', value: true });
    assert.equal(result.status, 'succeeded');
    assert.equal(requested[0].url, '/v1.0/devices/tuya-current-device/commands');
    assert.deepEqual(JSON.parse(JSON.stringify(requested[0].payload)), { commands: [{ code: 'switch', value: true }] });
    assert.equal(requested[0].userId, 42);
  });
test('anytime schedule dispatches each tick while conditions are met', async () => {
  const b = backend();
  assert.equal(b.automationInput(input({ triggerTime: 'anytime' })).triggerTime, 'anytime');
  const calls = []; const dispatched = [];
  const rule = { id: 11, userId: 7, deviceId: 3, timezone: 'UTC', weekdays: '3', triggerTime: 'anytime', action: 'open', speed: 800, acceleration: 50, conditionJson: [param()] };
  const readings = [500, 500, 0, 0, 500, 500];
  let readingIndex = 0;
  const db = { execute: async (sql, args) => {
    calls.push(sql);
    if (sql.startsWith('SELECT id, user_id AS userId, device_id')) return [[rule]];
    if (sql.includes('FROM telemetry')) { const value = readings[Math.min(readingIndex++, readings.length - 1)]; return [[{ payload: { Power: value } }]]; }
    if (sql.includes('last_checked_at = NOW()')) return [{ affectedRows: 1 }];
    if (sql.startsWith('UPDATE automations SET last_run_at = NOW(), condition_active = 0')) return [{ affectedRows: 1 }];
    if (sql.includes('FROM devices')) return [[{ id: 3, userId: 7 }]];
    throw new Error(sql);
  } };
  const context = backend({ automationTickRunning: false, ensureSchema: async () => {}, database: () => db, dispatchDeviceCommand: async (...args) => dispatched.push(args) });
  context.automationLocalTime = () => ({ date: '2026-10-07', time: '18:42', weekday: 3 });
  for (let tick = 0; tick < 6; tick++) await context.runScheduledAutomations();
  assert.equal(dispatched.length, 4);
  assert.equal(calls.filter((sql) => sql.startsWith('UPDATE automations SET last_run_at = NOW(), condition_active = 0')).length, 4);
  assert.equal(calls.filter((sql) => sql.includes('last_run_date')).length, 0);
});

test('conditionless anytime schedule runs once per local date', async () => {
  const calls = []; const dispatched = [];
  const rule = { id: 12, userId: 7, deviceId: 3, timezone: 'UTC', weekdays: '3', triggerTime: 'anytime', action: 'open', speed: 800, acceleration: 50, conditionJson: null };
  let lastRunDate = null;
  const db = { execute: async (sql, args) => {
    calls.push(sql);
    if (sql.startsWith('SELECT id, user_id AS userId, device_id')) return [[rule]];
    if (sql.includes('last_checked_at = NOW()')) return [{ affectedRows: 1 }];
    if (sql.startsWith('UPDATE automations SET last_run_at')) { const affectedRows = lastRunDate === args[0] ? 0 : 1; lastRunDate = args[0]; return [{ affectedRows }]; }
    if (sql.includes('FROM devices')) return [[{ id: 3, userId: 7 }]];
    throw new Error(sql);
  } };
  const context = backend({ automationTickRunning: false, ensureSchema: async () => {}, database: () => db, dispatchDeviceCommand: async (...args) => dispatched.push(args) });
  let date = '2026-10-07';
  context.automationLocalTime = () => ({ date, time: '18:42', weekday: 3 });
  await context.runScheduledAutomations(); await context.runScheduledAutomations();
  date = '2026-10-08';
  await context.runScheduledAutomations();
  assert.equal(dispatched.length, 2);
  assert.equal(calls.filter((sql) => sql.includes('last_run_date')).length, 3);
});

test('HTML loads automation helpers before app and mirrors are synchronized', () => {
  for (const folder of ['', 'public', 'public_html']) {
    const html = fs.readFileSync(path.join(root, folder, 'index.html'), 'utf8');
    assert.ok(html.indexOf('automation-model.js?v=47') >= 0);
    assert.ok(html.indexOf('automation-ui.js?v=56') >= 0);
    assert.ok(html.indexOf('app.js?v=71') >= 0);
    assert.ok(html.indexOf('blind-calibration-model.js?v=2') >= 0);
    assert.ok(html.indexOf('blind-calibration-ui.js?v=8') >= 0);
    assert.ok(html.indexOf('cloud-blind-calibration-ui.js?v=5') >= 0);
    assert.ok(html.includes('telemetry-overrides.css?v=54'));
    assert.ok(html.indexOf('automation-model.js?v=47') < html.indexOf('automation-ui.js?v=56'));
    assert.ok(html.indexOf('automation-ui.js?v=56') < html.indexOf('blind-calibration-model.js?v=2'));
    assert.ok(html.indexOf('blind-calibration-model.js?v=2') < html.indexOf('blind-calibration-ui.js?v=8'));
    assert.ok(html.indexOf('blind-calibration-ui.js?v=8') < html.indexOf('cloud-blind-calibration-ui.js?v=5'));
    assert.ok(html.indexOf('cloud-blind-calibration-ui.js?v=5') < html.indexOf('app.js?v=71'));
    assert.match(html, /automations.css\?v=48/);
    const app = fs.readFileSync(path.join(root, folder, 'app.js'), 'utf8');
    assert.match(app, /\$\('#automation-speed'\)\.value = '1800'/);
    assert.match(app, /\$\('#automation-speed'\)\.max = '1800'/);
    assert.match(app, /pad\(date\.getHours\(\)\)}:\$\{pad\(date\.getMinutes\(\)\)}:\$\{pad\(date\.getSeconds\(\)\)/);
    assert.match(app, /tooltipFormat: 'yyyy-MM-dd HH:mm:ss'/);
    assert.match(app, /}, 3000\);/);
    assert.match(app, /telemetry\?deviceId=\$\{encodeURIComponent\(deviceId\)\}\$\{rangeQuery\}/);
    assert.match(fs.readFileSync(path.join(root, folder, 'telemetry-overrides.css'), 'utf8'), /overflow-wrap:anywhere/);
  }
  assert.match(server, /require\('\.\/automation-model'\)/);
  for (const file of ['automation-model.js', 'automation-ui.js', 'automations.css', 'index.html']) {
    for (const folder of ['public', 'public_html']) assert.equal(fs.readFileSync(path.join(root, folder, file), 'utf8'), fs.readFileSync(path.join(root, file), 'utf8'), `${folder}/${file} differs`);
  }
  // Non-automation app differences are pre-existing user edits, not mirror defects.
  const automationCode = (folder) => {
    const app = fs.readFileSync(path.join(root, folder, 'app.js'), 'utf8');
    return app.slice(app.indexOf('function automationsViewMarkup('), app.indexOf('function renderFirmwareReleases('));
  };
  for (const folder of ['public', 'public_html']) assert.equal(automationCode(folder), automationCode(''), `${folder}/app.js automation code differs`);
});

test('Open-Meteo conditions use the cached virtual source without a physical device', async () => {
  const b = backend({ OpenMeteo: { WEATHER_DEVICE_ID: 'weather_openmeteo', config: () => ({ latitude: 40.7, longitude: -74, timezone: 'America/New_York' }), getWeatherSnapshot: async () => ({ telemetry: { temperature: 24.5, weather_code: 1, wind_speed: 8, sunrise: '2026-10-08T06:31', sunset: '2026-10-08T18:14' } }), parameters: openMeteo.parameters } });
  const db = { execute: async () => { throw new Error('No debe consultar dispositivos para Open-Meteo'); } };
  assert.equal(await b.automationConditionIsMet(db, { conditionJson: [{ deviceId: 'weather_openmeteo', path: 'temperature', operator: 'gte', value: 20, latitude: 40.7, longitude: -74, timezone: 'America/New_York' }] }), true);
  assert.equal(await b.automationConditionIsMet(db, { conditionJson: [{ kind: 'parameter', deviceId: 'weather_openmeteo', path: 'sunrise', operator: 'eq', value: true, latitude: 40.7, longitude: -74, timezone: 'America/New_York' }] }), true);
  assert.throws(() => b.automationCondition({ deviceId: 'weather_openmeteo', path: 'sunrise', operator: 'eq', value: '' }), /evento solar/);
  assert.throws(() => b.automationCondition({ deviceId: 'weather_openmeteo', path: 'temperature', operator: 'contains', value: 20 }));
});

test('Open-Meteo resolves sunrise to the configured local minute', () => {
  const snapshot = { timezone: 'America/Mexico_City', daily: { time: ['2026-10-08'], sunrise: ['2026-10-08T06:31'], sunset: ['2026-10-08T18:14'] } };
  assert.equal(openMeteo.solarTime(snapshot, 'sunrise', new Date('2026-10-08T12:00:00Z')), '06:31');
  assert.equal(openMeteo.solarTime(snapshot, 'sunset', new Date('2026-10-08T12:00:00Z')), '18:14');
});

test('Open-Meteo uses rule coordinates without server environment variables', () => {
  const previous = { latitude: process.env.OPEN_METEO_LATITUDE, longitude: process.env.OPEN_METEO_LONGITUDE, timezone: process.env.OPEN_METEO_TIMEZONE };
  delete process.env.OPEN_METEO_LATITUDE;
  delete process.env.OPEN_METEO_LONGITUDE;
  delete process.env.OPEN_METEO_TIMEZONE;
  try {
    assert.deepEqual(openMeteo.config({ latitude: 19.4326, longitude: -99.1332, timezone: 'America/Mexico_City' }), { latitude: 19.4326, longitude: -99.1332, timezone: 'America/Mexico_City' });
  } finally {
    for (const [key, value] of Object.entries({ OPEN_METEO_LATITUDE: previous.latitude, OPEN_METEO_LONGITUDE: previous.longitude, OPEN_METEO_TIMEZONE: previous.timezone })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('dynamic curtain position resolves source parameter divided by 100', async () => {
  const b = backend();
  const ruleInput = input({ deviceId: 'curtain', action: 'position', commandName: '', commandPayload: null, conditions: [], valueSource: { deviceId: 'B', path: 'bright_value', transform: 'divide', divisor: 100 } });
  const parsed = b.automationInput(ruleInput);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.valueSource)), ruleInput.valueSource);
  const calls = [];
  const db = { execute: async (sql, args) => {
    calls.push([sql, args]);
    if (sql.startsWith('SELECT id, user_id AS userId, device_id')) return [[{ id: 1, userId: 7, deviceId: 'curtain', triggerTime: 'anytime', action: 'position', position: null, valueSource: JSON.stringify(ruleInput.valueSource), speed: 800, acceleration: 50, conditionJson: null, commandName: null, commandPayload: null, timezone: 'UTC', weekdays: '3' }]];
    if (sql.includes('FROM telemetry')) return [[{ payload: { status: [{ code: 'bright_value', value: 5000 }] } }]];
    if (sql.startsWith('UPDATE automations')) return [{ affectedRows: 1 }];
    if (sql.includes('FROM devices')) return [[{ id: 2, userId: 7 }]];
    throw new Error(sql);
  } };
  const dispatched = [];
  const context = backend({ automationTickRunning: false, ensureSchema: async () => {}, database: () => db, dispatchDeviceCommand: async (...args) => dispatched.push(args) });
  context.automationLocalTime = () => ({ date: '2026-10-07', time: '18:42', weekday: 3 });
  await context.runScheduledAutomations();
  assert.equal(dispatched[0][2], 'curtain.move');
  assert.deepEqual(JSON.parse(JSON.stringify(dispatched[0][3])), { servoId: 1, percent: 50, speed: 800, acceleration: 50 });
});

test('dynamic Tuya parameter copies a synced Tuya status value into the target', async () => {
  const b = backend();
  const source = { deviceId: 'bedroom-1', path: 'bright_value_1', transform: 'copy', divisor: 1 };
  const ruleInput = input({ deviceId: 'living-room', commandPayload: { code: 'bright_value_1' }, valueSource: source, conditions: [] });
  assert.deepEqual(JSON.parse(JSON.stringify(b.automationInput(ruleInput).valueSource)), source);
  const db = { execute: async (sql) => {
    if (sql.startsWith('SELECT id, user_id AS userId, device_id')) return [[{ id: 1, userId: 7, deviceId: 'living-room', triggerTime: 'anytime', action: 'open', position: null, valueSource: JSON.stringify(source), speed: 800, acceleration: 50, conditionJson: null, commandName: 'tuya.set', commandPayload: JSON.stringify({ code: 'bright_value_1' }), timezone: 'UTC', weekdays: '3' }]];
    if (sql.includes('FROM telemetry')) return [[{ payload: { provider: 'tuya', status: { bright_value_1: 63 } } }]];
    if (sql.startsWith('UPDATE automations')) return [{ affectedRows: 1 }];
    if (sql.includes('FROM devices')) return [[{ id: 2, userId: 7 }]];
    throw new Error(sql);
  } };
  const dispatched = [];
  const context = backend({ automationTickRunning: false, ensureSchema: async () => {}, database: () => db, dispatchDeviceCommand: async (...args) => dispatched.push(args) });
  context.automationLocalTime = () => ({ date: '2026-10-07', time: '18:42', weekday: 3 });
  await context.runScheduledAutomations();
  assert.equal(dispatched[0][2], 'tuya.set');
  assert.deepEqual(JSON.parse(JSON.stringify(dispatched[0][3])), { code: 'bright_value_1', value: 63 });
});

test('dynamic Tuya parameter resolves nested paths inside status arrays', async () => {
  const b = backend();
  assert.equal(b.automationSourceValue({ status: [{ code: 'bright_value_1', value: 63 }] }, 'status.bright_value_1'), 63);
  const source = { deviceId: 'bedroom-1', path: 'status.bright_value_1', transform: 'copy', divisor: 1 };
  const ruleInput = input({ deviceId: 'living-room', commandPayload: { code: 'bright_value_1' }, valueSource: source, conditions: [] });
  const db = { execute: async (sql) => {
    if (sql.startsWith('SELECT id, user_id AS userId, device_id')) return [[{ id: 1, userId: 7, deviceId: 'living-room', triggerTime: 'anytime', action: 'open', position: null, valueSource: JSON.stringify(source), speed: 800, acceleration: 50, conditionJson: null, commandName: 'tuya.set', commandPayload: JSON.stringify({ code: 'bright_value_1' }), timezone: 'UTC', weekdays: '3' }]];
    if (sql.includes('FROM telemetry')) return [[{ payload: { provider: 'tuya', status: [{ code: 'bright_value_1', value: 63 }] } }]];
    if (sql.startsWith('UPDATE automations')) return [{ affectedRows: 1 }];
    if (sql.includes('FROM devices')) return [[{ id: 2, userId: 7 }]];
    throw new Error(sql);
  } };
  const dispatched = [];
  const context = backend({ automationTickRunning: false, ensureSchema: async () => {}, database: () => db, dispatchDeviceCommand: async (...args) => dispatched.push(args) });
  context.automationLocalTime = () => ({ date: '2026-10-07', time: '18:42', weekday: 3 });
  await context.runScheduledAutomations();
  assert.equal(dispatched[0][2], 'tuya.set');
  assert.deepEqual(JSON.parse(JSON.stringify(dispatched[0][3])), { code: 'bright_value_1', value: 63 });
});

test('backend rejects remote device credential replacement', async () => {
  const b = backend();
  const pulsegrid = { provider: 'pulsegrid' };
  await assert.rejects(b.dispatchDeviceCommand({}, pulsegrid, 'device.configure', { apiUrl: 'https://pulse.2api2.com', apiKey: 'pg_live_valid_key', deviceId: 'Cortina_2' }));
  await assert.rejects(b.dispatchDeviceCommand({}, { provider: 'tuya' }, 'device.configure', {}));
  assert.doesNotThrow(() => b.validateDirectionConfiguration({ ...pulsegrid, telemetry: { kind: 'curtain' } }, 'direction.configure', { reversed: true }));
  assert.throws(() => b.validateDirectionConfiguration({ provider: 'tuya' }, 'direction.configure', { reversed: true }));
  assert.throws(() => b.validateDirectionConfiguration({ ...pulsegrid, telemetry: { kind: 'curtain' } }, 'direction.configure', { reversed: 'true' }));
});

test('backend validates LED commands as a boolean for Pulsegrid curtains', () => {
  const b = backend();
  const curtain = { provider: 'pulsegrid', type: 'curtain' };
  assert.doesNotThrow(() => b.validateLedConfiguration(curtain, 'led.configure', { enabled: true }));
  assert.doesNotThrow(() => b.validateLedConfiguration(curtain, 'led.configure', { enabled: false }));
  assert.throws(() => b.validateLedConfiguration(curtain, 'led.configure', { enabled: 'false' }));
  assert.throws(() => b.validateLedConfiguration(curtain, 'led.configure', {}));
  assert.throws(() => b.validateLedConfiguration({ provider: 'tuya' }, 'led.configure', { enabled: true }));
});

test('backend validates Pulsegrid direction configuration', () => {
  const b = backend();
  const curtain = { provider: 'pulsegrid', type: 'curtain', capabilities: [] };
  assert.doesNotThrow(() => b.validateDirectionConfiguration(curtain, 'direction.configure', { reversed: true }));
  assert.doesNotThrow(() => b.validateDirectionConfiguration(curtain, 'direction.configure', { reversed: false }));
  assert.throws(() => b.validateDirectionConfiguration(curtain, 'direction.configure', { reversed: 'true' }));
  assert.throws(() => b.validateDirectionConfiguration(curtain, 'direction.configure', {}));
  assert.throws(() => b.validateDirectionConfiguration({ provider: 'tuya' }, 'direction.configure', { reversed: true }));
});

test('direction validation uses latest telemetry for Pulsegrid actuators', async () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const context = { AutomationModel: model, OpenMeteo: openMeteo, console, URL, setInterval: () => {}, clearInterval: () => {} };
  vm.createContext(context);
  vm.runInContext(server.slice(server.indexOf('function validateTuyaCommand('), server.indexOf('async function syncTuyaDevice(')), context);
  const calls = [];
  const db = { execute: async (sql, args) => {
    calls.push([sql, args]);
    if (sql.startsWith('SELECT payload FROM telemetry')) return [[{ payload: { kind: 'curtain', firmwareTarget: 'ga25' } }]];
    if (sql.startsWith('INSERT INTO commands')) return [{ insertId: 9 }];
    throw new Error(sql);
  } };
  const result = await context.dispatchDeviceCommand(db, { id: 4, provider: 'pulsegrid', type: 'Actuador' }, 'direction.configure', { reversed: true });
  assert.equal(result.id, 9);
  assert.equal(result.status, 'queued');
  assert.equal(calls.length, 2);
});

test('backend requires an explicit valid Servo motor mounting side for geometric calibration', () => {
  const b = backend();
  const calibration = { servoId: 1, heightCm: 150, tubeDiameterCm: 5, fabricThicknessMm: 0.5, motorTurnsPerTubeTurn: 1, estimatedTurns: blindCalibrationModel.estimateTurns(150, 5, 0.5), motorSide: 'left' };
  assert.doesNotThrow(() => b.validateCloudBlindCalibration({ provider: 'pulsegrid' }, 'blind.cloudCalibrationConfigure', calibration));
  assert.doesNotThrow(() => b.validateCloudBlindCalibration({ provider: 'pulsegrid' }, 'blind.cloudCalibrationConfigure', { ...calibration, motorSide: 'right' }));
  assert.throws(() => b.validateCloudBlindCalibration({ provider: 'pulsegrid' }, 'blind.cloudCalibrationConfigure', { ...calibration, motorSide: 'invalid' }));
  const { motorSide, ...legacyPayload } = calibration;
  assert.throws(() => b.validateCloudBlindCalibration({ provider: 'pulsegrid' }, 'blind.cloudCalibrationConfigure', legacyPayload));
});