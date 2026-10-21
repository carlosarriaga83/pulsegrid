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

test('geometry estimate provides a conservative symmetric operating envelope', () => {
  const estimatedTurns = model.estimateTurns(50, 3.5, 0.5, 1);
  assert.ok(estimatedTurns > 1);
  assert.equal(estimatedTurns * 0.4 * 2, estimatedTurns * 0.8);
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
    assert.match(wizard, /blind\.ga25CalibrationStart/);
    assert.doesNotMatch(wizard, /blind\.safeCalibrationTest|positiveIsDown|calibration-test-direction/);
  }
});

test('cloud-first wizard sends one cloud-computed configuration without direction tests or confirmations', () => {
  const root = path.join(__dirname, '..');
  for (const folder of ['', 'public', 'public_html', 'legacy-root']) {
    const html = fs.readFileSync(path.join(root, folder, 'cloud-blind-calibration-ui.js'), 'utf8');
    assert.match(html, /BlindCalibrationModel\.estimateTurns/);
    assert.match(html, /blind\.cloudCalibrationConfigure/);
    assert.match(html, /estimatedTurns/);
    assert.match(html, /calibration-motor-side/);
    assert.match(html, /motorSide: motorSide\.value/);
    assert.match(html, /position_recovery_required/);
    assert.match(html, /toggle del dispositivo/);
    assert.doesNotMatch(html, /safeCalibrationTest|positiveIsDown|Probar una vuelta|Confirmar sentido/);
  }
});

