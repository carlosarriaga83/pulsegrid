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
