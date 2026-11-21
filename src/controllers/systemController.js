import { testConnection } from '../config/db.js';
import tuyaService from '../services/tuyaService.js';
import weatherService from '../services/weatherService.js';
import { getConnectedClientsCount } from '../sockets/socketManager.js';
import env from '../config/env.js';

export async function getHealth(_req, res) {
  const db = await testConnection();
  const tuya = tuyaService.getCacheStats();

  let weather = { ok: false };
  try {
    const w = await weatherService.getWeather(false);
    weather = {
      ok: true,
      location: w.location?.label,
      temperature: w.current?.temperature,
      condition: w.current?.weatherLabel,
      sunrise: w.solar?.sunrise,
      sunset: w.solar?.sunset,
      fromCache: w.fromCache,
    };
  } catch (err) {
    weather = { ok: false, error: err.message };
  }

  const healthy = db.connected;

  res.status(healthy ? 200 : 503).json({
    ok: healthy,
    service: 'PulseGrid',
    phase: 5,
    environment: env.nodeEnv,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    database: db,
    tuya,
    weather,
    realtime: {
      socketio: true,
      connectedClients: getConnectedClientsCount(),
    },
  });
}

export default { getHealth };
