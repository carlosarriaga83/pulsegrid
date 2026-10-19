const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const model = require('../blind-calibration-model');

test('geometry estimator accounts for fabric thickness and motor/tube ratio', () => {
  const tubeTurns = model.estimateTurns(150, 5, 0.5);
  assert.ok(tubeTurns > 8 && tubeTurns < 10);
  assert.equal(model.estimateTurns(150, 5, 0.5, 2), tubeTurns * 2);
});

test('geometry estimator rejects unsafe or missing inputs', () => {
  assert.throws(() => model.estimateTurns(10, 5, 0.5), /altura/);
  assert.throws(() => model.estimateTurns(150, 0, 0.5), /diámetro/);
  assert.throws(() => model.estimateTurns(150, 5, 0), /grosor/);
  assert.throws(() => model.estimateTurns(150, 5, 0.5, 0), /relación/);
});

test('50 cm travel estimate leaves room for the fixed one-turn direction test', () => {
  const estimatedTurns = model.estimateTurns(50, 3.5, 0.5, 1);
  assert.ok(estimatedTurns * 0.4 >= 1, `preventive limit should allow one turn; estimated ${estimatedTurns} turns`);
});

test('all deployed static copies use the same estimator implementation', () => {
  const root = path.join(__dirname, '..');
  for (const folder of ['', 'public', 'public_html', 'legacy-root']) {
    const source = fs.readFileSync(path.join(root, folder, 'blind-calibration-model.js'), 'utf8');
    assert.match(source, /function estimateTurns\(heightCm, tubeDiameterCm, fabricThicknessMm, motorTurnsPerTubeTurn = 1\)/);
    assert.match(source, /tubeTurns \* ratio/);
    const copy = require(path.join(root, folder, 'blind-calibration-model.js'));
    assert.equal(copy.estimateTurns(150, 5, 0.5, 2), model.estimateTurns(150, 5, 0.5, 2));
  }
});

test('safe-calibration wizard uses bounded commands only and documents manual supervision', () => {
  const root = path.join(__dirname, '..');
  for (const folder of ['', 'public', 'public_html', 'legacy-root']) {
    const html = fs.readFileSync(path.join(root, folder, 'blind-calibration-ui.js'), 'utf8');
    assert.match(html, /blind\.safeCalibrationBegin/);
    assert.match(html, /blind\.safeCalibrationTest/);
    assert.match(html, /blind\.safeCalibrationStep/);
    assert.match(html, /turns: ?\.125|turns: 0\.125/);
    assert.match(html, /calibration-midpoint-confirm/);
    assert.match(html, /El encoder no detecta fuerza|no detecta fuerza/);
    assert.match(html, /Límite preventivo \(80% de la mitad estimada\)/);
    assert.match(html, /blind\.safeCalibrationStop/);
    assert.match(html, /(?:setDisabled|disable)\('calibration-stop', phase === 'measure' \|\| phase === 'done'\)/);
    assert.match(html, /blind\.safeCalibrationCancel/);
    assert.match(html, /phase='measure'|phase = 'measure'/);
    assert.doesNotMatch(html, /blind\.jog|blind\.configure|blind\.markRolled|blind\.markDeployed/);
  }
});

test('all dashboard copies verify encoder displacement and surface motion faults', () => {
  const root = path.join(__dirname, '..');
  for (const folder of ['', 'public', 'public_html', 'legacy-root']) {
    const app = fs.readFileSync(path.join(root, folder, 'app.js'), 'utf8');
    const wizard = fs.readFileSync(path.join(root, folder, 'blind-calibration-ui.js'), 'utf8');
    assert.match(app, /blind_calibration_motion_fault/);
    assert.match(app, /Math\.abs\(position - startPosition\) >= 0\.02/);
    assert.match(wizard, /getCalibrationPosition/);
    assert.match(wizard, /waitForCalibrationIdle\([^\n]*startPosition/s);
  }
});

test('servo calibration firmware enforces a geometry ceiling and persists real encoder endpoints', () => {
  const root = path.join(__dirname, '..', '..');
  const firmware = fs.readFileSync(path.join(root, 'dispositivos/servo/servo_calibration.py'), 'utf8');
  const cortina = fs.readFileSync(path.join(root, 'dispositivos/servo/cortina.py'), 'utf8');
  assert.match(firmware, /'half_travel_limit': estimated \* 0\.4/);
  assert.match(firmware, /TEST_DIRECTION_TURNS = 1\.0/);
  assert.match(firmware, /_start_multiturn\(servo_id, TEST_DIRECTION_TURNS, cortina\.APPROACH_SPEED, 30\)/);
  assert.match(firmware, /def stop_safe\(cortina, servo_id\):/);
  assert.match(firmware, /def cancel_safe\(cortina, servo_id\):[\s\S]*?if cortina\.multiturn_active\[servo_id\]:[\s\S]*?cortina\._finish_multiturn\(servo_id\)[\s\S]*?config\['calibration_in_progress'\] = False/);
  assert.match(firmware, /amount <= 0\.125/);
  assert.match(firmware, /cortina\._save_persistent_state\(\)/);
  assert.match(cortina, /timeout_ms/);
  assert.match(cortina, /calibration_motion_fault/);
  assert.match(cortina, /movimiento normal bloqueado durante la calibracion segura/);
  const cloudClient = fs.readFileSync(path.join(root, 'dispositivos/servo/cloud_client.py'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'dispositivos/servo/main.py'), 'utf8');
  assert.match(cloudClient, /blind\.safeCalibrationStop/);
  assert.match(main, /CALIBRATION_COMMAND_POLL_MS = 200/);
});

test('cloud command queue prioritizes emergency curtain and calibration stops', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /ORDER BY CASE WHEN command_name IN \('blind\.safeCalibrationStop', 'curtain\.stop'\) THEN 0 ELSE 1 END, created_at ASC/);
});

test('all dashboard copies provide a distinct timed GA25 calibration flow', () => {
  const root = path.join(__dirname, '..');
  for (const folder of ['', 'public', 'public_html', 'legacy-root']) {
    const wizard = fs.readFileSync(path.join(root, folder, 'blind-calibration-ui.js'), 'utf8');
    assert.match(wizard, /function mountGa25CalibrationWizard\(context\)/);
    assert.match(wizard, /blind\.ga25CalibrationStart/);
    assert.match(wizard, /blind\.ga25CalibrationStop/);
    assert.match(wizard, /blind\.ga25CalibrationCancel/);
    assert.match(wizard, /sin encoder/);
    assert.match(wizard, /getCalibrationDeviceModel\(\) !== 'ga25'/);
  }
});