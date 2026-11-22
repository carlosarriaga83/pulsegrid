import env from '../config/env.js';
import { query } from '../config/db.js';
import logger from '../utils/logger.js';

const WMO_CODES = {
  0: { label: 'Despejado', category: 'clear' },
  1: { label: 'Mayormente despejado', category: 'clear' },
  2: { label: 'Parcialmente nublado', category: 'cloudy' },
  3: { label: 'Nublado', category: 'cloudy' },
  45: { label: 'Niebla', category: 'fog' },
  48: { label: 'Niebla con escarcha', category: 'fog' },
  51: { label: 'Llovizna ligera', category: 'rain' },
  53: { label: 'Llovizna moderada', category: 'rain' },
  55: { label: 'Llovizna intensa', category: 'rain' },
  61: { label: 'Lluvia ligera', category: 'rain' },
  63: { label: 'Lluvia moderada', category: 'rain' },
  65: { label: 'Lluvia intensa', category: 'rain' },
  71: { label: 'Nieve ligera', category: 'snow' },
  73: { label: 'Nieve moderada', category: 'snow' },
  75: { label: 'Nieve intensa', category: 'snow' },
  80: { label: 'Chubascos ligeros', category: 'rain' },
  81: { label: 'Chubascos moderados', category: 'rain' },
  82: { label: 'Chubascos fuertes', category: 'rain' },
  95: { label: 'Tormenta eléctrica', category: 'storm' },
  96: { label: 'Tormenta con granizo ligero', category: 'storm' },
  99: { label: 'Tormenta con granizo fuerte', category: 'storm' },
};

let cachedWeather = null;
let lastFetchedAt = 0;

function parseJsonSafe(val) {
  if (typeof val === 'string') {
    try {
      return JSON.parse(val);
    } catch {
      return null;
    }
  }
  return val;
}

/**
 * Obtiene la configuración de ubicación desde MySQL (app_settings) o .env.
 */
export async function getLocationSettings() {
  try {
    const rows = await query(
      'SELECT setting_value FROM app_settings WHERE setting_key = ? LIMIT 1',
      ['location']
    );
    if (rows.length > 0) {
      const parsed = parseJsonSafe(rows[0].setting_value);
      if (parsed && parsed.latitude !== undefined && parsed.longitude !== undefined) {
        return {
          latitude: Number(parsed.latitude),
          longitude: Number(parsed.longitude),
          timezone: parsed.timezone || env.weather.timezone,
          label: parsed.label || 'Ubicación configurada',
        };
      }
    }
  } catch (err) {
    logger.warn('No se pudo leer ubicación de app_settings, usando .env', { error: err.message });
  }

  return {
    latitude: env.weather.latitude,
    longitude: env.weather.longitude,
    timezone: env.weather.timezone,
    label: 'Ubicación por defecto',
  };
}

/**
 * Actualiza la ubicación en app_settings e invalida la caché de clima.
 */
export async function updateLocationSettings({ latitude, longitude, timezone, label }) {
  const payload = {
    latitude: Number(latitude),
    longitude: Number(longitude),
    timezone: timezone || env.weather.timezone,
    label: label || 'Ubicación personalizada',
  };

  await query(
    `INSERT INTO app_settings (setting_key, setting_value, description)
     VALUES ('location', ?, 'Coordenadas y zona horaria para Open-Meteo')
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_at = CURRENT_TIMESTAMP`,
    [JSON.stringify(payload)]
  );

  weatherCacheMap.clear();
  return payload;
}

const weatherCacheMap = new Map();

/**
 * Consulta Open-Meteo (sin API Key) con caché en memoria por ubicación.
 * Si se pasan overrideLocation ({ latitude, longitude, timezone, label }), usa las coordenadas del visitante.
 */
export async function getWeather(forceRefresh = false, overrideLocation = null) {
  const ttlMs = env.weather.cacheMinutes * 60 * 1000;
  const now = Date.now();

  const location =
    overrideLocation && overrideLocation.latitude !== undefined && overrideLocation.longitude !== undefined
      ? {
          latitude: Number(overrideLocation.latitude),
          longitude: Number(overrideLocation.longitude),
          timezone: overrideLocation.timezone || env.weather.timezone,
          label: overrideLocation.label || 'Tu ubicación',
        }
      : await getLocationSettings();

  const cacheKey = `${location.latitude.toFixed(2)},${location.longitude.toFixed(2)},${location.timezone}`;
  const cachedEntry = weatherCacheMap.get(cacheKey);

  if (!forceRefresh && cachedEntry && now - cachedEntry.fetchedAtMs < ttlMs) {
    return { ...cachedEntry.data, fromCache: true };
  }

  const params = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m',
    daily: 'sunrise,sunset,temperature_2m_max,temperature_2m_min,weather_code',
    timezone: location.timezone,
    forecast_days: '2',
  });

  const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Open-Meteo respondió HTTP ${response.status}`);
    }

    const data = await response.json();
    const current = data.current || {};
    const daily = data.daily || {};
    const wmo = WMO_CODES[current.weather_code] || { label: 'Desconocido', category: 'unknown' };

    const result = {
      location,
      timezone: data.timezone || location.timezone,
      fetchedAt: new Date().toISOString(),
      current: {
        temperature: current.temperature_2m ?? null,
        apparentTemperature: current.apparent_temperature ?? null,
        humidity: current.relative_humidity_2m ?? null,
        precipitation: current.precipitation ?? 0,
        windSpeed: current.wind_speed_10m ?? null,
        isDay: Boolean(current.is_day),
        weatherCode: current.weather_code ?? null,
        weatherLabel: wmo.label,
        weatherCategory: wmo.category,
      },
      solar: {
        sunrise: daily.sunrise?.[0] || null,
        sunset: daily.sunset?.[0] || null,
        tomorrowSunrise: daily.sunrise?.[1] || null,
        tomorrowSunset: daily.sunset?.[1] || null,
      },
      daily: {
        tempMax: daily.temperature_2m_max?.[0] ?? null,
        tempMin: daily.temperature_2m_min?.[0] ?? null,
      },
    };

    weatherCacheMap.set(cacheKey, { data: result, fetchedAtMs: now });
    return { ...result, fromCache: false };
  } catch (err) {
    logger.error('Error consultando Open-Meteo', err);
    if (cachedEntry?.data) {
      return { ...cachedEntry.data, fromCache: true, stale: true, error: err.message };
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Helper para Fase 4: calcula el timestamp ajustado de amanecer/atardecer con offset en minutos.
 * Ej: event='sunset', offsetMinutes=-30 -> 30 minutos antes del atardecer.
 */
export function getSolarEventTime(weatherData, event = 'sunset', offsetMinutes = 0) {
  const isoStr = event === 'sunrise' ? weatherData?.solar?.sunrise : weatherData?.solar?.sunset;
  if (!isoStr) return null;
  const baseTime = new Date(isoStr);
  if (Number.isNaN(baseTime.getTime())) return null;
  return new Date(baseTime.getTime() + Number(offsetMinutes) * 60 * 1000);
}

export default {
  getLocationSettings,
  updateLocationSettings,
  getWeather,
  getSolarEventTime,
};
