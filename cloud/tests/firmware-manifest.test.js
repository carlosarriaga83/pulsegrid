const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

test('burner and firmware use per-device codes over HTTPS while captive portals save Wi-Fi only', () => {
  const servoMain = fs.readFileSync(path.join(root, 'dispositivos/servo/main.py'), 'utf8');
  const servoCloud = fs.readFileSync(path.join(root, 'dispositivos/servo/cloud_client.py'), 'utf8');
  const servoPortal = fs.readFileSync(path.join(root, 'dispositivos/servo/captive_portal.py'), 'utf8');
  const ga25Main = fs.readFileSync(path.join(root, 'dispositivos/ga25/esp32_motor/main.py'), 'utf8');
  const ga25Portal = fs.readFileSync(path.join(root, 'dispositivos/ga25/esp32_motor/captive_portal.py'), 'utf8');
  const cloudServer = fs.readFileSync(path.join(root, 'cloud/server.js'), 'utf8');
  assert.match(burner, /secrets\.token_hex\(16\)/);
  assert.match(burner, /DEVICE_CODE =/);
  assert.match(burner, /PULSE_\(\[0-9A-Fa-f\]\{12\}\)/);
  for (const source of [servoCloud, ga25Main]) {
    assert.match(source, /X-Device-Code/);
    assert.doesNotMatch(source, /X-API-Key/);
  }
  assert.match(servoMain, /DEVICE_CODE/);
  assert.match(ga25Main, /DEVICE_CODE/);
  assert.match(cloudServer, /device_code_hash CHAR\(64\)/);
  assert.match(cloudServer, /HTTPS is required/);
  assert.doesNotMatch(servoPortal, /name=['"](?:api_key|device_id|device_code|api_url)['"]/);
  assert.doesNotMatch(ga25Portal, /name=(?:api_key|device_id|device_code|api_url|travel|direction_reversed)/);
});

test('servo NeoPixel reflects cloud/provisioning/offline state and OTA retries timeouts', () => {
  const led = fs.readFileSync(path.join(root, 'dispositivos/servo/board_led.py'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'dispositivos/servo/main.py'), 'utf8');
  const cloud = fs.readFileSync(path.join(root, 'dispositivos/servo/cloud_client.py'), 'utf8');
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
  assert.match(ota, /_connection\(api_url, 30\)/);
  assert.match(ota, /client\.connect\(\(host, port\)\)\s+if secure:\s+gc\.collect\(\)/);
  assert.match(ota, /phase = 'TLS handshake'\s+client = tls\.wrap_socket/);
  assert.match(ota, /OTA transporte fallo en/);
  assert.match(ota, /for attempt in range\(2\)/);
  assert.match(ota, /OTA servo: descargando/);
});
