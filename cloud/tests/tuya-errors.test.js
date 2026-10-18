const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function tuyaBackend(response) {
  const responses = Array.isArray(response) ? response : [response];
  let tokenRequests = 0;
  const context = vm.createContext({
    tuyaTokens: new Map([['42', { token: 'cached-token', expiresAt: Infinity }]]),
    tuyaToken: async () => ({ config: { clientId: 'client-id' }, token: `token-${++tokenRequests}` }),
    tuyaSignature: () => 'signature',
    tuyaHttp: async () => responses.shift(),
    Date,
    tokenRequestCount: () => tokenRequests
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

test('Tuya 1106 permission-denied error explains API, data-center, and account-link checks', async () => {
  const backend = tuyaBackend({ success: false, code: 1106, msg: 'permission deny' });
  await assert.rejects(backend.tuyaRequestRaw(42, 'POST', '/v1.0/devices/id/commands', { commands: [] }), (error) => {
    assert.match(error.message, /1106/);
    assert.match(error.message, /API de control de dispositivos/i);
    assert.match(error.message, /centro de datos/i);
    assert.match(error.message, /cuenta de la app/i);
    assert.equal(error.tuyaTrace.response.code, 1106);
    return true;
  });
  assert.equal(backend.tuyaTokens.has('42'), true, 'permission errors must not invalidate a valid token');
});

test('Tuya retries once with a fresh token after an explicit invalid-token response', async () => {
  const backend = tuyaBackend([
    { success: false, code: 1010, msg: 'token invalid' },
    { success: true, result: { success: true } }
  ]);
  const trace = await backend.tuyaRequestRaw(42, 'POST', '/v1.0/devices/id/commands', { commands: [] });
  assert.equal(trace.response.success, true);
  assert.equal(backend.tokenRequestCount(), 2);
  assert.equal(backend.tuyaTokens.has('42'), false, 'the rejected cached token must be discarded before retry');
});

test('Tuya stops after a second invalid-token response and leaves no stale cache entry', async () => {
  const backend = tuyaBackend([
    { success: false, code: 1010, msg: 'token invalid' },
    { success: false, code: 1011, msg: 'token expired' }
  ]);
  await assert.rejects(backend.tuyaRequestRaw(42, 'POST', '/v1.0/devices/id/commands', { commands: [] }), /token expired/);
  assert.equal(backend.tokenRequestCount(), 2);
  assert.equal(backend.tuyaTokens.has('42'), false);
});
