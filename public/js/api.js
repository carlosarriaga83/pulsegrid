/**
 * Cliente HTTP REST para el backend de PulseGrid (/api/*)
 */

async function request(path, options = {}) {
  const config = {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  };

  const response = await fetch(path, config);
  const data = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));

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
  getWeather: (refresh = false) => request(`/api/weather${refresh ? '?refresh=true' : ''}`),
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
};

export default api;
