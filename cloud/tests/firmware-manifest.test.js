const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..');
const burner = fs.readFileSync(path.join(root, 'quemador', 'quemador.py'), 'utf8');

function tupleAfter(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing ${marker}`);
  const match = source.slice(start).match(/\(([^)]*)\)/);
  assert.ok(match, `missing tuple after ${marker}`);
  return [...match[1].matchAll(/["']([^"']+)["']/g)].map((item) => item[1]);
}

for (const [model, directory] of [['servo', 'dispositivos/servo'], ['ga25', 'dispositivos/ga25/esp32_motor']]) {
  test(`${model}: burner profile matches firmware and OTA manifests`, () => {
    const profile = burner.slice(burner.indexOf(`"${model}": {`));
    const burnerFiles = tupleAfter(profile, '"files":');
    const main = fs.readFileSync(path.join(root, directory, 'main.py'), 'utf8');
    const firmwareFiles = tupleAfter(main, 'FIRMWARE_FILES =');
    assert.deepEqual(burnerFiles, firmwareFiles);
    for (const file of burnerFiles) assert.equal(fs.existsSync(path.join(root, directory, file)), true, `${model} missing ${file}`);
  });
}

test('persistent calibration/state files are never OTA payloads or burner cleanup targets', () => {
  const servoMain = fs.readFileSync(path.join(root, 'dispositivos/servo/main.py'), 'utf8');
  const servoCloud = fs.readFileSync(path.join(root, 'dispositivos/servo/cloud_client.py'), 'utf8');
  const ga25Main = fs.readFileSync(path.join(root, 'dispositivos/ga25/esp32_motor/main.py'), 'utf8');
  const ga25Portal = fs.readFileSync(path.join(root, 'dispositivos/ga25/esp32_motor/captive_portal.py'), 'utf8');
  const servoCurtain = fs.readFileSync(path.join(root, 'dispositivos/servo/cortina.py'), 'utf8');
  const servoProfile = burner.slice(burner.indexOf('"servo": {'));
  const ga25Profile = burner.slice(burner.indexOf('"ga25": {'));
  for (const file of ['blind_state.py', 'multiturn_state.py']) {
    assert.equal(tupleAfter(servoMain, 'FIRMWARE_FILES =').includes(file), false, `servo OTA must preserve ${file}`);
    assert.equal(tupleAfter(servoCloud, "files = (").includes(file), false, `servo OTA command must preserve ${file}`);
    assert.equal(tupleAfter(servoProfile, '"remove":').includes(file), false, `servo burner cleanup must preserve ${file}`);
  }
  assert.equal(tupleAfter(ga25Main, 'FIRMWARE_FILES =').includes('config.py'), false, 'GA25 OTA must preserve calibration config');
  assert.equal(tupleAfter(ga25Profile, '"files":').includes('config.py'), false, 'GA25 burner must keep config separately generated');
  assert.equal(tupleAfter(ga25Profile, '"remove":').includes('config.py'), false, 'GA25 burner cleanup must preserve config');
  assert.match(ga25Main, /FULL_TRAVEL_MS/);
  assert.match(ga25Main, /recover_config_file\(\)/);
  assert.match(ga25Main, /config\.py\.bak/);
  assert.match(ga25Portal, /CONFIG_FILE \+ "\.bak"/);
  assert.match(servoCurtain, /backup = filename \+ '\.bak'/);
});

test('servo confirms and feeds the transactional OTA watchdog', () => {
  const source = fs.readFileSync(path.join(root, 'dispositivos/servo/main.py'), 'utf8');
  assert.match(source, /ota_boot = sys\.modules\.get\('ota_boot'\)/);
  assert.match(source, /ota_boot\.confirm\(\)/);
  assert.match(source, /ota_boot\.feed\(\)/);
});

test('servo cloud dispatcher explicitly recognizes cloud-first calibration and emergency actions', () => {
  const cloudClient = fs.readFileSync(path.join(root, 'dispositivos/servo/cloud_client.py'), 'utf8');
  const dashboard = fs.readFileSync(path.join(root, 'cloud/app.js'), 'utf8');
  const calibrationUi = fs.readFileSync(path.join(root, 'cloud/cloud-blind-calibration-ui.js'), 'utf8');
  const calibrationCommands = [
    'blind.cloudCalibrationConfigure', 'blind.safeCalibrationStop', 'blind.safeCalibrationCancel'
  ];
  assert.match(cloudClient, /BLIND_COMMANDS = \(/);
  assert.match(cloudClient, /elif name in BLIND_COMMANDS:\s+execute_blind_command\(cortina, name, payload\)/);
  assert.match(cloudClient, /def execute_blind_command\(cortina, name, payload\):/);
  assert.match(cloudClient, /Comando de calibracion no soportado:/);
  assert.doesNotMatch(cloudClient, /'blind\.jog'/);
  assert.match(cloudClient, /blind\.cloudCalibrationConfigure/);
  assert.match(cloudClient, /blind\.encoderReferenceRecover/);
  for (const command of calibrationCommands) {
    assert.ok(cloudClient.includes(`'${command}'`), `servo dispatcher must recognize ${command}`);
    if (command === 'blind.cloudCalibrationConfigure') assert.ok(calibrationUi.includes(command), `dashboard must send ${command}`);
  }
  assert.match(dashboard, /mountCloudBlindCalibrationWizard/);
  assert.match(calibrationUi, /BlindCalibrationModel\.estimateTurns/);
  assert.doesNotMatch(calibrationUi, /safeCalibrationTest|positiveIsDown|Probar una vuelta|Confirmar sentido/);
});

test('calibration wizard selects a timed GA25 flow without sending servo commands', () => {
  for (const folder of ['', 'public', 'public_html', 'legacy-root']) {
    const file = path.join(root, 'cloud', folder, 'app.js');
    const source = fs.readFileSync(file, 'utf8');
    assert.match(source, /const supportsServo = targetModel === 'servo' \|\| \(!targetModel && !\/ga25\/i\.test\(identity\)\)/, folder || 'cloud root');
    assert.match(source, /if \(!supportsServo && !supportsGa25\) \{ \$\('#calibration-wizard'\)\?\.remove\(\); return; \}/, folder || 'cloud root');
    assert.match(source, /getCalibrationDeviceModel/);
    assert.match(source, /mountBlindCalibrationWizard\(\{ \$, \$\$, apiRequest, loadDevices, getCalibrationPosition, waitForCalibrationCommand, waitForCalibrationIdle, getCalibrationDeviceModel, devices: \(\) => devices, parseTelemetry, showToast, renderIcons \}\)/, folder || 'cloud root');
    const calibrationUi = fs.readFileSync(path.join(root, 'cloud', folder, 'blind-calibration-ui.js'), 'utf8');
    const cloudCalibrationUi = fs.readFileSync(path.join(root, 'cloud', folder, 'cloud-blind-calibration-ui.js'), 'utf8');
    assert.match(calibrationUi, /blind\.ga25CalibrationStart/);
    assert.match(calibrationUi, /blind\.ga25CalibrationStop/);
    assert.match(calibrationUi, /blind\.ga25CalibrationCancel/);
    assert.match(calibrationUi, /timed-estimate|sin encoder/i);
    assert.doesNotMatch(source, /'blind\.configure':|'<option value="blind\.configure"/);
    assert.match(source, /const isGa25Device = targetModel === 'ga25' \|\| \(!targetModel && \/ga25\/i\.test\(selectedIdentity\)\)/, folder || 'cloud root');
    assert.match(source, /configureDeviceCommands\(\);\s+renderCalibrationWizard\(\);/, folder || 'cloud root');
    assert.match(source, /mountCloudBlindCalibrationWizard/);
    assert.match(source, /command-calibration-layout/);
    assert.match(cloudCalibrationUi, /blind\.cloudCalibrationConfigure/);
    assert.match(cloudCalibrationUi, /position_recovery_required/);
  }
});

test('GA25 firmware times, bounds, stops, and persists a supervised full-travel calibration', () => {
  const ga25Main = fs.readFileSync(path.join(root, 'dispositivos/ga25/esp32_motor/main.py'), 'utf8');
  assert.match(ga25Main, /blind\.ga25CalibrationStart/);
  assert.match(ga25Main, /blind\.ga25CalibrationStop/);
  assert.match(ga25Main, /blind\.ga25CalibrationCancel/);
  assert.match(ga25Main, /motor\.set_direction_reversed\(DIRECTION_REVERSED\)/);
  assert.doesNotMatch(ga25Main, /motor = CurtainMotor\(ENABLE_PIN, DIRECTION_A_PIN, DIRECTION_B_PIN, values\["full_travel_ms"\]/);
  const ga25Motor = fs.readFileSync(path.join(root, 'dispositivos/ga25/esp32_motor/motor_curtain.py'), 'utf8');
  assert.match(ga25Motor, /a = self\.open_a_level[\s\S]*?b = 1 - self\.open_a_level/);
  assert.match(ga25Motor, /a = 1 - self\.open_a_level[\s\S]*?b = self\.open_a_level/);
  assert.match(ga25Motor, /def set_direction_reversed\(self, reversed_value\)/);
  assert.match(ga25Main, /elapsed < 1000 or elapsed > 120000/);
  assert.match(ga25Main, /motor\.full_travel_ms = elapsed/);
  assert.match(ga25Main, /"full_travel_ms": elapsed/);
  assert.match(ga25Main, /Calibracion GA25 detenida por limite de seguridad/);
});

test('ESP firmware supports three-boot Wi-Fi recovery and faster command polling', () => {
  const cloudServer = fs.readFileSync(path.join(root, 'cloud/server.js'), 'utf8');
  const servoMain = fs.readFileSync(path.join(root, 'dispositivos/servo/main.py'), 'utf8');
  const servoRecovery = fs.readFileSync(path.join(root, 'dispositivos/servo/wifi_recovery.py'), 'utf8');
  const servoPortal = fs.readFileSync(path.join(root, 'dispositivos/servo/captive_portal.py'), 'utf8');
  const servoLed = fs.readFileSync(path.join(root, 'dispositivos/servo/board_led.py'), 'utf8');
  const servoCloud = fs.readFileSync(path.join(root, 'dispositivos/servo/cloud_client.py'), 'utf8');
  const ga25Main = fs.readFileSync(path.join(root, 'dispositivos/ga25/esp32_motor/main.py'), 'utf8');
  const ga25Portal = fs.readFileSync(path.join(root, 'dispositivos/ga25/esp32_motor/captive_portal.py'), 'utf8');
  for (const directory of ['dispositivos/servo', 'dispositivos/ga25/esp32_motor']) {
    const recovery = fs.readFileSync(path.join(root, directory, 'wifi_recovery.py'), 'utf8');
    assert.match(recovery, /RESET_LIMIT = 3/);
    assert.match(recovery, /STABLE_BOOT_MS = 30000/);
    assert.match(recovery, /def clear_counter\(\)/);
    assert.match(recovery, /def register_boot\(count_reset=True\)/);
    assert.match(recovery, /if not count_reset:\s+clear_counter\(\)\s+return False/);
    assert.match(recovery, /RECOVERY_FILE = '\.pulsegrid_wifi_recovery'/);
    assert.match(recovery, /if recovery_latched\(\):\s+return True/);
    assert.match(recovery, /with open\(RECOVERY_FILE, 'w'\)/);
    assert.match(recovery, /STATE_FILE, STATE_TEMP, RECOVERY_FILE/);
  }
  assert.match(servoMain, /recovery_mode = wifi_recovery\.register_boot\(count_reset\)/);
  assert.match(servoMain, /reset_cause in \(getattr\(machine, 'PWRON_RESET', 1\), getattr\(machine, 'HARD_RESET', 2\)\)/);
  const servoVersion = servoMain.match(/FIRMWARE_VERSION = '2026\.10\.21\.servo-r(\d+)'/);
  assert.ok(servoVersion && Number(servoVersion[1]) >= 33, 'Servo firmware must retain r33 movement-tolerance behavior or newer');
  assert.match(servoMain, /if not connected and wifi_connect_pending:[\s\S]*?while \(not connected[\s\S]*?WIFI_CONNECT_TIMEOUT_MS\):\s+time\.sleep_ms\(100\)\s+connected = wlan\.isconnected\(\)/);
  assert.match(servoMain, /if recovery_mode:\s+try:\s+wlan\.disconnect\(\)\s+wlan\.active\(False\)/);
  assert.match(servoMain, /local_portal_enabled = recovery_mode or not connected or not DEVICE_CODE\s+if local_portal_enabled:\s+captive_portal\.start_background\(controller, recovery_mode\)/);
  assert.match(servoMain, /moving = any\(controller\.multiturn_active\.values\(\)\)[\s\S]*?if not moving:/);
  assert.match(servoMain, /elif time\.ticks_diff\(now, last_cloud_poll\) >= MOVEMENT_STOP_POLL_MS[\s\S]*?priority_only=True/);
  assert.match(servoMain, /client\.telemetry\(controller, FIRMWARE_VERSION/);
  assert.match(servoMain, /elif time\.ticks_diff\(now, last_cloud_poll\) >= MOVEMENT_STOP_POLL_MS:[\s\S]*?if not moving and not any\(controller\.multiturn_active\.values\(\)\):[\s\S]*?client\.telemetry\(controller, FIRMWARE_VERSION/);
  assert.match(servoMain, /time\.sleep_ms\(10\)/);
  assert.match(servoPortal, /def run\(controller=None, force_ap=False\)/);
  assert.match(servoPortal, /_thread\.stack_size\(8192\)/);
  assert.match(servoPortal, /data = client\.recv\(512\)[\s\S]*?if length > 1024/);
  assert.match(servoPortal, /values\['ssid'\] and not force_ap/);
  assert.match(servoPortal, /name=password type=password value=''/);
  assert.match(servoPortal, /password = values\.get\('password', ''\) or current\['password'\]/);
  assert.doesNotMatch(servoPortal, /refreshStatus|blind_calibration|action=\/calibration|action=\/control/);
  assert.match(servoPortal, /encoded = body\.encode\(\)[\s\S]*?len\(encoded\)/);
  assert.doesNotMatch(servoPortal, /def _calibration\(|def _control\(|GET \/status/);
  assert.match(servoPortal, /action=\/save/);
  assert.match(servoLed, /'recovery': \(32, 14, 0\)/);
  assert.match(servoLed, /'moving': \(0, 0, 24\)/);
  assert.match(servoLed, /def tick\(\)/);
  assert.match(servoCloud, /'wifi_recovery\.py'/);
  assert.match(servoCloud, /def flush_ack\(self, cortina=None\):[\s\S]*?self\.request\('POST', '\/api\/device-commands/);
  assert.match(servoCloud, /def commands\(self, cortina, led_setter, priority_only=False\)/);
  assert.match(servoCloud, /priorityOnly=1/);
  assert.match(servoCloud, /timeout=3 if priority_only else 8/);
  assert.match(servoCloud, /self\._deferred_acks = \[\]/);
  assert.match(servoCloud, /self\._deferred_acks\.append\(ack\)/);
  assert.match(servoCloud, /self\._connection = None/);
  assert.match(servoCloud, /Connection: close/);
  assert.match(servoCloud, /self\._connection = client/);
  assert.match(cloudServer, /server\.keepAliveTimeout = 15000/);
  assert.match(cloudServer, /server\.headersTimeout = 20000/);
  assert.doesNotMatch(servoCloud, /_thread|_network_loop/);
  assert.match(ga25Main, /POLL_MS = 1000/);
  assert.match(ga25Main, /recovery_mode = wifi_recovery\.register_boot\(count_reset\)/);
  assert.match(ga25Main, /reset_cause in \(getattr\(machine, "PWRON_RESET", 1\), getattr\(machine, "HARD_RESET", 2\)\)/);
  assert.match(ga25Main, /if recovery_mode:\s+try:\s+if wifi_station:\s+wifi_station\.disconnect\(\)\s+wifi_station\.active\(False\)/);
  assert.match(ga25Main, /if not recovery_mode and time\.ticks_diff\(now, next_wifi_retry\) >= 0/);
  assert.match(ga25Portal, /def run\(motor=None, force_ap=False\)/);
  assert.match(ga25Portal, /not force_ap and wifi_ssid/);
  assert.match(cloudServer, /'wifi_recovery\.py'/);
});

test('Cloud dashboard commands have an authenticated API route and validate LED payloads', () => {
  const cloudServer = fs.readFileSync(path.join(root, 'cloud/server.js'), 'utf8');
  assert.match(cloudServer, /app\.post\('\/api\/commands', requireSession, apiReady/);
  assert.match(cloudServer, /queueUserDeviceCommand\(database\(\), request\.session\.user\.email, deviceId, command, payload\)/);
  assert.match(cloudServer, /return dispatchDeviceCommand\(db, devices\[0\], name, payload\)/);
  assert.match(cloudServer, /command !== 'led\.configure'/);
  assert.match(cloudServer, /typeof payload\.enabled !== 'boolean'/);
});

test('authenticated ESP32 polls and command ACKs refresh the online heartbeat', () => {
  const cloudServer = fs.readFileSync(path.join(root, 'cloud/server.js'), 'utf8');
  const pollRouteStart = cloudServer.indexOf("app.get('/api/device-commands'");
  const ackRouteStart = cloudServer.indexOf("app.post('/api/device-commands/:commandId/ack'");
  const versionRouteStart = cloudServer.indexOf("app.get('/api/version'");
  assert.notEqual(pollRouteStart, -1);
  assert.ok(ackRouteStart > pollRouteStart);
  assert.ok(versionRouteStart > ackRouteStart);
  const pollRoute = cloudServer.slice(pollRouteStart, ackRouteStart);
  const ackRoute = cloudServer.slice(ackRouteStart, versionRouteStart);
  for (const route of [pollRoute, ackRoute]) {
    assert.match(route, /deviceForCode\(request\.get\('x-device-code'\), deviceId\)/);
    assert.match(route, /if \(!authenticated\) return fail\(response, 401, 'Invalid device code'\)/);
    assert.match(route, /UPDATE devices SET status = 'online', last_seen = NOW\(\) WHERE id = \?/);
  }
  const devicesRoute = cloudServer.slice(cloudServer.indexOf("app.get('/api/devices'"), cloudServer.indexOf("app.post('/api/devices'"));
  assert.match(devicesRoute, /devices\.last_seen >= DATE_SUB\(NOW\(\), INTERVAL 90 SECOND\)/);
});

test('burner and firmware use per-device codes over HTTPS while captive portals save Wi-Fi only', () => {
  const servoMain = fs.readFileSync(path.join(root, 'dispositivos/servo/main.py'), 'utf8');
  const servoCloud = fs.readFileSync(path.join(root, 'dispositivos/servo/cloud_client.py'), 'utf8');
  const servoPortal = fs.readFileSync(path.join(root, 'dispositivos/servo/captive_portal.py'), 'utf8');
  const ga25Main = fs.readFileSync(path.join(root, 'dispositivos/ga25/esp32_motor/main.py'), 'utf8');
  const ga25Portal = fs.readFileSync(path.join(root, 'dispositivos/ga25/esp32_motor/captive_portal.py'), 'utf8');
  const cloudServer = fs.readFileSync(path.join(root, 'cloud/server.js'), 'utf8');
  const ga25Led = fs.readFileSync(path.join(root, 'dispositivos/ga25/esp32_motor/main.py'), 'utf8');
  assert.match(burner, /DEVICE_CODE_DOMAIN = "pulsegrid-device-code-v1:"/);
  assert.match(burner, /hashlib\.sha256\(\(DEVICE_CODE_DOMAIN \+ mac\)\.encode\("ascii"\)\)\.hexdigest\(\)\[:32\]\.upper\(\)/);
  assert.match(burner, /def normalize_mac_address\(value\)/);
  assert.match(burner, /def device_code_from_mac\(value\)/);
  assert.match(burner, /MAC \(12 hex\)/);
  assert.match(burner, /text="Calcular codigo"/);
  assert.match(burner, /def calculate_device_code\(self\)/);
  assert.match(burner, /normalize_mac_address\(settings\["mac"\]\) != mac/);
  assert.match(burner, /DEVICE_CODE =/);
  assert.match(burner, /PULSE_\(\[0-9A-Fa-f\]\{12\}\)/);
  for (const source of [servoCloud, ga25Main]) {
    assert.match(source, /X-Device-Code/);
    assert.doesNotMatch(source, /X-API-Key/);
  }
  assert.match(servoMain, /DEVICE_CODE/);
  assert.match(ga25Main, /DEVICE_CODE/);
  assert.match(cloudServer, /device_code_hash CHAR\(64\)/);
  assert.match(cloudServer, /function deviceIdFromCode\(deviceCode\)/);
  assert.match(cloudServer, /const deviceId = deviceIdFromCode\(deviceCode\)/);
  assert.match(cloudServer, /HTTPS is required/);
  assert.match(ga25Led, /led_override = payload\["enabled"\]\s+status_led\.set\(led_override\)/);
  assert.match(ga25Led, /if led_override is False:\s+status_led\.set\(False\)/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'cloud/public/index.html'), 'utf8'), /name="id" required/);
  assert.match(fs.readFileSync(path.join(root, 'cloud/public/index.html'), 'utf8'), /name="deviceCode" required minlength="44"/);
  const idContext = { crypto: require('node:crypto') };
  const identityStart = cloudServer.indexOf('function deviceIdFromCode(');
  const identityEnd = cloudServer.indexOf('function secureDeviceRequest(', identityStart);
  vm.runInNewContext(cloudServer.slice(identityStart, identityEnd), idContext);
  assert.equal(idContext.deviceIdFromCode('aabbccddeeff' + '1'.repeat(32)), 'PULSE_AABBCCDDEEFF');
  const mac = 'AABBCCDDEEFF';
  const expectedCode = mac + require('node:crypto').createHash('sha256').update('pulsegrid-device-code-v1:' + mac, 'ascii').digest('hex').slice(0, 32).toUpperCase();
  assert.equal(expectedCode.length, 44);
  assert.equal(expectedCode.slice(0, 12), mac);
  assert.doesNotMatch(servoPortal, /name=['"](?:api_key|device_id|device_code|api_url)['"]/);
  assert.doesNotMatch(ga25Portal, /name=(?:api_key|device_id|device_code|api_url|travel|direction_reversed)/);
});

test('burner displays and logs the device code only after a successful firmware load', () => {
  assert.match(burner, /elif kind == "device-code":\s+self\.device_code\.set\(value\)/);
  assert.match(burner, /CODIGO UNICO DEL DISPOSITIVO: \{\}/);
  assert.match(burner, /self\.events\.put\(\("device-code", settings\["device_code"\]\)\)[\s\S]*?self\._finish\("Carga terminada correctamente"\)/);
  assert.match(burner, /\["mpremote", "connect", port, "reset"\]/);
  assert.match(burner, /else:\s+if not settings\["flash_micropython"\]:\s+self\._log\("Reiniciando MicroPython\.\.\."\)/);
});

test('burner retries transient raw REPL failures after flashing MicroPython', () => {
  assert.match(burner, /MPREMOTE_RETRY_ATTEMPTS = 5/);
  assert.match(burner, /self\._log\("MicroPython instalado\. Esperando reinicio\.\.\."\)\s+time\.sleep\(2\)/);
  assert.match(burner, /transient_errors = \("could not enter raw repl"/);
  assert.match(burner, /self\._run_tool\(command, allow_error=True\)/);
  assert.match(burner, /time\.sleep\(MPREMOTE_RETRY_DELAY_SECONDS\)/);
  assert.match(burner, /self\._run_mpremote\(port, \[\s+"exec"/);
  assert.match(burner, /self\._run_mpremote\(port, \["fs", "cp"/);
});

test('servo NeoPixel reflects cloud/provisioning/offline state and OTA retries timeouts', () => {
  const led = fs.readFileSync(path.join(root, 'dispositivos/servo/board_led.py'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'dispositivos/servo/main.py'), 'utf8');
  const cloud = fs.readFileSync(path.join(root, 'dispositivos/servo/cloud_client.py'), 'utf8');
  const portal = fs.readFileSync(path.join(root, 'dispositivos/servo/captive_portal.py'), 'utf8');
  const ota = fs.readFileSync(path.join(root, 'dispositivos/servo/pulsegrid_ota.py'), 'utf8');
  assert.match(led, /'online': \(0, 24, 0\)/);
  assert.match(led, /'provisioning': \(24, 16, 0\)/);
  assert.match(led, /'offline': \(24, 0, 0\)/);
  assert.match(led, /def is_enabled\(\)/);
  assert.match(main, /board_led\.set_status\('provisioning'\)/);
  assert.match(main, /board_led\.set_status\('offline'\)/);
  assert.match(main, /board_led\.set_status\('online'\)/);
  assert.match(cloud, /def is_online\(self, max_age_ms=30000\)/);
  assert.match(cloud, /delay = 1000/);
  assert.match(cloud, /phase = 'TLS handshake \{\}'\.format\(destination\[0\]\)\s+self\._log_heap\('antes del handshake TLS'\)\s+secure_client = tls\.wrap_socket/);
  assert.doesNotMatch(cloud, /socket\.SO_RCVBUF, 512|socket\.SO_SNDBUF, 512/);
  assert.match(cloud, /self\._log_heap\('antes del handshake TLS'\)/);
  assert.match(cloud, /self\._log_heap\('tras recuperar'\)/);
  assert.match(cloud, /def _send_all\(client, data\):[\s\S]*?writer = getattr\(client, 'write', None\)[\s\S]*?writer\(data\[sent:\]\)/);
  assert.match(cloud, /def _recv\(client, size\):[\s\S]*?reader = getattr\(client, 'read', None\)[\s\S]*?reader\(size\)/);
  assert.match(cloud, /Connection: close/);
  assert.match(cloud, /_send_all\(client, \(request \+ '\\r\\n'\)\.encode\(\) \+ body_bytes\)/);
  assert.doesNotMatch(cloud, /client\.sendall\(/);
  assert.match(cloud, /Heap ESP32 \{\} \(total, libre, bloque mayor, minimo libre\)/);
  assert.match(cloud, /idf_heap_info/);
  assert.match(portal, /if station\.isconnected\(\) and not force_ap:[\s\S]*?PORTAL_HOST = station\.ifconfig\(\)\[0\]/);
  assert.match(portal, /elif not ap\.active\(\):\s+_enable_ap\(ap\)/);
  assert.match(ota, /_connection\(api_url, 30\)/);
  assert.match(ota, /client\.connect\(\(host, port\)\)\s+if secure:\s+gc\.collect\(\)/);
  assert.match(ota, /phase = 'TLS handshake'\s+client = tls\.wrap_socket/);
  assert.match(ota, /def _send_all\(client, data\):[\s\S]*?writer = getattr\(client, 'write', None\)/);
  assert.match(ota, /def _recv\(client, size\):[\s\S]*?reader = getattr\(client, 'read', None\)/);
  assert.match(ota, /_send_all\(client, 'GET \{\} HTTP\/1\.1/);
  assert.match(ota, /OTA transporte fallo en/);
  assert.match(ota, /for attempt in range\(2\)/);
  assert.match(ota, /OTA servo: descargando/);
});

test('Servo low-memory MicroPython profile enables dynamic TLS buffers without reducing record size', () => {
  const profile = path.join(root, 'dispositivos/servo/micropython-board/PULSEGRID_SERVO');
  const board = fs.readFileSync(path.join(profile, 'mpconfigboard.cmake'), 'utf8');
  const sdkconfig = fs.readFileSync(path.join(profile, 'sdkconfig.tls-lowmem'), 'utf8');
  const notes = fs.readFileSync(path.join(root, 'dispositivos/servo/micropython-board/README.md'), 'utf8');
  assert.match(board, /boards\/mpconfigboard_esp32_common\.cmake/);
  assert.match(board, /boards\/sdkconfig\.csi/);
  assert.match(board, /sdkconfig\.tls-lowmem/);
  assert.match(sdkconfig, /CONFIG_MBEDTLS_SSL_PROTO_DTLS=n/);
  assert.match(sdkconfig, /CONFIG_MBEDTLS_DYNAMIC_BUFFER=y/);
  assert.match(sdkconfig, /CONFIG_ESP_WIFI_STATIC_RX_BUFFER_NUM=6/);
  assert.doesNotMatch(sdkconfig, /CONFIG_MBEDTLS_SSL_IN_CONTENT_LEN=/);
  assert.match(notes, /no establece un tamaño máximo de registro inferior/);
  assert.match(notes, /blind_state\.py.*multiturn_state\.py/);
});
