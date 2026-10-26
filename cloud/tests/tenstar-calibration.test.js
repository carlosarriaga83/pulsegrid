const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const root = path.join(__dirname, '..');

function makeWizard(telemetry = {}) {
  telemetry = { firmwareTarget: 'tenstar', calibrationMode: 'open-first-v1', calibration: {}, positionValid: false, moving: false, ...telemetry };
  const dom = new JSDOM('<select id="command-device"><option value="T1" selected>Tenstar</option></select><div class="command-calibration-layout"></div>', { runScripts: 'outside-only' });
  const { window } = dom;
  const device = { id: 'T1', status: 'online', telemetry };
  const requests = [];
  const context = {
    $: (selector, parent = window.document) => parent.querySelector(selector),
    apiRequest: async (endpoint, options) => {
      requests.push({ endpoint, options: options && { ...options, body: options.body && JSON.parse(options.body) } });
      return { commandId: requests.length };
    },
    loadDevices: async () => {},
    waitForCalibrationCommand: async () => {},
    showToast: () => {},
    renderIcons: () => {},
    devices: () => [device],
    parseTelemetry: (value) => typeof value === 'string' ? JSON.parse(value) : value || {}
  };
  window.confirm = () => true;
  const source = fs.readFileSync(path.join(root, 'public/tenstar-calibration-ui.js'), 'utf8');
  vm.runInContext(source, dom.getInternalVMContext());
  window.mountTenstarCalibrationWizard(context);
  return { dom, window, requests, device, context };
}

test('Tenstar wizard is loaded and mounted only through the dedicated cloud path', () => {
  for (const folder of ['', 'public', 'public_html', 'legacy-root']) {
    const base = path.join(root, folder);
    const html = fs.readFileSync(path.join(base, 'index.html'), 'utf8');
    const app = fs.readFileSync(path.join(base, 'app.js'), 'utf8');
    const wizard = fs.readFileSync(path.join(base, 'tenstar-calibration-ui.js'), 'utf8');
    assert.match(html, /tenstar-calibration-ui\.js\?v=2/);
    assert.match(app, /mountTenstarCalibrationWizard/);
    assert.match(wizard, /tenstar\.calibration\.setClosed/);
    assert.match(wizard, /tenstar\.calibration\.begin/);
    assert.match(wizard, /tenstar\.calibration\.step/);
    assert.doesNotMatch(wizard, /tenstar\.jog|tenstar\.calibration\.setOpen/);
    assert.equal(wizard, fs.readFileSync(path.join(root, 'tenstar-calibration-ui.js'), 'utf8'));
  }
});

test('Tenstar wizard starts in open and gates test, direction confirmation, steps and final close', (t) => {
  const f = makeWizard(); t.after(() => f.dom.window.close());
  const $ = (selector) => f.window.document.querySelector(selector);
  assert.equal($('#tenstar-calibration-begin').disabled, false);
  assert.equal($('#tenstar-mark-closed').disabled, true);
  assert.equal($('#tenstar-test-direction').disabled, true);
  Object.assign(f.device.telemetry.calibration, { active: true, open_marked: true });
  f.device.telemetry.positionValid = true;
  $('#command-device').dispatchEvent(new f.window.Event('change'));
  assert.equal($('#tenstar-test-direction').disabled, false);
  assert.equal($('#tenstar-step-down').disabled, true);
  f.device.telemetry.calibration.test_started = true;
  $('#command-device').dispatchEvent(new f.window.Event('change'));
  assert.equal($('#tenstar-test-direction').disabled, true);
  assert.equal($('#tenstar-test-down').disabled, false);
  f.device.telemetry.calibration.direction_confirmed = true;
  $('#command-device').dispatchEvent(new f.window.Event('change'));
  assert.equal($('#tenstar-step-down').disabled, false);
  assert.equal($('#tenstar-mark-closed').disabled, false);
});

