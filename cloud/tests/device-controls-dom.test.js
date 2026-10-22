const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const model = require('../automation-model');
const root = path.join(__dirname, '..');

const device = {
  id: 'tuya-1', name: 'Lamp', type: 'light', provider: 'tuya', status: 'online', report: 'now', signal: 'good', icon: 'cloud', meta: [],
  telemetry: { status: [
    { code: 'switch_led', value: true },
    { code: 'bright_value', value: 25 },
    { code: 'work_mode', value: 'white' },
    { code: 'temp_current', value: 19 }
  ] },
  capabilities: [
    { code: 'switch_led', name: 'Power', type: 'Boolean' },
    { code: 'bright_value', name: 'Brightness', type: 'Integer', values: { min: 0, max: 100, step: 1 } },
    { code: 'work_mode', name: 'Mode', type: 'Enum', values: { range: ['white', 'color'] } }
  ]
};

const curtainDevice = {
  id: 'curtain-1', name: 'Curtain', type: 'curtain', provider: 'pulsegrid', status: 'online', report: 'now', signal: 'good', icon: 'blinds', meta: [],
  telemetry: { kind: 'curtain', firmwareTarget: 'ga25', position: 27, directionReversed: false, ledEnabled: false }
};

const servoCurtainDevice = {
  ...curtainDevice,
  telemetry: { kind: 'curtain', firmwareTarget: 'servo', directionReversed: false, servos: {
    1: { blind_percent: 25, blind_target_percent: 40, blind_calibrated: true, position_recovery_required: false, blind_calibration_in_progress: false },
    2: { blind_percent: 29, blind_target_percent: 40, blind_calibrated: true, position_recovery_required: false, blind_calibration_in_progress: false }
  } }
};

