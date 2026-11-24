/**
 * Cliente HTTP REST para el backend de PulseGrid (/api/*)
 */

async function request(path, options = {}) {
  const config = {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  };

  const response = await fetch(path, config);
  const data = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));

  if (response.status === 401 && !String(path).startsWith('/api/auth/')) {
    window.dispatchEvent(new CustomEvent('pg:unauthorized'));
  }

  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `Error HTTP ${response.status}`);
  }
  return data;
}

export const api = {
  getHealth: () => request('/api/health'),
  getDevices: (refresh = false) => request(`/api/devices${refresh ? '?refresh=true' : ''}`),
  syncDevices: () => request('/api/devices/sync', { method: 'POST' }),
  seedDemoDevices: () => request('/api/devices/demo', { method: 'POST' }),
  clearDemoDevices: () => request('/api/devices/demo', { method: 'DELETE' }),
  sendCommands: (deviceId, commands) =>
    request(`/api/devices/${encodeURIComponent(deviceId)}/commands`, {
      method: 'POST',
      body: JSON.stringify({ commands }),
    }),
  updateDevice: (deviceId, payload) =>
    request(`/api/devices/${encodeURIComponent(deviceId)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  getWeather: (refresh = false, coords = null) => {
    const params = new URLSearchParams();
    if (refresh) params.set('refresh', 'true');
    if (coords && coords.latitude !== undefined && coords.longitude !== undefined) {
      params.set('lat', String(coords.latitude));
      params.set('lon', String(coords.longitude));
      if (coords.timezone) params.set('tz', coords.timezone);
      if (coords.label) params.set('label', coords.label);
    }
    const qs = params.toString();
    return request(`/api/weather${qs ? `?${qs}` : ''}`);
  },
  saveLocation: (payload) =>
    request('/api/weather/location', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),

  // Automatizaciones (Fase 4)
  getAutomations: () => request('/api/automations'),
  createAutomation: (payload) =>
    request('/api/automations', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateAutomation: (id, payload) =>
    request(`/api/automations/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  toggleAutomation: (id, isEnabled) =>
    request(`/api/automations/${id}/toggle`, {
      method: 'PATCH',
      body: JSON.stringify({ isEnabled }),
    }),
  deleteAutomation: (id) =>
    request(`/api/automations/${id}`, { method: 'DELETE' }),
  evaluateAutomation: (id, dryRun = false) =>
    request(`/api/automations/${id}/evaluate`, {
      method: 'POST',
      body: JSON.stringify({ dryRun }),
    }),
  evaluateAllAutomations: () =>
    request('/api/automations/evaluate-all', { method: 'POST' }),
  getAutomationLogs: (id, limit = 20) =>
    request(`/api/automations/${id}/logs?limit=${limit}`),

  // Telemetría e Historial (Fase 5)
  getTelemetrySeries: () => request('/api/telemetry/series'),
  getTelemetryHistory: ({ series, range = '24h', from, to }) => {
    const params = new URLSearchParams({
      series: Array.isArray(series) ? series.join(',') : series,
      range,
    });
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    return request(`/api/telemetry/history?${params.toString()}`);
  },
  captureTelemetryNow: () => request('/api/telemetry/capture', { method: 'POST' }),
  seedDemoTelemetry: (hours = 48) =>
    request('/api/telemetry/seed-demo', {
      method: 'POST',
      body: JSON.stringify({ hours }),
    }),

  // Alertas SMTP y Destinatarios (Fase 5)
  getAlertConfig: () => request('/api/alerts/config'),
  saveSmtpConfig: (payload) =>
    request('/api/alerts/smtp', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  addAlertRecipient: (payload) =>
    request('/api/alerts/recipients', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateAlertRecipient: (id, payload) =>
    request(`/api/alerts/recipients/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deleteAlertRecipient: (id) =>
    request(`/api/alerts/recipients/${id}`, { method: 'DELETE' }),
  sendTestAlert: (email) =>
    request('/api/alerts/test', {
      method: 'POST',
      body: JSON.stringify(email ? { email } : {}),
    }),
  getAlertLogs: (limit = 40) => request(`/api/alerts/logs?limit=${limit}`),

  // Autenticación y Gestión de Cuenta
  getMe: () => request('/api/auth/me'),
  register: (payload) =>
    request('/api/auth/register', { method: 'POST', body: JSON.stringify(payload) }),
  login: (payload) =>
    request('/api/auth/login', { method: 'POST', body: JSON.stringify(payload) }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  forgotPassword: (email) =>
    request('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) }),
  resetPassword: (payload) =>
    request('/api/auth/reset-password', { method: 'POST', body: JSON.stringify(payload) }),
  previewInvitation: (token) => request(`/api/auth/invite/${encodeURIComponent(token)}`),

  getAccount: () => request('/api/account'),
  updateProfile: (payload) =>
    request('/api/account/profile', { method: 'PUT', body: JSON.stringify(payload) }),
  changePassword: (payload) =>
    request('/api/account/password', { method: 'PUT', body: JSON.stringify(payload) }),
  updateAccountDetails: (name) =>
    request('/api/account/details', { method: 'PUT', body: JSON.stringify({ name }) }),
  inviteUser: (payload) =>
    request('/api/account/invitations', { method: 'POST', body: JSON.stringify(payload) }),
  revokeInvitation: (id) =>
    request(`/api/account/invitations/${id}`, { method: 'DELETE' }),
  updateMemberRole: (userId, role) =>
    request(`/api/account/members/${userId}`, { method: 'PATCH', body: JSON.stringify({ role }) }),
  removeMember: (userId) =>
    request(`/api/account/members/${userId}`, { method: 'DELETE' }),
};

export default api;