test('Tenstar calibration actions dispatch exact turn counts and physical direction', async (t) => {
  const f = makeWizard({ calibration: { active: true, open_marked: true, direction_confirmed: true }, positionValid: true });
  t.after(() => f.dom.window.close());
  const $ = (selector) => f.window.document.querySelector(selector);
  $('#tenstar-calibration-turns').value = '1.75';
  $('#tenstar-step-down').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.requests[0].options.body.command, 'tenstar.calibration.step');
  assert.deepEqual(f.requests[0].options.body.payload, { direction: 'down', turns: 1.75 });
  $('#tenstar-step-up').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.requests[1].options.body.payload, { direction: 'up', turns: 1.75 });
});

test('Tenstar begin confirms open, reset requires confirmation and old firmware is gated', async (t) => {
  const f = makeWizard(); t.after(() => f.dom.window.close());
  const $ = (selector) => f.window.document.querySelector(selector);
  f.window.confirm = () => false;
  $('#tenstar-calibration-begin').click();
  assert.equal(f.requests.length, 0);
  f.window.confirm = () => true;
  $('#tenstar-calibration-begin').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.requests[0].options.body.command, 'tenstar.calibration.begin');
  assert.deepEqual(f.requests[0].options.body.payload, { atOpen: true });
  f.device.telemetry.calibrationMode = undefined;
  $('#command-device').dispatchEvent(new f.window.Event('change'));
  assert.equal($('#tenstar-calibration-begin').disabled, true);
  assert.match($('#tenstar-calibration-state').textContent, /r5/);
});

test('Tenstar stop stays enabled while awaiting a movement command and mount can refresh', async (t) => {
  const f = makeWizard({ calibration: { active: true, open_marked: true, direction_confirmed: true }, positionValid: true });
  t.after(() => f.dom.window.close());
  const $ = (selector) => f.window.document.querySelector(selector);
  $('#tenstar-step-down').click();
  assert.equal($('#tenstar-step-up').disabled, true);
  assert.equal($('#tenstar-stop').disabled, false);
  $('#tenstar-stop').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.requests[1].options.body.command, 'curtain.stop');
  f.window.mountTenstarCalibrationWizard(f.context);
  assert.equal(f.window.document.querySelectorAll('#calibration-wizard').length, 1);
});

test('Tenstar wizard rejects invalid turns and offers reference recovery after reboot', async (t) => {
  const f = makeWizard({ calibration: { active: true, open_marked: true, direction_confirmed: true }, positionValid: true });
  t.after(() => f.dom.window.close());
  const $ = (selector) => f.window.document.querySelector(selector);
  $('#tenstar-calibration-turns').value = '-1';
  $('#tenstar-step-down').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.requests.length, 0);
  assert.match($('#calibration-status').textContent, /vueltas/);
  f.device.telemetry.calibration = { calibrated: true, open_span_pulses: 3960 };
  f.device.telemetry.positionValid = false;
  $('#command-device').dispatchEvent(new f.window.Event('change'));
  assert.equal($('#tenstar-reference-open').disabled, false);
  assert.equal($('#tenstar-step-down').disabled, true);
  $('#tenstar-reference-open').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.requests[0].options.body.command, 'tenstar.calibration.referenceOpen');
});

test('Tenstar offline actions are disabled and API errors remain visible', async (t) => {
  const f = makeWizard(); t.after(() => f.dom.window.close());
  const $ = (selector) => f.window.document.querySelector(selector);
  f.context.apiRequest = async () => { throw new Error('Dispositivo desconectado'); };
  f.window.document.querySelector('#calibration-wizard').remove();
  f.window.mountTenstarCalibrationWizard(f.context);
  $('#tenstar-calibration-begin').click();
  await new Promise((resolve) => setImmediate(resolve));
  f.window.mountTenstarCalibrationWizard(f.context);
  assert.match($('#calibration-status').textContent, /Dispositivo desconectado/);
  f.device.status = 'offline';
  $('#command-device').dispatchEvent(new f.window.Event('change'));
  assert.equal($('#tenstar-calibration-begin').disabled, true);
  assert.equal($('#tenstar-stop').disabled, true);
});
