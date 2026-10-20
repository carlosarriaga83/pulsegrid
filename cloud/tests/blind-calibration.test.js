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
    const wizard = fs.readFileSync(path.join(root, folder, 'blind-calibration-ui.js'), 'utf8');
    assert.doesNotMatch(wizard, /calibration-width|widthCm|Ancho de ventana/);
    assert.match(wizard, /heightCm/);
  }
});

test('safe-calibration wizard uses bounded commands only and documents manual supervision', () => {
  const root = path.join(__dirname, '..');
  for (const folder of ['', 'public', 'public_html', 'legacy-root']) {
    const html = fs.readFileSync(path.join(root, folder, 'blind-calibration-ui.js'), 'utf8');
    assert.match(html, /blind\.safeCalibrationBegin/);
    assert.match(html, /blind\.safeCalibrationTest/);
    assert.match(html, /blind\.safeCalibrationStep/);
    assert.match(html, /calibration-step-size/);
    assert.match(html, /value="1">1 vuelta/);
    assert.match(html, /Number\(.*calibration-step-size.*value\)/s);
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
    assert.match(app, /blind_calibration_motion_fault_reason/);
    assert.match(app, /Math\.abs\(position - startPosition\) >= 0\.02/);
    assert.match(app, /waitForCalibrationCommand\(commandId, timeout = 30000\)/);
    assert.match(wizard, /getCalibrationPosition/);
    assert.match(wizard, /waitForCalibrationCommand\(result\.commandId, movement \? 120000 : undefined\)|movement\?120000:undefined/);
    assert.match(wizard, /waitForCalibrationIdle\([^\n]*startPosition/s);
  }
});

test('servo calibration firmware enforces a geometry ceiling and persists real encoder endpoints', () => {
  const root = path.join(__dirname, '..', '..');
  const firmware = fs.readFileSync(path.join(root, 'dispositivos/servo/servo_calibration.py'), 'utf8');
  const cortina = fs.readFileSync(path.join(root, 'dispositivos/servo/cortina.py'), 'utf8');
  assert.match(firmware, /'half_travel_limit': estimated \* 0\.4/);
  assert.match(firmware, /TEST_DIRECTION_TURNS = 1\.0/);
  assert.match(firmware, /_start_precision_multiturn\(servo_id, TEST_DIRECTION_TURNS, cortina\.APPROACH_SPEED, 30\)/);
  assert.match(firmware, /def stop_safe\(cortina, servo_id\):/);
  assert.match(firmware, /def stop_safe\(cortina, servo_id\):[\s\S]*?calibration_motion_fault_reason'\] = 'user_stop'/);
  assert.match(firmware, /def cancel_safe\(cortina, servo_id\):[\s\S]*?if cortina\.multiturn_active\[servo_id\]:[\s\S]*?cortina\._finish_multiturn\(servo_id\)[\s\S]*?config\['calibration_in_progress'\] = False/);
  assert.match(firmware, /amount <= 1\.0/);
  assert.match(firmware, /_start_precision_multiturn\(servo_id, signed, cortina\.CALIBRATION_STEP_SPEED, 40\)/);
  assert.match(firmware, /cortina\._save_persistent_state\(\)/);
  assert.match(cortina, /timeout_ms/);
  assert.match(cortina, /def _start_precision_multiturn\(self, servo_id, turns, speed=120, acceleration=30\):/);
  assert.match(cortina, /self\.bus\.set_mode\(servo_id, 3\)/);
  assert.match(cortina, /self\.bus\.set_mode\(servo_id, 0\)[\s\S]*?start_position = self\.bus\.position\(servo_id\)/);
  assert.match(cortina, /self\.bus\.move_multiturn\(servo_id, turns, start_position, speed, acceleration\)/);
  assert.match(cortina, /position = self\.bus\.position\(servo_id\)[\s\S]*?delta = self\._track_position\(servo_id, position\)[\s\S]*?task\['net_counts'\] \+= delta[\s\S]*?task\['moved_counts'\] \+= max\(0, delta \* task\['direction'\]\)/);
  assert.match(cortina, /if task\['moved_counts'\] >= task\['target_counts'\]:/);
  assert.match(cortina, /PRECISION_STALL_TIMEOUT_MS = 15000/);
  assert.match(cortina, /if delta != 0:[\s\S]*?task\['last_progress_at'\] = time\.ticks_ms\(\)/);
  assert.match(cortina, /fault_reason='encoder_stall'/);
  assert.match(cortina, /fault_reason='encoder_read'/);
  assert.match(cortina, /'encoder_read_error_at': None/);
  assert.match(cortina, /'net_counts': 0/);
  assert.match(cortina, /self\.bus\.torque\(servo_id, False\)[\s\S]*?self\.bus\.set_mode\(servo_id, 0\)[\s\S]*?hold_position = self\.bus\.position\(servo_id\)/);
  assert.doesNotMatch(cortina, /position_signed\(servo_id\)/);
  assert.match(cortina, /def multiturn_status\(self, servo_id\):[\s\S]*?position = self\._last_positions\.get\(servo_id, 0\)/);
  assert.doesNotMatch(cortina.slice(cortina.indexOf('    def multiturn_status('), cortina.indexOf('    def set_direction_reversed(')), /self\.position\(/);
  assert.match(cortina, /CALIBRATION_STEP_SPEED = 240/);
  const stservo = fs.readFileSync(path.join(root, 'dispositivos/servo/stservo.py'), 'utf8');
  assert.match(stservo, /def move_multiturn\(self, servo_id, turns, current_position=0, speed=800, acceleration=50\):/);
  assert.match(stservo, /encoded_target = abs\(target\) \| \(\(1 << 15\) if target < 0 else 0\)/);
  assert.match(stservo, /if mode not in \(0, 1, 3\):/);
  assert.match(cortina, /calibration_motion_fault/);
  assert.match(cortina, /movimiento normal bloqueado durante la calibracion segura/);
  const cloudClient = fs.readFileSync(path.join(root, 'dispositivos/servo/cloud_client.py'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'dispositivos/servo/main.py'), 'utf8');
  const led = fs.readFileSync(path.join(root, 'dispositivos/servo/board_led.py'), 'utf8');
  assert.match(cloudClient, /blind\.safeCalibrationStop/);
  assert.match(main, /controller\.update_multiturn\(\)[\s\S]*?moving = any\(controller\.multiturn_active\.values\(\)\)[\s\S]*?if not moving:/);
  assert.match(main, /if not any\(controller\.multiturn_active\.values\(\)\) and time\.ticks_diff/);
  assert.match(main, /elif moving:[\s\S]*?board_led\.set_status\('moving'\)/);
  assert.match(led, /'moving': \(0, 0, 24\)/);
  assert.match(main, /time\.sleep_ms\(10\)/);
  assert.match(cloudClient, /def flush_ack\(self\):[\s\S]*?_pending_ack = self\._deferred_acks\.pop\(0\) if self\._deferred_acks else None/);
  assert.match(cloudClient, /ack = \(command, error, firmware_update\)[\s\S]*?self\._pending_ack = ack/);
  assert.doesNotMatch(cloudClient, /_thread|start_background|_network_loop/);
});

test('cloud command queue prioritizes emergency curtain and calibration stops', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /blind\.safeCalibrationCancel/);
  assert.match(source, /priorityOnly = String\(request\.query\.priorityOnly \|\| ''\) === '1'/);
  assert.match(source, /ORDER BY CASE WHEN command_name IN \('blind\.safeCalibrationStop', 'blind\.safeCalibrationCancel', 'curtain\.stop'\) THEN 0 ELSE 1 END, created_at ASC/);
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