function setup(folder, requestImpl = async () => ({ status: 'succeeded' }), configuredDevice = device) {
  const dom = new JSDOM('<div id="device-card-grid"></div>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const { window } = dom;
  const context = dom.getInternalVMContext();
  const requests = [];
  const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  Object.assign(window, {
    devices: Array.isArray(configuredDevice) ? structuredClone(configuredDevice) : [structuredClone(configuredDevice)], AutomationModel: model,
    deviceCommandPollIntervalMs: 5,
    navigate: (view) => { window.lastView = view; },
    loadTelemetry: async (deviceId) => { window.lastTelemetryDevice = deviceId; },
    formatDateTimeInput: (value) => value.toISOString().slice(0, 16),
    $: (selector, parent = window.document) => parent.querySelector(selector),
    $$: (selector, parent = window.document) => Array.from(parent.querySelectorAll(selector)),
    parseTelemetry: (value) => typeof value === 'string' ? JSON.parse(value) : value || {},
    escapeTelemetryHtml: escape,
    deviceStatus: (item) => `<span class="status">${escape(item.status)}</span>`,
    renderIcons() {},
    apiRequest: async (endpoint, options) => {
      if (options?.method === 'POST') requests.push({ endpoint, ...JSON.parse(options.body) });
      const result = await requestImpl(endpoint, options);
      if (endpoint.startsWith('commands/') && !result.command) {
        const commandId = Number(endpoint.split('/').at(-1));
        return { command: { id: commandId, deviceId: configuredDevice.id || configuredDevice[0]?.id || 'tuya-1', status: 'succeeded' } };
      }
      if (options?.method === 'POST' && result.commandId == null && result.id == null) return { ...result, commandId: requests.length };
      return result;
    }
  });
  vm.runInContext("let deviceCardFilter = ''; let deviceCardStatus = 'all'; const deviceControlRequests = new Map();", context);
  const source = fs.readFileSync(path.join(root, folder, 'app.js'), 'utf8');
  const start = source.indexOf('function deviceParameterEntries(');
  const end = source.indexOf('function closeDeviceMenu()', start);
  assert.notEqual(start, -1, `${folder || 'root'} control rendering exists`);
  assert.notEqual(end, -1, `${folder || 'root'} control code is extractable`);
  vm.runInContext(source.slice(start, end), context);
  vm.runInContext('renderDeviceCards(); bindDeviceCardControls();', context);
  return { dom, window, context, requests };
}

for (const folder of ['', 'public', 'public_html']) {
  const label = folder || 'root';
  test(`${label}: card icon reflects online, provisioning, and offline state`, (t) => {
    const f = setup(folder); t.after(() => f.dom.window.close());
    const { window, context } = f;
    const icon = () => window.document.querySelector('.device-card .device-icon');
    assert.equal(icon().classList.contains('status-online'), true);
    window.devices[0].status = 'provisioning';
    vm.runInContext('renderDeviceCards()', context);
    assert.equal(icon().classList.contains('status-provisioning'), true);
    window.devices[0].status = 'offline';
    vm.runInContext('renderDeviceCards()', context);
    assert.equal(icon().classList.contains('status-offline'), true);
  });

  test(`${label}: renders writable controls by capability and keeps other readings read-only`, (t) => {
    const f = setup(folder); t.after(() => f.dom.window.close());
    const { window } = f;
    assert.equal(window.document.querySelector('[data-code="switch_led"]').type, 'checkbox');
    assert.equal(window.document.querySelector('[data-code="switch_led"]').checked, true);
    const slider = window.document.querySelector('[data-code="bright_value"]');
    assert.equal(slider.type, 'range');
    assert.equal(slider.min, '0');
    assert.equal(slider.max, '100');
    assert.equal(window.document.querySelector('[data-code="work_mode"]').tagName, 'SELECT');
    assert.equal(window.document.querySelector('[data-code="work_mode"]').value, 'white');
    assert.equal(window.document.querySelector('[data-code="temp_current"]'), null);
    assert.match(window.document.querySelector('.device-parameters').textContent, /temp_current/);
    assert.match(window.document.querySelector('.device-parameters').textContent, /Solo lectura|Lectura/);
  });

  test(`${label}: sends typed Tuya values, reports success/errors, and rejects non-writable codes`, async (t) => {
    const f = setup(folder); t.after(() => f.dom.window.close());
    const { window, context } = f;
    const slider = window.document.querySelector('[data-code="bright_value"]');
    slider.value = '40';
    await vm.runInContext("sendDeviceParameter({ target: document.querySelector('[data-code=\\\"bright_value\\\"]') })", context);
    assert.deepEqual(f.requests[0], { endpoint: 'commands', deviceId: 'tuya-1', command: 'tuya.set', payload: { code: 'bright_value', value: 40 } });
    assert.equal(window.document.querySelector('[data-code="bright_value"]').parentElement.parentElement.querySelector('[data-control-status]').textContent, label === 'public' ? '' : 'Enviado');

    const readOnly = window.document.querySelector('[data-code="temp_current"]');
    assert.equal(readOnly, null);
    const before = f.requests.length;
    window.document.querySelector('[data-code="switch_led"]').dataset.code = 'temp_current';
    await vm.runInContext("sendDeviceParameter({ target: document.querySelector('[data-device-control][type=checkbox]') })", context);
    assert.equal(f.requests.length, before);
  });

  test(`${label}: polling does not replace a focused control and refreshes after blur`, async (t) => {
    const f = setup(folder); t.after(() => f.dom.window.close());
    const { window, context } = f;
    const slider = window.document.querySelector('[data-code="bright_value"]');
    slider.focus();
    window.devices[0].telemetry.status[1].value = 67;
    vm.runInContext('renderDeviceCards()', context);
    assert.equal(window.document.querySelector('[data-code="bright_value"]'), slider);
    assert.equal(slider.value, '25');
    slider.blur();
    await new Promise((resolve) => window.setTimeout(resolve, 5));
    assert.equal(window.document.querySelector('[data-code="bright_value"]').value, '67');
  });

  test(`${label}: command failures appear beside the control`, async (t) => {
    const f = setup(folder, async () => { throw new Error('Tuya no disponible'); }); t.after(() => f.dom.window.close());
    const { window, context } = f;
    const toggle = window.document.querySelector('[data-code="switch_led"]');
    toggle.checked = false;
    await vm.runInContext("sendDeviceParameter({ target: document.querySelector('[data-code=\\\"switch_led\\\"]') })", context);
    assert.equal(toggle.checked, true);
    assert.match(window.document.querySelector('[data-code="switch_led"]').closest('.device-parameter').textContent, /Error: Tuya no disponible/);
  });

  test(`${label}: optimistic toggle survives stale telemetry refresh until confirmed`, async (t) => {
    const f = setup(folder); t.after(() => f.dom.window.close());
    const { window, context } = f;
    const toggle = window.document.querySelector('[data-code="switch_led"]');
    toggle.checked = false;
    await vm.runInContext("sendDeviceParameter({ target: document.querySelector('[data-code=\\\"switch_led\\\"]') })", context);
    window.devices[0].telemetry.status[0].value = true;
    vm.runInContext('renderDeviceCards()', context);
    assert.equal(window.document.querySelector('[data-code="switch_led"]').checked, false);
  });

  test(`${label}: motor direction survives stale telemetry until confirmed`, async (t) => {
    const f = setup(folder, async () => ({ status: 'queued' }), curtainDevice); t.after(() => f.dom.window.close());
    const { window, context } = f;
    const toggle = window.document.querySelector('[data-device-direction]');
    toggle.checked = true;
    await vm.runInContext('sendDeviceDirection({ target: document.querySelector("[data-device-direction]") })', context);
    assert.deepEqual(f.requests[0], { endpoint: 'commands', deviceId: 'curtain-1', command: 'direction.configure', payload: { reversed: true } });
    vm.runInContext('renderDeviceCards()', context);
    assert.equal(window.document.querySelector('[data-device-direction]').checked, true);
    window.devices[0].telemetry.directionReversed = true;
    vm.runInContext('renderDeviceCards()', context);
    assert.equal(window.document.querySelector('[data-device-direction]').checked, true);
  });

  test(`${label}: curtain position slider retains desired percentage and queues whole-curtain move`, async (t) => {
    const f = setup(folder, async () => ({ status: 'queued' }), servoCurtainDevice); t.after(() => f.dom.window.close());
    const { window, context } = f;
    const slider = window.document.querySelector('[data-curtain-position]');
    assert.ok(slider);
    assert.equal(slider.value, '40');
    const speedSlider = window.document.querySelector('[data-curtain-speed]');
    assert.ok(speedSlider);
    assert.equal(speedSlider.value, '1800');
    assert.equal(speedSlider.min, '0');
    assert.equal(speedSlider.max, '1800');
    speedSlider.value = '180';
    speedSlider.dispatchEvent(new window.Event('input', { bubbles: true }));
    slider.value = '64';
    slider.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.equal(slider.parentElement.querySelector('output').value, '64%');
    slider.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    assert.deepEqual(f.requests[0], { endpoint: 'commands', deviceId: 'curtain-1', command: 'curtain.move', payload: { percent: 64, speed: 180, acceleration: 50, allServos: true } });
    assert.equal(window.document.querySelector('[data-curtain-position-status]').textContent, label === 'public' ? 'Comando enviado. Esperando al dispositivo…' : 'En cola');
    window.devices[0].telemetry.servos[1].blind_target_percent = 64;
    window.devices[0].telemetry.servos[2].blind_target_percent = 64;
    vm.runInContext('renderDeviceCards()', context);
    assert.equal(window.document.querySelector('[data-curtain-position]').value, '64');
    const currentSpeedSlider = window.document.querySelector('[data-curtain-speed]');
    currentSpeedSlider.value = '0';
    currentSpeedSlider.dispatchEvent(new window.Event('input', { bubbles: true }));
    const currentPositionSlider = window.document.querySelector('[data-curtain-position]');
    currentPositionSlider.value = '70';
    currentPositionSlider.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    assert.equal(f.requests.length, 1);
    assert.match(window.document.querySelector('[data-curtain-position-status]').textContent, /velocidad mayor que 0/i);
    window.devices[0].telemetry.servos[1].blind_percent = 31;
    window.devices[0].telemetry.servos[2].blind_percent = 35;
    vm.runInContext('renderDeviceCards()', context);
    assert.equal(window.document.querySelector('[data-curtain-position]').value, '64');
  });

  test(`${label}: curtain position slider is disabled until Servo calibration is ready`, (t) => {
    const notReady = structuredClone(servoCurtainDevice);
    notReady.telemetry.servos[2].position_recovery_required = true;
    const f = setup(folder, undefined, notReady); t.after(() => f.dom.window.close());
    assert.equal(f.window.document.querySelector('[data-curtain-position]').disabled, true);
    assert.match(f.window.document.querySelector('[data-curtain-position-status]').textContent, /Recupera referencia y reaplica calibración/);
  });

  test(`${label}: GA25 position slider queues its timed position command`, async (t) => {
    const f = setup(folder, async () => ({ status: 'queued' }), curtainDevice); t.after(() => f.dom.window.close());
    const { window } = f;
    const slider = window.document.querySelector('[data-curtain-position]');
    assert.equal(slider.value, '27');
    slider.value = '70';
    slider.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    assert.deepEqual(f.requests[0], { endpoint: 'commands', deviceId: 'curtain-1', command: 'curtain.move', payload: { percent: 70, speed: 800, acceleration: 50 } });
  });

  test(`${label}: position command failure restores the reported percentage and shows the error`, async (t) => {
    const f = setup(folder, async () => { throw new Error('Dispositivo fuera de linea'); }, curtainDevice); t.after(() => f.dom.window.close());
    const { window } = f;
    const slider = window.document.querySelector('[data-curtain-position]');
    slider.value = '70';
    slider.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    assert.equal(window.document.querySelector('[data-curtain-position]').value, '27');
    assert.match(window.document.querySelector('[data-curtain-position-status]').textContent, /Error: Dispositivo fuera de linea/);
  });

  test(`${label}: motor direction returns to the previous value when command fails`, async (t) => {
    const f = setup(folder, async () => { throw new Error('Dispositivo fuera de linea'); }, curtainDevice); t.after(() => f.dom.window.close());
    const { window, context } = f;
    const toggle = window.document.querySelector('[data-device-direction]');
    toggle.checked = true;
    await vm.runInContext('sendDeviceDirection({ target: document.querySelector("[data-device-direction]") })', context);
    assert.equal(window.document.querySelector('[data-device-direction]').checked, false);
    assert.match(window.document.querySelector('[data-direction-status]').textContent, /Error: Dispositivo fuera de linea/);
  });

  test(`${label}: LED switch sends an explicit boolean command and keeps the optimistic state`, async (t) => {
    const f = setup(folder, async () => ({ status: 'queued' }), curtainDevice); t.after(() => f.dom.window.close());
    const { window, context } = f;
    const toggle = window.document.querySelector('[data-device-led]');
    assert.equal(toggle.checked, false);
    toggle.checked = true;
    await vm.runInContext('sendDeviceLed({ target: document.querySelector("[data-device-led]") })', context);
    assert.deepEqual(f.requests[0], { endpoint: 'commands', deviceId: 'curtain-1', command: 'led.configure', payload: { enabled: true } });
    vm.runInContext('renderDeviceCards()', context);
    assert.equal(window.document.querySelector('[data-device-led]').checked, true);
  });

  test(`${label}: card actions remain independent and open device telemetry`, async (t) => {
    const f = setup(folder); t.after(() => f.dom.window.close());
    const { window } = f;
    const card = window.document.querySelector('[data-device-card="tuya-1"]');
    assert.equal(card.querySelector('.device-card-id').textContent, 'UID: tuya-1');
    assert.equal(card.querySelectorAll('[data-device-menu]').length, 1);
    assert.equal(card.querySelectorAll('[data-device-toggle]').length, 2);
    card.querySelector('[data-device-telemetry-today]').click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    assert.equal(window.lastView, 'telemetry');
    assert.equal(window.lastTelemetryDevice, 'tuya-1');
  });
}

test('command history shows curtain parameters and safely redacts/escapes payload details', async (t) => {
  const dom = new JSDOM('<div class="command-history"></div>', { runScripts: 'outside-only', url: 'http://localhost/' });
  t.after(() => dom.window.close());
  const { window } = dom;
  const context = dom.getInternalVMContext();
  const command = {
    id: 42,
    command: 'curtain.move',
    payload: JSON.stringify({ allServos: true, percent: 70, speed: 800, acceleration: 50, deviceCode: 'do-not-render' }),
    deviceName: '<Servo>',
    deviceId: 'CURTAIN-1',
    status: 'succeeded',
    createdAt: '2026-10-21T12:00:00Z'
  };
  Object.assign(window, {
    $: (selector, parent = window.document) => parent.querySelector(selector),
    $$: (selector, parent = window.document) => Array.from(parent.querySelectorAll(selector)),
    apiRequest: async () => ({ commands: [command] }),
    escapeTelemetryHtml: (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character])),
    formatDateTime: () => 'hoy',
    renderIcons() {}
  });
  const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const start = source.indexOf('function commandPayloadSummary(');
  const end = source.indexOf('function renderIcons()', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  vm.runInContext(source.slice(start, end), context);

  await vm.runInContext('loadCommandHistory()', context);

  const history = window.document.querySelector('.command-history');
  assert.match(history.textContent, /Objetivo: 70%/);
  assert.match(history.textContent, /Todos los servos: Si/);
  assert.match(history.textContent, /Velocidad: 800/);
  assert.match(history.textContent, /Aceleracion: 50/);
  assert.match(history.textContent, /\[oculto\]/);
  assert.doesNotMatch(history.innerHTML, /do-not-render/);
  assert.match(history.innerHTML, /&lt;Servo&gt;/);
  assert.equal(history.querySelector('[data-cancel-command="42"]') !== null, false);
});

