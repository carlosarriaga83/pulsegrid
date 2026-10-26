const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const root = path.join(__dirname, '..');

function makeWizard(telemetry = { firmwareTarget: 'tenstar', calibration: {}, positionValid: false, moving: false }) {
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
  return { dom, window, requests, device };
}

test('Tenstar wizard is loaded and mounted only through the dedicated cloud path', () => {
  for (const folder of ['', 'public', 'public_html', 'legacy-root']) {
    const base = path.join(root, folder);
    const html = fs.readFileSync(path.join(base, 'index.html'), 'utf8');
    const app = fs.readFileSync(path.join(base, 'app.js'), 'utf8');
    const wizard = fs.readFileSync(path.join(base, 'tenstar-calibration-ui.js'), 'utf8');
    assert.match(html, /tenstar-calibration-ui\.js\?v=1/);
    assert.match(app, /mountTenstarCalibrationWizard/);
    assert.match(wizard, /tenstar\.calibration\.setClosed/);
    assert.match(wizard, /tenstar\.calibration\.setOpen/);
    assert.match(wizard, /durationMs: 350/);
  }
});

test('Tenstar wizard gates endpoint marking and jogging on online telemetry and closed reference', (t) => {
  const f = makeWizard(); t.after(() => f.dom.window.close());
  const $ = (selector) => f.window.document.querySelector(selector);
  assert.equal($('#tenstar-mark-closed').disabled, false);
  assert.equal($('#tenstar-jog-positive').disabled, true);
  f.device.telemetry.calibration.closed_marked = true;
  f.device.telemetry.positionValid = true;
  $('#command-device').dispatchEvent(new f.window.Event('change'));
  assert.equal($('#tenstar-jog-positive').disabled, false);
  assert.equal($('#tenstar-mark-open').disabled, false);
});

test('Tenstar calibration actions dispatch endpoint marks and short supervised jogs', async (t) => {
  const f = makeWizard({ firmwareTarget: 'tenstar', calibration: { closed_marked: true, calibrated: false }, positionValid: true, moving: false, minimumSpeedPct: 30 });
  t.after(() => f.dom.window.close());
  const $ = (selector) => f.window.document.querySelector(selector);
  $('#tenstar-jog-positive').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.requests[0].options.body.command, 'tenstar.jog');
  assert.deepEqual(f.requests[0].options.body.payload, { direction: 1, speedPct: 30, durationMs: 350 });
});
