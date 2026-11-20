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
};

export default api;
