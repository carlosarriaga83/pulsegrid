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

function setup(folder, requestImpl = async () => ({ status: 'succeeded' })) {
  const dom = new JSDOM('<div id="device-card-grid"></div>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const { window } = dom;
  const context = dom.getInternalVMContext();
  const requests = [];
  const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  Object.assign(window, {
    devices: [structuredClone(device)], AutomationModel: model,
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
      requests.push({ endpoint, ...JSON.parse(options.body) });
      return requestImpl(endpoint, options);
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
    assert.equal(window.document.querySelector('[data-code="bright_value"]').parentElement.parentElement.querySelector('[data-control-status]').textContent, 'Enviado');

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
