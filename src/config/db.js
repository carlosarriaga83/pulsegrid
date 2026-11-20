import mysql from 'mysql2/promise';
import env from './env.js';
import logger from '../utils/logger.js';

const pool = mysql.createPool({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.name,
  waitForConnections: true,
  connectionLimit: env.db.connectionLimit,
  maxIdle: env.db.connectionLimit,
  idleTimeout: 60000,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  timezone: env.db.timezone,
  charset: 'utf8mb4',
});

/**
 * Ejecuta una consulta preparada segura contra el pool de MySQL.
 */
export async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

/**
 * Verifica la conectividad y mide la latencia de la base de datos.
 */
export async function testConnection() {
  const start = Date.now();
  try {
    const [rows] = await pool.query('SELECT 1 AS ok, VERSION() AS version');
    return {
      connected: true,
      latencyMs: Date.now() - start,
      version: rows[0]?.version || 'unknown',
    };
  } catch (err) {
    logger.error('Error al verificar conexión MySQL', err);
    return {
      connected: false,
      latencyMs: Date.now() - start,
      error: err.message,
    };
  }
}

/**
 * Cierra ordenadamente el pool (usado en graceful shutdown para Hostinger).
 */
export async function closePool() {
  try {
    await pool.end();
    logger.info('Pool de MySQL cerrado correctamente');
  } catch (err) {
    logger.error('Error al cerrar el pool de MySQL', err);
  }
}

export { pool };
export default { pool, query, testConnection, closePool };