test('cloud exposes confirmed clean calibration reset only for online Servo r32+', () => {
  const root = path.join(__dirname, '..');
  for (const folder of ['', 'public', 'public_html', 'legacy-root']) {
    const ui = fs.readFileSync(path.join(root, folder, 'cloud-blind-calibration-ui.js'), 'utf8');
    const app = fs.readFileSync(path.join(root, folder, 'app.js'), 'utf8');
    const html = fs.readFileSync(path.join(root, folder, 'index.html'), 'utf8');
    assert.match(ui, /blind\.encoderReferenceRecover/);
    assert.match(ui, /device\?\.status !== 'online'/);
    assert.match(ui, /servo-r\(\\d\+\)/);
    assert.match(ui, /Number\(match\[1\]\) >= 32/);
    assert.match(ui, /atMidpoint: true/);
    assert.match(ui, /waitForReferenceTelemetry/);
    assert.match(ui, /Actualiza el dispositivo a Servo r32 o posterior/);
    assert.match(ui, /Reiniciar calibración y referencia aquí/);
    assert.match(ui, /window\.confirm\(/);
    assert.match(ui, /blind_calibrated === false/);
    assert.match(ui, /blind_target_percent\) === 50/);
    assert.match(ui, /recover\.hidden = !isServo/);
    assert.match(ui, /function mountCleanResetControl\(context, wizard\)/);
    assert.match(ui, /if \(existingWizard\)[\s\S]*?mountCleanResetControl\(context, existingWizard\)/);
    assert.match(ui, /servo\?\.multiturn_active === true/);
    assert.match(ui, /Coloca manualmente la cortina cerca de la mitad/);
    assert.match(ui, /No se envió ningún comando/);
    assert.match(ui, /apply\.disabled = !device \|\| device\.status !== 'online'/);
    const renderWizard = app.slice(app.indexOf('function renderCalibrationWizard()'), app.indexOf('\nfunction ', app.indexOf('function renderCalibrationWizard()') + 10));
    assert.ok(renderWizard.indexOf('mountCloudBlindCalibrationWizard') < renderWizard.indexOf("if ($('#calibration-wizard')) return;"), `${folder || 'cloud root'} calls reset injector before returning for an existing wizard`);
    assert.match(html, /cloud-blind-calibration-ui\.js\?v=5/);
    assert.match(html, /app\.js\?v=68/);
  }
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(server, /function validateServoEncoderReference\(/);
  assert.match(server, /command === 'blind\.encoderReferenceRecover'/);
  assert.match(server, /validateServoEncoderReference\(\{ \.\.\.device, telemetry \}, command, payload\)/);
  const firmware = fs.readFileSync(path.join(root, '..', 'dispositivos/servo/cloud_client.py'), 'utf8');
  const cortina = fs.readFileSync(path.join(root, '..', 'dispositivos/servo/cortina.py'), 'utf8');
  assert.match(firmware, /blind\.encoderReferenceRecover/);
  assert.match(firmware, /cortina\.recover_position_reference\(servo_id\)/);
  assert.match(cortina, /def recover_position_reference\(/);
  assert.match(cortina, /self\.absolute_turns\[servo_id\] = 0\.0/);
  assert.match(cortina, /'calibration_in_progress': False/);
  assert.match(cortina, /recupera el punto medio desde Pulsegrid y vuelve a aplicar la calibracion geometrica antes de mover/);
  assert.match(fs.readFileSync(path.join(root, '..', 'dispositivos/servo/main.py'), 'utf8'), /servo-r33/);
});

test('Servo cloud calibration applies limits without starting or polling for movement', () => {
  const root = path.join(__dirname, '..');
  for (const folder of ['', 'public', 'public_html', 'legacy-root']) {
    const app = fs.readFileSync(path.join(root, folder, 'app.js'), 'utf8');
    const wizard = fs.readFileSync(path.join(root, folder, 'blind-calibration-ui.js'), 'utf8');
    const cloudWizard = fs.readFileSync(path.join(root, folder, 'cloud-blind-calibration-ui.js'), 'utf8');
    assert.match(app, /blind_calibration_motion_fault/);
    assert.match(app, /blind_calibration_motion_fault_reason/);
    assert.match(app, /Math\.abs\(position - startPosition\) >= 0\.02/);
    assert.match(app, /waitForCalibrationIdle\(deviceId, servoId, startPosition, timeout = 240000\)/);
    assert.match(app, /waitForCalibrationCommand\(commandId, timeout = 30000\)/);
    assert.match(cloudWizard, /blind\.cloudCalibrationConfigure/);
    assert.match(cloudWizard, /position_recovery_required/);
    assert.doesNotMatch(cloudWizard, /waitForCalibrationIdle|curtain\.move|blind\.safeCalibration/);
    assert.doesNotMatch(wizard, /blind\.safeCalibrationTest|positiveIsDown|calibration-test-direction/);
  }
});

test('servo firmware accepts cloud estimates only with reliable encoder state and bounded envelope', () => {
  const root = path.join(__dirname, '..', '..');
  const firmware = fs.readFileSync(path.join(root, 'dispositivos/servo/servo_calibration.py'), 'utf8');
  const cortina = fs.readFileSync(path.join(root, 'dispositivos/servo/cortina.py'), 'utf8');
  assert.match(firmware, /'half_travel_limit': estimated \* 0\.4/);
  assert.match(firmware, /def configure_cloud_estimate\([\s\S]*?motor_side\)/);
  assert.match(firmware, /'motor_side': motor_side/);
  assert.match(firmware, /def configure_cloud_estimate\(/);
  assert.match(firmware, /position_recovery_required\[servo_id\]/);
  assert.match(firmware, /abs\(calculated - estimated\) > 0\.01/);
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
  assert.match(cortina, /position = self\.bus\.position\(servo_id\)[\s\S]*?delta = self\._track_position\(servo_id, position\)[\s\S]*?task\['net_counts'\] \+= delta[\s\S]*?task\['moved_counts'\] = abs\(task\['net_counts'\]\)/);
  assert.match(cortina, /if task\['moved_counts'\] >= task\['target_counts'\]:/);
  assert.match(cortina, /PRECISION_COMPLETION_TOLERANCE_COUNTS = 16/);
  assert.match(cortina, /task\['moved_counts'\] >= task\['target_counts'\] - self\.PRECISION_COMPLETION_TOLERANCE_COUNTS/);
  assert.match(cortina, /MOVEMENT_STALL_TIMEOUT_MS = 15000/);
  assert.match(cortina, /if delta != 0:[\s\S]*?task\['last_progress_at'\] = time\.ticks_ms\(\)/);
  assert.match(cortina, /fault_reason='encoder_stall'/);
  assert.match(cortina, /fault_reason='encoder_read'/);
  assert.match(cortina, /'encoder_read_error_at': None/);
  assert.match(cortina, /'net_counts': 0/);
  assert.match(cortina, /'timeout_ms': max\(15000, int\(target_counts \/ max\(speed, 1\) \* 5000 \+ 10000\)\)/);
  assert.match(cortina, /self\.bus\.torque\(servo_id, False\)[\s\S]*?self\.bus\.set_mode\(servo_id, 0\)[\s\S]*?hold_position = self\.bus\.position\(servo_id\)/);
  assert.doesNotMatch(cortina, /position_signed\(servo_id\)/);
  assert.match(cortina, /def multiturn_status\(self, servo_id\):[\s\S]*?position = self\._last_positions\.get\(servo_id, 0\)/);
  assert.doesNotMatch(cortina.slice(cortina.indexOf('    def multiturn_status('), cortina.indexOf('    def set_direction_reversed(')), /self\.position\(/);
  assert.match(cortina, /CALIBRATION_STEP_SPEED = 240/);
  assert.match(cortina, /speed = min\(speed, self\.APPROACH_SPEED\)/);
  assert.match(cortina, /APPROACH_COUNTS = COUNTS_PER_TURN \/\/ 16/);
  assert.match(cortina, /task\['target_counts'\] - task\['moved_counts'\] <= self\.APPROACH_COUNTS/);
  assert.match(cortina, /fault_reason = 'position_overshoot'/);
  assert.match(cortina, /MOVEMENT_POSITION_TOLERANCE_COUNTS = int\(COUNTS_PER_TURN \* 20 \/ 360 \+ 0\.5\)/);
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
  assert.match(main, /if not moving and not any\(controller\.multiturn_active\.values\(\)\):[\s\S]*?if time\.ticks_diff\(now, last_state_publish\) >= telemetry_interval:[\s\S]*?client\.telemetry\(controller, FIRMWARE_VERSION/);
  assert.match(main, /elif moving:[\s\S]*?board_led\.set_status\('moving'\)/);
  assert.match(led, /'moving': \(0, 0, 24\)/);
  assert.match(main, /time\.sleep_ms\(10\)/);
  assert.match(cloudClient, /def flush_ack\(self, cortina=None\):[\s\S]*?_pending_ack = self\._deferred_acks\.pop\(0\) if self\._deferred_acks else None/);
  assert.match(cloudClient, /ack = \(command, error, firmware_update, motion_tasks\)[\s\S]*?self\._pending_ack = ack/);
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
    assert.match(wizard, /\.command-calibration-layout'\) \|\|/);
    assert.match(wizard, /function mountBlindCalibrationWizard\(context\)\s*\{\s*if \(context\.getCalibrationDeviceModel\?\.\(\) === 'ga25'\) mountGa25CalibrationWizard\(context\);\s*\}/);
  }
});

test('server validates cloud-computed calibration and rejects legacy interactive commands', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /function validateCloudBlindCalibration\(/);
  assert.match(source, /BlindCalibrationModel\.estimateTurns\(/);
  assert.match(source, /command === 'blind\.cloudCalibrationConfigure'/);
  assert.match(source, /command\.startsWith\('blind\.safeCalibration'\)/);
  assert.match(source, /validateCloudBlindCalibration\(\{ \.\.\.device, telemetry \}, command, payload\)/);
});

test('local servo portal exposes Wi-Fi provisioning only', () => {
  const portal = fs.readFileSync(path.join(__dirname, '..', '..', 'dispositivos/servo/captive_portal.py'), 'utf8');
  assert.match(portal, /action=\/save/);
  assert.doesNotMatch(portal, /action=\/calibration|action=\/control|GET \/status|def _calibration\(|def _control\(/);
  assert.match(portal, /password = values\.get\('password', ''\) or current\['password'\]/);
});

test('direction reversal preserves the calibrated envelope and uses consistent percentages', () => {
  const root = path.join(__dirname, '..', '..');
  const cortina = fs.readFileSync(path.join(root, 'dispositivos/servo/cortina.py'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'dispositivos/servo/main.py'), 'utf8');
  assert.match(cortina, /def _calibrated_target\(self, servo_id, percent\):[\s\S]*?reverse_percent = config\.get\('motor_side', 'left'\) == 'right'[\s\S]*?if self\.direction_reversed:\s+reverse_percent = not reverse_percent[\s\S]*?if reverse_percent:\s+percent = 100 - percent/);
  assert.match(cortina, /def blind_status\(self, servo_id\):[\s\S]*?reverse_percent = config\.get\('motor_side', 'left'\) == 'right'[\s\S]*?if self\.direction_reversed:\s+reverse_percent = not reverse_percent[\s\S]*?if reverse_percent:\s+percent = 100\.0 - percent/);
  assert.match(cortina, /def set_direction_reversed\(self, reversed_value\):\s+self\.direction_reversed = bool\(reversed_value\)\s+self\._save_persistent_state\(\)/);
  assert.match(cortina, /direction_reversed=False\)/);
  assert.match(main, /direction_reversed=bool\(DIRECTION_REVERSED\)/);
  assert.doesNotMatch(main, /controller\.set_direction_reversed\(bool\(DIRECTION_REVERSED\)\)/);
});

test('GA25 local portal only provisions Wi-Fi and preserves a blank password', () => {
  const root = path.join(__dirname, '..', '..');
  const portal = fs.readFileSync(path.join(root, 'dispositivos/ga25/esp32_motor/captive_portal.py'), 'utf8');
  assert.match(portal, /action=\/save/);
  assert.doesNotMatch(portal, /action=\/motor|POST \/motor|def _test_motor\(/);
  assert.match(portal, /Este portal local solo administra la conexión Wi-Fi/);
  assert.match(portal, /values\.get\("password", ""\) or str\(getattr\(current, "WIFI_PASSWORD", ""\)\)/);
});

test('Servo UI distinguishes lost encoder reference from missing geometric calibration', () => {
  const root = path.join(__dirname, '..');
  for (const folder of ['', 'public', 'public_html']) {
    const app = fs.readFileSync(path.join(root, folder, 'app.js'), 'utf8');
    const recoveryCopy = fs.readFileSync(path.join(root, folder, 'cloud-blind-calibration-ui.js'), 'utf8');
    assert.match(app, /Referencia del encoder requerida/);
    assert.match(app, /Calibracion geometrica requerida/);
    assert.match(app, /Recupera referencia y reaplica calibración/);
    assert.match(recoveryCopy, /Reiniciar calibración y referencia aquí/);
    assert.match(recoveryCopy, /borrar todos los límites anteriores/);
    assert.match(recoveryCopy, /Se borrarán las medidas y los límites del servo seleccionado/);
  }
});