test('public card tracks queued and delivered states and unlocks after succeeded', async (t) => {
  let status = 'queued';
  const f = setup('public', async (endpoint) => endpoint.startsWith('commands/')
    ? { command: { id: 1, deviceId: 'tuya-1', status } }
    : { status: 'queued', commandId: 1 });
  t.after(() => f.dom.window.close());
  const { window, context } = f;
  const toggle = window.document.querySelector('[data-code="switch_led"]');
  toggle.checked = false;
  const command = vm.runInContext('sendDeviceParameter({ target: document.querySelector("[data-code=\\"switch_led\\"]") })', context);
  await new Promise((resolve) => window.setTimeout(resolve, 10));
  const card = window.document.querySelector('[data-device-card="tuya-1"]');
  assert.equal(card.classList.contains('is-command-pending'), true);
  assert.equal(toggle.disabled, true);
  assert.equal(toggle.getAttribute('aria-disabled'), 'true');
  assert.match(card.textContent, /Comando enviado\. Esperando al dispositivo/);
  assert.equal(card.querySelector('[data-device-toggle]').disabled, false);
  vm.runInContext('renderDeviceCards()', context);
  assert.equal(window.document.querySelector('[data-code="switch_led"]').disabled, true);
  status = 'delivered';
  await new Promise((resolve) => window.setTimeout(resolve, 15));
  assert.match(window.document.querySelector('[data-device-card="tuya-1"]').textContent, /Comando recibido\. Ejecutando/);
  status = 'succeeded';
  await command;
  assert.equal(window.document.querySelector('[data-device-card="tuya-1"]').classList.contains('is-command-pending'), false);
  assert.equal(window.document.querySelector('[data-code="switch_led"]').disabled, false);
  assert.match(window.document.querySelector('[data-device-command-feedback]').textContent, /Comando completado/);
});

