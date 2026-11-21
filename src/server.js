import http from 'node:http';
import app from './app.js';
import env from './config/env.js';
import { testConnection, closePool } from './config/db.js';
import { initSocket, closeSocket } from './sockets/socketManager.js';
import tuyaService from './services/tuyaService.js';
import automationEngine from './services/automationEngine.js';
import emailService from './services/emailService.js';
import logger from './utils/logger.js';

const server = http.createServer(app);
initSocket(server);

let isShuttingDown = false;

async function bootstrap() {
  const dbStatus = await testConnection();
  if (dbStatus.connected) {
    logger.info(`MySQL conectado (${dbStatus.version}) en ${dbStatus.latencyMs}ms`);
    try {
      const devices = await tuyaService.loadDevicesFromDb();
      logger.info(`Caché inicial cargada desde MySQL: ${devices.length} dispositivo(s)`);
    } catch (err) {
      logger.warn('No se pudo precargar dispositivos desde MySQL', { error: err.message });
    }
  } else {
    logger.error('No se pudo conectar a MySQL al arrancar (el servidor seguirá activo para diagnóstico)', {
      error: dbStatus.error,
    });
  }

  if (tuyaService.isTuyaConfigured()) {
    logger.info(`Tuya Cloud API configurada (${env.tuya.baseUrl})`);
  } else {
    logger.warn('Tuya Cloud API pendiente de credenciales en .env (TUYA_ACCESS_KEY / TUYA_SECRET_KEY)');
  }

  server.listen(env.port, () => {
    logger.info(`PulseGrid escuchando en el puerto ${env.port} [${env.nodeEnv}]`);
    automationEngine.registerEmailDispatcher(emailService.sendAlert);
    automationEngine.startScheduler();
  });
}

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info(`Señal ${signal} recibida. Cerrando PulseGrid ordenadamente...`);

  const forceExitTimer = setTimeout(() => {
    logger.error('Tiempo de cierre agotado, forzando salida');
    process.exit(1);
  }, 10000);
  forceExitTimer.unref();

  try {
    automationEngine.stopScheduler();
    await closeSocket();
    await new Promise((resolve) => server.close(resolve));
    await closePool();
    logger.info('Cierre limpio completado');
    process.exit(0);
  } catch (err) {
    logger.error('Error durante el cierre limpio', err);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('Promesa rechazada no manejada', reason instanceof Error ? reason : { reason });
});

process.on('uncaughtException', (err) => {
  logger.error('Excepción no capturada', err);
  shutdown('uncaughtException');
});

bootstrap();
