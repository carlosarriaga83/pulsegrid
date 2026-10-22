const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('mobile auth stores only token hashes and uses short access plus renewable refresh tokens', () => {
  assert.match(server, /CREATE TABLE IF NOT EXISTS mobile_tokens/);
  assert.match(server, /function mobileTokenHash\(token\)/);
  assert.match(server, /crypto\.createHash\('sha256'\)\.update\(String\(token\)\)/);
  assert.match(server, /MOBILE_ACCESS_TOKEN_TTL_SECONDS = 15 \* 60/);
  assert.match(server, /MOBILE_REFRESH_TOKEN_TTL_DAYS = 30/);
  assert.match(server, /crypto\.randomBytes\(32\)\.toString\('base64url'\)/);
  assert.match(server, /crypto\.randomBytes\(48\)\.toString\('base64url'\)/);
  assert.match(server, /token_type ENUM\('access','refresh'\)/);
});

test('refresh rotates the token family and replay/logout revokes all active tokens', () => {
  const refreshStart = server.indexOf("app.post('/api/mobile/auth/refresh'");
  const logoutStart = server.indexOf("app.post('/api/mobile/auth/logout'");
  const refresh = server.slice(refreshStart, logoutStart);
  assert.ok(refreshStart >= 0 && logoutStart > refreshStart);
  assert.match(refresh, /beginTransaction\(\)/);
  assert.match(refresh, /FOR UPDATE/);
  assert.match(refresh, /UPDATE mobile_tokens SET revoked_at = NOW\(\) WHERE session_id = \? AND revoked_at IS NULL/);
  assert.match(refresh, /issueMobileTokens\(connection,[\s\S]*?token\.sessionId/);
  assert.match(refresh, /token\.revokedAt \|\| Boolean\(token\.expired\)/);
  assert.match(refresh, /token expirado o reutilizado/i);
  assert.match(server.slice(logoutStart, server.indexOf("app.get('/api/mobile/me'", logoutStart)), /UPDATE mobile_tokens SET revoked_at = COALESCE/);
});

test('mobile API endpoints require bearer auth and retain user ownership checks', () => {
  assert.match(server, /function bearerToken\(request\)/);
  assert.match(server, /function requireMobileAuth\(request, response, next\)/);
  assert.match(server, /Authorization|authorization/);
  for (const endpoint of [
    "app.get('/api/mobile/devices', apiReady, requireMobileAuth",
    "app.post('/api/mobile/devices', apiReady, requireMobileAuth",
    "app.get('/api/mobile/telemetry', apiReady, requireMobileAuth",
    "app.get('/api/mobile/commands', apiReady, requireMobileAuth",
    "app.post('/api/mobile/commands', apiReady, requireMobileAuth"
  ]) assert.ok(server.includes(endpoint), `missing authenticated ${endpoint}`);
  assert.match(server, /WHERE devices\.user_id = \(SELECT id FROM users WHERE email = \?\)/);
  assert.match(server, /queueUserDeviceCommand\(database\(\), request\.mobileUser\.email/);
  assert.match(server, /app\.post\('\/api\/login'/);
  assert.match(server, /app\.use\(cookieSession\(/);
});