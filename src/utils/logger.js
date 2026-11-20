import env from '../config/env.js';

const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const currentLevel = LEVELS[env.logLevel] ?? LEVELS.info;

function formatLog(level, message, meta) {
  const timestamp = new Date().toISOString();
  const base = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  if (meta === undefined) return base;
  if (meta instanceof Error) {
    return `${base} | ${meta.message}`;
  }
  try {
    return `${base} | ${JSON.stringify(meta)}`;
  } catch {
    return `${base} | [unserializable meta]`;
  }
}

export const logger = {
  debug(message, meta) {
    if (currentLevel <= LEVELS.debug) console.debug(formatLog('debug', message, meta));
  },
  info(message, meta) {
    if (currentLevel <= LEVELS.info) console.log(formatLog('info', message, meta));
  },
  warn(message, meta) {
    if (currentLevel <= LEVELS.warn) console.warn(formatLog('warn', message, meta));
  },
  error(message, meta) {
    if (currentLevel <= LEVELS.error) console.error(formatLog('error', message, meta));
  },
};

export default logger;
