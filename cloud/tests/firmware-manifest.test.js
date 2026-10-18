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

test('servo cloud dispatcher explicitly recognizes calibration wizard commands', () => {
  const cloudClient = fs.readFileSync(path.join(root, 'dispositivos/servo/cloud_client.py'), 'utf8');
  const dashboard = fs.readFileSync(path.join(root, 'cloud/app.js'), 'utf8');
  const calibrationUi = fs.readFileSync(path.join(root, 'cloud/blind-calibration-ui.js'), 'utf8');
  const calibrationCommands = [
    'blind.safeCalibrationBegin', 'blind.safeCalibrationTest',
    'blind.safeCalibrationDirection', 'blind.safeCalibrationStep',
    'blind.safeCalibrationMark', 'blind.safeCalibrationCancel'
  ];
  assert.match(cloudClient, /BLIND_COMMANDS = \(/);
  assert.match(cloudClient, /elif name in BLIND_COMMANDS:\s+execute_blind_command\(cortina, name, payload\)/);
  assert.match(cloudClient, /def execute_blind_command\(cortina, name, payload\):/);
  assert.match(cloudClient, /Comando de calibracion no soportado:/);
  assert.doesNotMatch(cloudClient, /'blind\.jog'/);
  assert.match(cloudClient, /blind\.safeCalibrationBegin/);
  assert.match(cloudClient, /blind\.safeCalibrationStep/);
  for (const command of calibrationCommands) {
    assert.ok(cloudClient.includes(`'${command}'`), `servo dispatcher must recognize ${command}`);
    if (command !== 'blind.safeCalibrationCancel') assert.ok(calibrationUi.includes(`'${command}'`), `dashboard must send ${command}`);
  }
  assert.match(dashboard, /mountBlindCalibrationWizard/);
});

test('calibration wizard and generic command menu do not send servo actions to GA25', () => {
  for (const folder of ['', 'public', 'public_html', 'legacy-root']) {
    const file = path.join(root, 'cloud', folder, 'app.js');
    const source = fs.readFileSync(file, 'utf8');
    assert.match(source, /const supportsServo = targetModel === 'servo' \|\| \(!targetModel && !\/ga25\/i\.test\(identity\)\)/, folder || 'cloud root');
    assert.match(source, /if \(!supportsServo\) \{ \$\('#calibration-wizard'\)\?\.remove\(\); return; \}/, folder || 'cloud root');
    assert.match(source, /mountBlindCalibrationWizard\(\{ \$, \$\$, apiRequest, loadDevices, getCalibrationPosition, waitForCalibrationCommand, waitForCalibrationIdle, showToast, renderIcons \}\)/, folder || 'cloud root');
    assert.doesNotMatch(source, /'blind\.configure':|'<option value="blind\.configure"/);
    assert.match(source, /const isGa25Device = targetModel === 'ga25' \|\| \(!targetModel && \/ga25\/i\.test\(selectedIdentity\)\)/, folder || 'cloud root');
    assert.match(source, /configureDeviceCommands\(\);\s+renderCalibrationWizard\(\);/, folder || 'cloud root');
  }
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
  assert.match(servoMain, /FIRMWARE_VERSION = '2026\.10\.18\.servo-r8'/);
  assert.match(servoMain, /if recovery_mode:\s+try:\s+wlan\.disconnect\(\)\s+wlan\.active\(False\)/);
  assert.match(servoMain, /COMMAND_POLL_MS = 1000/);
  assert.match(servoMain, /if recovery_mode or not WIFI_SSID:/);
  assert.match(servoMain, /PORTAL_START_DELAY_MS = 60000/);
  assert.match(servoMain, /not connected and not wifi_connect_pending and not portal_started/);
  assert.match(servoMain, /time\.ticks_diff\(now, boot_started_at\) >= PORTAL_START_DELAY_MS/);
  assert.match(servoPortal, /def run\(controller=None, force_ap=False\)/);
  assert.match(servoPortal, /values\['ssid'\] and not force_ap/);
  assert.match(servoLed, /'recovery': \(32, 14, 0\)/);
  assert.match(servoLed, /def tick\(\)/);
  assert.match(servoCloud, /'wifi_recovery\.py'/);
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
  assert.match(cloud, /self\.retry_ms = min\(self\.retry_ms \* 2, 60000\)/);
  assert.match(cloud, /self\.retry_ms = 5000/);
  assert.match(cloud, /gc\.collect\(\)\s+phase = 'TLS handshake'/);
  assert.match(cloud, /socket\.SO_RCVBUF, 2048/);
  assert.match(cloud, /socket\.SO_SNDBUF, 2048/);
  assert.match(cloud, /Heap ESP32 \(total, libre, bloque mayor, minimo libre\)/);
  assert.match(cloud, /idf_heap_info/);
  assert.match(portal, /server\.close\(\)\s+_started = False\s+return/);
  assert.match(ota, /_connection\(api_url, 30\)/);
  assert.match(ota, /client\.connect\(\(host, port\)\)\s+if secure:\s+gc\.collect\(\)/);
  assert.match(ota, /phase = 'TLS handshake'\s+client = tls\.wrap_socket/);
  assert.match(ota, /OTA transporte fallo en/);
  assert.match(ota, /for attempt in range\(2\)/);
  assert.match(ota, /OTA servo: descargando/);
});