test('public card reports failed/canceled terminal states and restores optimistic values', async (t) => {
  let status = 'failed';
  let errorMessage = 'No se pudo aplicar';
  const f = setup('public', async (endpoint) => endpoint.startsWith('commands/')
    ? { command: { id: 1, deviceId: 'tuya-1', status, errorMessage } }
    : { status: 'queued', commandId: 1 });
  t.after(() => f.dom.window.close());
  const { window, context } = f;
  const toggle = window.document.querySelector('[data-code="switch_led"]');
  toggle.checked = false;
  await vm.runInContext('sendDeviceParameter({ target: document.querySelector("[data-code=\\"switch_led\\"]") })', context);
  assert.equal(window.document.querySelector('[data-code="switch_led"]').checked, true);
  assert.equal(window.document.querySelector('[data-code="switch_led"]').disabled, false);
  assert.match(window.document.querySelector('[data-device-card="tuya-1"]').textContent, /Error: No se pudo aplicar/);

  status = 'canceled';
  errorMessage = '';
  const directionDevice = { ...curtainDevice, id: 'curtain-1' };
  const canceled = setup('public', async (endpoint) => endpoint.startsWith('commands/')
    ? { command: { id: 1, deviceId: 'curtain-1', status } }
    : { status: 'queued', commandId: 1 }, directionDevice);
  t.after(() => canceled.dom.window.close());
  const direction = canceled.window.document.querySelector('[data-device-direction]');
  direction.checked = true;
  await vm.runInContext('sendDeviceDirection({ target: document.querySelector("[data-device-direction]") })', canceled.context);
  assert.equal(canceled.window.document.querySelector('[data-device-direction]').checked, false);
  assert.equal(canceled.window.document.querySelector('[data-device-direction]').disabled, false);
  assert.match(canceled.window.document.querySelector('[data-device-card="curtain-1"]').textContent, /Comando cancelado/);
});

