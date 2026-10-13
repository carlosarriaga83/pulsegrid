const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const root = path.join(__dirname, '..');
const power = { id: 'A', name: 'Meter', telemetry: { Power: 500, zero: 0, Led1: false } };
const led = { id: 'B', name: 'LED', provider: 'tuya', capabilities: [{ code: 'Led1', type: 'Boolean' }, { code: 'Level', type: 'Integer', values: { min: 0, max: 100 } }] };
const curtain = { id: 'C', name: 'Curtain', type: 'curtain' };
const condition = (overrides = {}) => ({ kind: 'parameter', deviceId: 'A', path: 'Power', operator: 'gte', value: 500, ...overrides });
const rule = (overrides = {}) => ({ id: 42, name: 'Power LED', deviceId: 'B', triggerTime: '12:00', timezone: 'UTC', weekdays: [1, 3], checkIntervalSeconds: 15, conditions: [condition()], action: 'open', commandName: 'tuya.set', commandPayload: { code: 'Led1', value: false }, ...overrides });

function frontend(folder) {
  const dom = new JSDOM('<div class="view-container"></div>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const context = dom.getInternalVMContext();
  const { window } = dom;
  const $ = (selector) => window.document.querySelector(selector);
  const $$ = (selector) => Array.from(window.document.querySelectorAll(selector));
  const requests = [];
  Object.assign(window, { $, $$, devices: structuredClone([power, led, curtain]), renderIcons() {}, showToast() {},
    escapeTelemetryHtml: (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])),
    formatDateTime: String,
    apiRequest: async (endpoint, options) => { if (options) requests.push({ endpoint, ...JSON.parse(options.body) }); return { automations: [] }; }
  });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  for (const file of ['automation-model.js', 'automation-ui.js']) vm.runInContext(fs.readFileSync(path.join(root, folder, file), 'utf8'), context);
  const app = fs.readFileSync(path.join(root, folder, 'app.js'), 'utf8');
  vm.runInContext(app.slice(app.indexOf('function automationsViewMarkup('), app.indexOf('function renderFirmwareReleases(')), context);
  window.setupAutomationsView();
  window.populateAutomationDevices();
  const change = (selector, value) => { const node = $(selector); node.value = value; node.dispatchEvent(new window.Event('change', { bubbles: true })); return node; };
  const edit = (value) => {
    vm.runInContext(`automationRules = [${JSON.stringify(value)}]`, context);
    $('#automation-rows').innerHTML = '<button data-automation-edit="42">Edit</button>';
    $('[data-automation-edit]').click();
  };
  return { dom, window, $, $$, change, edit, requests, ui: vm.runInContext('AutomationUI', context) };
}

