import dotenv from 'dotenv';

dotenv.config();

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const toFloat = (value, fallback) => {
  const parsed = Number.parseFloat(value);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const toBool = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true' || value === '1';
};

const DEFAULT_APP_URL = 'https://pulsegrid.2api2.com';

function buildAllowedOrigins(appUrl, corsOriginRaw) {
  if (corsOriginRaw === '*') return '*';

  const set = new Set();
  const addNormalized = (raw) => {
    if (!raw) return;
    const trimmed = String(raw).trim().replace(/\/+$/, '');
    if (trimmed) set.add(trimmed);
  };

  addNormalized(appUrl);
  addNormalized(DEFAULT_APP_URL);

  if (corsOriginRaw) {
    for (const part of String(corsOriginRaw).split(',')) {
      addNormalized(part);
    }
  }

  return Array.from(set);
}

/**
 * Evalúa si un header Origin está permitido para Express y Socket.io.
 * Permite: mismo host (same-origin), orígenes en APP_URL/CORS_ORIGIN y dominios temporales *.hostingersite.com.
 */
export function isOriginAllowed(origin, requestHost = '') {
  if (!origin) return true;
  if (env.allowedOrigins === '*') return true;

  const normalized = String(origin).trim().replace(/\/+$/, '');
  if (env.allowedOrigins.includes(normalized)) return true;

  try {
    const parsed = new URL(normalized);
    const reqHost = String(requestHost || '').split(',')[0].trim().toLowerCase();
    if (reqHost && parsed.host.toLowerCase() === reqHost) return true;
    if (parsed.hostname.toLowerCase().endsWith('.hostingersite.com')) return true;
  } catch {
    return false;
  }

  return false;
}

const resolvedAppUrl = process.env.APP_URL || DEFAULT_APP_URL;
const resolvedCorsOrigin = process.env.CORS_ORIGIN || '';

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  isProd: (process.env.NODE_ENV || 'development') === 'production',
  port: toInt(process.env.PORT, 3000),
  appUrl: resolvedAppUrl,
  corsOrigin: resolvedCorsOrigin || resolvedAppUrl,
  allowedOrigins: buildAllowedOrigins(resolvedAppUrl, resolvedCorsOrigin),
  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),

  db: {
    host: process.env.DB_HOST || 'localhost',
    port: toInt(process.env.DB_PORT, 3306),
    name: process.env.DB_NAME || '',
    user: process.env.DB_USER || '',
    password: process.env.DB_PASSWORD || '',
    connectionLimit: toInt(process.env.DB_CONNECTION_LIMIT, 10),
    timezone: process.env.DB_TIMEZONE || 'Z',
  },

  tuya: {
    baseUrl: process.env.TUYA_BASE_URL || 'https://openapi.tuyaus.com',
    accessKey: process.env.TUYA_ACCESS_KEY || '',
    secretKey: process.env.TUYA_SECRET_KEY || '',
    userUid: process.env.TUYA_USER_UID || '',
  },

  polling: {
    intervalSeconds: toInt(process.env.POLLING_INTERVAL_SECONDS, 30),
    automationCron: process.env.AUTOMATION_CRON_SCHEDULE || '*/1 * * * *',
    telemetryRetentionDays: toInt(process.env.TELEMETRY_RETENTION_DAYS, 90),
    automationLogRetentionDays: toInt(process.env.AUTOMATION_LOG_RETENTION_DAYS, 30),
  },

  weather: {
    latitude: toFloat(process.env.WEATHER_LATITUDE, 19.4326),
    longitude: toFloat(process.env.WEATHER_LONGITUDE, -99.1332),
    timezone: process.env.WEATHER_TIMEZONE || 'America/Mexico_City',
    cacheMinutes: toInt(process.env.WEATHER_CACHE_MINUTES, 15),
  },

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: toInt(process.env.SMTP_PORT, 465),
    secure: toBool(process.env.SMTP_SECURE, true),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    fromName: process.env.SMTP_FROM_NAME || 'PulseGrid Alertas',
    fromEmail: process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER || '',
  },
};

export default env;