test('public cards reject rapid duplicate commands but allow commands on other devices', async (t) => {
  let status = 'queued';
  const secondDevice = { ...device, id: 'tuya-2', name: 'Lamp 2' };
  const f = setup('public', async (endpoint, options) => endpoint.startsWith('commands/')
    ? { command: { id: Number(endpoint.split('/').at(-1)), deviceId: endpoint.endsWith('/1') ? 'tuya-1' : 'tuya-2', status } }
    : { status: 'queued' }, [device, secondDevice]);
  t.after(() => f.dom.window.close());
  const first = vm.runInContext('executeTrackedDeviceCommand("tuya-1", "tuya.set", { code: "switch_led", value: false })', f.context);
  const duplicate = await vm.runInContext('executeTrackedDeviceCommand("tuya-1", "tuya.set", { code: "switch_led", value: true })', f.context);
  const other = vm.runInContext('executeTrackedDeviceCommand("tuya-2", "tuya.set", { code: "switch_led", value: false })', f.context);
  await new Promise((resolve) => f.window.setTimeout(resolve, 10));
  assert.equal(duplicate, null);
  assert.equal(f.requests.length, 2);
  assert.equal(f.window.document.querySelector('[data-device-card="tuya-1"]').classList.contains('is-command-pending'), true);
  assert.equal(f.window.document.querySelector('[data-device-card="tuya-2"]').classList.contains('is-command-pending'), true);
  assert.equal(f.window.document.querySelector('[data-device-card="tuya-1"] [data-device-telemetry-today]').disabled, false);
  vm.runInContext('renderDeviceCards()', f.context);
  assert.equal(f.window.document.querySelector('[data-device-card="tuya-1"] [data-code="switch_led"]').disabled, true);
  status = 'succeeded';
  await Promise.all([first, other]);
});

