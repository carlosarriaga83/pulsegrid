const https = require('https');

const WEATHER_DEVICE_ID = 'weather_openmeteo';
const cache = new Map();
const DEFAULT_CURRENT = ['temperature_2m', 'weather_code', 'wind_speed_10m'];
const DEFAULT_DAILY = ['sunrise', 'sunset'];

function config(settings = {}) {
  const latitude = Number(settings.latitude ?? process.env.OPEN_METEO_LATITUDE);
  const longitude = Number(settings.longitude ?? process.env.OPEN_METEO_LONGITUDE);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw new Error('Configura latitud y longitud validas para la regla Open-Meteo');
  const timezone = String(settings.timezone ?? process.env.OPEN_METEO_TIMEZONE ?? 'UTC').trim();
  try { Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(); } catch { throw new Error('OPEN_METEO_TIMEZONE no es valida'); }
  return { latitude, longitude, timezone };
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { Accept: 'application/json', 'User-Agent': 'Pulsegrid/1.0' } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(`Open-Meteo respondio ${response.statusCode}`));
        try { resolve(JSON.parse(body)); } catch { reject(new Error('Open-Meteo devolvio JSON invalido')); }
      });
    });
    request.setTimeout(10000, () => request.destroy(new Error('Tiempo agotado consultando Open-Meteo')));
    request.on('error', reject);
  });
}

function cacheKey(settings) { return `${settings.latitude}:${settings.longitude}:${settings.timezone}`; }

async function getWeatherSnapshot(overrides = {}) {
  const settings = config(overrides);
  const key = cacheKey(settings);
  const now = Date.now();
  const currentEntry = cache.get(`${key}:current`);
  const dailyEntry = cache.get(`${key}:daily`);
  const current = currentEntry && currentEntry.expiresAt > now ? currentEntry.value : await requestJson(`https://api.open-meteo.com/v1/forecast?latitude=${settings.latitude}&longitude=${settings.longitude}&current=${DEFAULT_CURRENT.join(',')}&timezone=${encodeURIComponent(settings.timezone)}`);
  const daily = dailyEntry && dailyEntry.expiresAt > now ? dailyEntry.value : await requestJson(`https://api.open-meteo.com/v1/forecast?latitude=${settings.latitude}&longitude=${settings.longitude}&daily=${DEFAULT_DAILY.join(',')}&forecast_days=2&timezone=${encodeURIComponent(settings.timezone)}`);
  cache.set(`${key}:current`, { value: current, expiresAt: now + 30 * 60 * 1000 });
  cache.set(`${key}:daily`, { value: daily, expiresAt: now + 24 * 60 * 60 * 1000 });
  const currentValues = current.current || {};
  const dailyValues = daily.daily || {};
  return { deviceId: WEATHER_DEVICE_ID, timezone: settings.timezone, latitude: settings.latitude, longitude: settings.longitude, current: currentValues, daily: dailyValues, telemetry: { temperature: currentValues.temperature_2m, weather_code: currentValues.weather_code, wind_speed: currentValues.wind_speed_10m, sunrise: dailyValues.sunrise?.[0], sunset: dailyValues.sunset?.[0] } };
}

function localDateTime(timezone, date = new Date()) {
  const parts = Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value;
  return { date: `${value('year')}-${value('month')}-${value('day')}`, time: `${value('hour')}:${value('minute')}` };
}

function solarTime(snapshot, event, date = new Date()) {
  const local = localDateTime(snapshot.timezone, date);
  const index = (snapshot.daily?.time || []).indexOf(local.date);
  const value = snapshot.daily?.[event]?.[index];
  return value ? value.slice(11, 16) : null;
}

function parameters() {
  return [
    { value: 'temperature', label: 'Temperatura exterior', type: 'number', step: 0.1 },
    { value: 'weather_code', label: 'Codigo meteorologico', type: 'number', integer: true },
    { value: 'wind_speed', label: 'Viento (km/h)', type: 'number', step: 0.1 },
    { value: 'sunrise', label: 'Amanecer (sunrise)', type: 'string' },
    { value: 'sunset', label: 'Atardecer (sunset)', type: 'string' }
  ];
}

function clearCache() { cache.clear(); }

module.exports = { WEATHER_DEVICE_ID, config, getWeatherSnapshot, localDateTime, solarTime, parameters, clearCache };