for (const folder of ['', 'public', 'public_html']) {
  const label = folder || 'root';
  test(`${label}: Power=500 THEN Led1=True, exclusive shapes and multiple AND conditions`, (t) => {
    const f = frontend(folder); t.after(() => f.dom.window.close());
    f.change('.automation-condition-device', 'A');
    assert.deepEqual(f.$$('.automation-condition-path option').map((option) => option.value), ['Power', 'zero', 'Led1']);
    f.change('.automation-typed-value', '500');
    f.change('#automation-device', 'B');
    f.change('#automation-target-kind', 'parameter');
    f.change('#automation-target-value-wrap select', 'true');
    assert.equal(f.ui.target().commandPayload.value, true);
    assert.equal(f.ui.target().commandPayload.code, 'Led1');
    assert.equal(f.ui.readConditions()[0].value, 500);
    f.ui.addCondition(condition({ path: 'zero', operator: 'eq', value: 0 }));
    assert.equal(f.ui.readConditions().length, 2);
    assert.match(f.$('#automation-condition-description').textContent, /Power = 500 Y .*zero = 0.*Led1 = True/);
    f.change('.automation-condition-kind', 'command');
    f.change('.automation-condition-device', 'B');
    const command = f.ui.readConditions()[0];
    assert.equal(command.commandName, 'tuya.set');
    assert.equal(command.commandCode, 'Led1');
    assert.equal(Object.hasOwn(command, 'path'), false);
    f.change('.automation-condition-kind', 'parameter');
    f.change('.automation-condition-device', 'A');
    f.change('.automation-typed-value', '500');
    assert.equal(Object.hasOwn(f.ui.readConditions()[0], 'commandName'), false);
    f.$$('.automation-remove-condition')[1].click();
    f.$('.automation-remove-condition').click();
    assert.equal(f.$$('.automation-condition-row').length, 1);
  });

  test(`${label}: editing restores all operators, false/zero, target code, schedule and submitted values`, async (t) => {
    const f = frontend(folder); t.after(() => f.dom.window.close());
    for (const operator of ['eq', 'neq', 'gt', 'gte', 'lt', 'lte']) {
      f.edit(rule({ conditions: [condition({ operator }), condition({ path: 'Led1', value: false, operator: 'neq' })] }));
      assert.equal(f.$('.automation-condition-operator').value, operator);
      assert.equal(f.ui.readConditions()[1].value, false);
      assert.equal(f.ui.target().commandPayload.value, false);
      f.window.populateAutomationDevices();
      assert.equal(f.$('.automation-condition-operator').value, operator);
    }
    f.edit(rule({ conditions: [condition({ value: 0, operator: 'lte' })], commandPayload: { code: 'Level', value: 0 } }));
    assert.equal(f.$('#automation-action').value, 'Level');
    assert.equal(f.ui.target().commandPayload.value, 0);
    assert.equal(f.$('#automation-time').value, '12:00');
    assert.equal(f.$('#automation-check-interval').value, '15');
    assert.deepEqual(Array.from(f.window.selectedAutomationWeekdays()), [1, 3]);
    f.$('#automation-form').dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(setImmediate);
    assert.equal(f.requests[0].endpoint, 'automations/42');
    assert.equal(f.requests[0].commandPayload.value, 0);
    assert.equal(f.requests[0].conditions[0].operator, 'lte');
    assert.equal(f.requests[0].timezone, 'UTC');
    assert.equal(f.requests[0].checkIntervalSeconds, 15);
    assert.equal(f.$('#automation-form').dataset.editingId, undefined);
    assert.equal(f.$$('.automation-condition-row').length, 1);
    assert.equal(f.$('.automation-condition-operator').value, 'eq');
    assert.equal(f.$('#automation-target-value-field').hidden, true);
  });

  test(`${label}: saved absent readings survive refresh; explicit source changes reset operator`, (t) => {
    const f = frontend(folder); t.after(() => f.dom.window.close());
    f.edit(rule({ conditions: [condition({ path: 'historic.Power', value: 0, operator: 'lte' })] }));
    f.window.populateAutomationDevices();
    assert.equal(f.ui.readConditions()[0].path, 'historic.Power');
    assert.equal(f.ui.readConditions()[0].value, 0);
    assert.equal(f.ui.readConditions()[0].operator, 'lte');
    f.change('.automation-condition-path', 'Power');
    assert.equal(f.$('.automation-condition-operator').value, 'eq');
    assert.equal(f.$('.automation-typed-value').value, '');
    f.change('.automation-condition-operator', 'gt');
    f.change('.automation-condition-kind', 'command');
    f.change('.automation-condition-device', 'C');
    assert.deepEqual(f.$$('.automation-condition-operator option').map((option) => option.value), ['eq', 'neq']);
    assert.equal(f.$('.automation-condition-operator').value, 'eq');
    f.edit(rule({ deviceId: 'C', commandName: null, commandPayload: null, action: 'position', position: 35, speed: 600, acceleration: 40 }));
    assert.equal(f.ui.target().action, 'position');
    assert.equal(f.$('#automation-position').value, '35');
    assert.equal(f.$('#automation-position-field').hidden, false);
    assert.equal(f.$('#automation-target-value-field').hidden, true);
    f.$('#automation-cancel-edit').click();
    assert.equal(f.$('#automation-form').dataset.editingId, undefined);
    assert.equal(f.$('.automation-condition-device').value, '');
  });

  test(`${label}: dynamic parameter source hides literal value and uses anytime execution`, (t) => {
    const f = frontend(folder); t.after(() => f.dom.window.close());
    f.change('#automation-device', 'B');
    f.change('#automation-target-kind', 'parameter');
    f.change('#automation-value-source-device', 'A');
    f.change('#automation-value-source-parameter', 'Led1');
    const target = f.ui.target();
    assert.deepEqual(JSON.parse(JSON.stringify(target.commandPayload)), { code: 'Led1' });
    assert.deepEqual(JSON.parse(JSON.stringify(target.valueSource)), { deviceId: 'A', path: 'Led1', transform: 'copy', divisor: 1 });
    assert.equal(f.$('#automation-target-value-field').hidden, true);
    assert.equal(f.ui.triggerTime(), 'anytime');
  });

  test(`${label}: curtain position maps a numeric source through division by 100`, (t) => {
    const f = frontend(folder); t.after(() => f.dom.window.close());
    f.change('#automation-device', 'C');
    f.change('#automation-action', 'position');
    f.change('#automation-value-source-device', 'A');
    assert.deepEqual(f.$$('#automation-value-source-parameter option').map((option) => option.value), ['Power', 'zero']);
    f.change('#automation-value-source-parameter', 'Power');
    assert.equal(f.$('#automation-value-source-transform').value, 'divide');
    assert.equal(f.$('#automation-value-source-divisor').value, '100');
    assert.equal(f.$('#automation-position-field').hidden, true);
    assert.deepEqual(JSON.parse(JSON.stringify(f.ui.target())), { action: 'position', commandName: null, commandPayload: null, valueSource: { deviceId: 'A', path: 'Power', transform: 'divide', divisor: 100 } });
    assert.match(f.$('#automation-condition-description').textContent, /\(Meter · Power\) \/ 100%/);
  });

  test(`${label}: restores command conditions and legacy boolean rules; focused forms retain user input`, (t) => {
    const f = frontend(folder); t.after(() => f.dom.window.close());
    const tuyaCondition = { kind: 'command', deviceId: 'B', commandName: 'tuya.set', commandCode: 'Level', commandField: 'value', operator: 'gte', value: 0 };
    const nativeCondition = { kind: 'command', deviceId: 'C', commandName: 'curtain.close', commandField: 'status', operator: 'neq', value: 'failed' };
    f.edit(rule({ conditions: [tuyaCondition, nativeCondition], commandPayload: { code: 'Led1', value: true } }));
    assert.deepEqual(JSON.parse(JSON.stringify(f.ui.readConditions())), [tuyaCondition, nativeCondition]);
    assert.equal(f.ui.target().commandPayload.value, true);
    f.window.populateAutomationDevices();
    assert.deepEqual(JSON.parse(JSON.stringify(f.ui.readConditions())), [tuyaCondition, nativeCondition]);
    f.edit(rule({ conditions: undefined, condition: { deviceId: 'A', path: 'Led1', operator: 'eq', value: false } }));
    assert.equal(f.ui.readConditions()[0].value, false);
    f.$('#automation-name').focus();
    f.change('.automation-condition-path', 'Power');
    f.change('.automation-typed-value', '501');
    f.change('.automation-condition-operator', 'gt');
    f.window.devices[0].telemetry = {};
    f.window.populateAutomationDevices();
    assert.equal(f.ui.readConditions()[0].path, 'Power');
    assert.equal(f.ui.readConditions()[0].value, 501);
    assert.equal(f.ui.readConditions()[0].operator, 'gt');
    f.$('#automation-name').blur();
    f.window.populateAutomationDevices();
    assert.equal(f.ui.readConditions()[0].value, 501);
    assert.equal(f.ui.readConditions()[0].operator, 'gt');
    f.change('#automation-device', 'A');
    assert.throws(() => f.ui.target(), /accion compatible/);
    assert.equal(f.$('#automation-target-value-field').hidden, true);
  });

  test(`${label}: Open-Meteo autocompletes location without replacing saved values`, (t) => {
    const f = frontend(folder); t.after(() => f.dom.window.close());
    Object.defineProperty(f.window.navigator, 'geolocation', { configurable: true, value: { getCurrentPosition(success) { success({ coords: { latitude: 19.432608, longitude: -99.133209 } }); } } });
    f.change('.automation-condition-device', 'weather_openmeteo');
    assert.equal(f.$('.automation-weather-latitude').value, '19.4326');
    assert.equal(f.$('.automation-weather-longitude').value, '-99.1332');
    assert.equal(f.$('.automation-weather-status').textContent, 'Ubicacion detectada; puedes editarla.');
    const saved = { latitude: 40.7128, longitude: -74.006, timezone: 'America/New_York' };
    f.edit(rule({ conditions: [{ kind: 'parameter', deviceId: 'weather_openmeteo', path: 'temperature', operator: 'gte', value: 20, ...saved }] }));
    assert.equal(f.$('.automation-weather-latitude').value, '40.7128');
    assert.equal(f.$('.automation-weather-longitude').value, '-74.006');
    assert.equal(f.$('.automation-weather-timezone').value, 'America/New_York');
    f.$('.automation-weather-latitude').value = '91';
    assert.throws(() => f.ui.readConditions(), /La latitud debe estar entre -90 y 90/);
  });

  test(`${label}: Open-Meteo location failure keeps manual entry available`, (t) => {
    const f = frontend(folder); t.after(() => f.dom.window.close());
    Object.defineProperty(f.window.navigator, 'geolocation', { configurable: true, value: { getCurrentPosition(success, failure) { failure(); } } });
    f.change('.automation-condition-device', 'weather_openmeteo');
    assert.match(f.$('.automation-weather-status').textContent, /No se pudo detectar/);
    f.$('.automation-weather-latitude').value = '1.2345';
    f.$('.automation-weather-longitude').value = '2.3456';
    f.$('.automation-typed-value').value = '20';
    assert.equal(f.ui.readConditions()[0].latitude, 1.2345);
    f.$('.automation-weather-locate').click();
    assert.match(f.$('.automation-weather-status').textContent, /No se pudo detectar/);
  });

  test(`${label}: Open-Meteo solar events use schedule state and valid target actions`, (t) => {
    const f = frontend(folder); t.after(() => f.dom.window.close());
    f.change('.automation-condition-device', 'weather_openmeteo');
    f.change('.automation-condition-path', 'sunrise');
    f.$('.automation-weather-latitude').value = '19.4326';
    f.$('.automation-weather-longitude').value = '-99.1332';
    f.$('.automation-weather-timezone').value = 'UTC';
    assert.equal(f.$('.automation-condition-operator').closest('label').hidden, true);
    assert.equal(f.$('.automation-condition-value-wrap').closest('label').hidden, true);
    assert.equal(f.$('#automation-solar-event').value, 'sunrise');
    assert.equal(f.$('#automation-time').disabled, true);
    assert.equal(JSON.stringify(f.ui.readConditions()[0]), JSON.stringify({ kind: 'parameter', deviceId: 'weather_openmeteo', operator: 'eq', value: true, path: 'sunrise', latitude: 19.4326, longitude: -99.1332, timezone: 'UTC' }));
    assert.match(f.ui.conditionLabel(f.ui.readConditions()[0]), /^es Amanecer \(sunrise\) \(Open-Meteo\)$/);
    f.change('.automation-condition-path', 'temperature');
    assert.equal(f.$('.automation-condition-operator').closest('label').hidden, false);
    assert.equal(f.$('.automation-typed-value').type, 'number');
    assert.equal(f.$('.automation-typed-value').placeholder, '24 °C');
    f.change('.automation-condition-path', 'weather_code');
    assert.equal(f.$('.automation-typed-value').tagName, 'SELECT');
    assert.equal(f.$('.automation-typed-value option').textContent, 'Despejado');
    f.change('#automation-device', 'A');
    assert.equal(f.$('#automation-action').disabled, true);
    assert.equal(f.$('#automation-submit').disabled, true);
  });
}