test('public command timeout unlocks as unconfirmed and clears polling/deadline timers', async (t) => {
  const f = setup('public', async (endpoint) => endpoint.startsWith('commands/')
    ? { command: { id: 1, deviceId: 'tuya-1', status: 'queued' } }
    : { status: 'queued', commandId: 1 });
  t.after(() => f.dom.window.close());
  const record = await vm.runInContext('executeTrackedDeviceCommand("tuya-1", "tuya.set", { code: "switch_led", value: false }, { timeoutMs: 30 })', f.context);
  assert.equal(record.status, 'unconfirmed');
  assert.equal(record.finished, true);
  assert.equal(record.pollTimer, null);
  assert.equal(record.timeoutTimer, null);
  assert.equal(f.window.document.querySelector('[data-code="switch_led"]').disabled, false);
  assert.match(f.window.document.querySelector('[data-device-card="tuya-1"]').textContent, /No fue posible confirmar la finalización/);
  assert.doesNotMatch(f.window.document.querySelector('[data-device-card="tuya-1"]').textContent, /Comando completado/);
});

test('command status endpoint is authenticated and scoped to the session owner', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const routeStart = server.indexOf("app.get('/api/commands/:commandId'");
  const routeEnd = server.indexOf("app.post('/api/commands'", routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  const route = server.slice(routeStart, routeEnd);
  assert.match(route, /requireSession, apiReady/);
  assert.match(route, /devices\.user_id = \(SELECT id FROM users WHERE email = \?\)/);
  assert.match(route, /commands\.id, devices\.device_id AS deviceId, commands\.command_name AS command, commands\.status, commands\.error_message AS errorMessage/);
  assert.match(route, /if \(!rows\[0\]\) return fail\(response, 404/);
});
