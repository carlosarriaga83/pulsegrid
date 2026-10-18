const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function tuyaBackend(response) {
  const context = vm.createContext({
    tuyaTokens: new Map([['42', { token: 'cached-token', expiresAt: Infinity }]]),
    tuyaToken: async () => ({ config: { clientId: 'client-id' }, token: 'cached-token' }),
    tuyaSignature: () => 'signature',
    tuyaHttp: async () => response,
    Date
  });
  const helperStart = server.indexOf('function tuyaErrorMessage(');
  const requestStart = server.indexOf('async function tuyaRequestRaw(', helperStart);
  const requestEnd = server.indexOf('\nfunction recordAutomationTroubleshooting(', requestStart);
  assert.notEqual(helperStart, -1);
  assert.notEqual(requestStart, -1);
  assert.notEqual(requestEnd, -1);
  vm.runInContext(server.slice(helperStart, requestStart) + server.slice(requestStart, requestEnd), context);
  return context;
}

test('Tuya permission-denied error explains the cloud API authorization needed and retains its code', async () => {
  const backend = tuyaBackend({ success: false, code: 28841105, msg: 'permission deny' });
  await assert.rejects(backend.tuyaRequestRaw(42, 'POST', '/v1.0/devices/id/commands', { commands: [] }), (error) => {
    assert.match(error.message, /28841105/);
    assert.match(error.message, /autoriza.*API de control de dispositivos/i);
    assert.equal(error.tuyaTrace.response.code, 28841105);
    return true;
  });
  assert.equal(backend.tuyaTokens.has('42'), true, 'permission errors must not invalidate a valid token');
});

test('Tuya token errors still invalidate the cached token', async () => {
  const backend = tuyaBackend({ success: false, code: 1010, msg: 'token invalid' });
  await assert.rejects(backend.tuyaRequestRaw(42, 'POST', '/v1.0/devices/id/commands', { commands: [] }), /token invalid/);
  assert.equal(backend.tuyaTokens.has('42'), false);
});
