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
