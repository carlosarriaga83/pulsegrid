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

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  isProd: (process.env.NODE_ENV || 'development') === 'production',
  port: toInt(process.env.PORT, 3000),
  appUrl: process.env.APP_URL || 'http://localhost:3000',
  corsOrigin: process.env.CORS_ORIGIN || '*',
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
