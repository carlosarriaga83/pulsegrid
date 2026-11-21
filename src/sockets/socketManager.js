import { Server } from 'socket.io';
import env, { isOriginAllowed } from '../config/env.js';
import logger from '../utils/logger.js';
import tuyaService from '../services/tuyaService.js';
import weatherService from '../services/weatherService.js';
import telemetryService from '../services/telemetryService.js';

let io = null;

export function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => {
        if (isOriginAllowed(origin)) return callback(null, true);
        return callback(new Error(`Origen Socket.io no permitido: ${origin}`));
      },
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
      credentials: true,
    },
    pingTimeout: 20000,
    pingInterval: 25000,
  });

  io.on('connection', async (socket) => {
    logger.info(`Cliente Socket.io conectado: ${socket.id}`, {
      totalClients: io.engine.clientsCount,
    });

    // Enviar snapshot inicial de dispositivos en caché sin bloquear
    try {
      const devices = await tuyaService.getDevices(false);
      socket.emit('devices:snapshot', {
        devices,
        tuyaConfigured: tuyaService.isTuyaConfigured(),
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      logger.warn('No se pudo enviar snapshot inicial al cliente', { error: err.message });
    }

    // Control de dispositivos en tiempo real vía WebSocket
    socket.on('device:command', async (payload, ack) => {
      try {
        const { deviceId, commands } = payload || {};
        const result = await tuyaService.sendDeviceCommands(deviceId, commands);
        telemetryService.recordCommandsTelemetry(result.device, result.commands).catch(() => {});
        emitDeviceUpdate(result.device);
        if (typeof ack === 'function') ack({ ok: true, data: result });
      } catch (err) {
        logger.error('Error en comando vía Socket.io', err);
        if (typeof ack === 'function') ack({ ok: false, error: err.message });
      }
    });

    // Solicitud manual de sincronización desde un cliente
    socket.on('devices:sync', async (ack) => {
      try {
        const result = await tuyaService.syncDevices();
        emitDevicesSnapshot(result.devices);
        if (typeof ack === 'function') ack({ ok: true, data: result });
      } catch (err) {
        logger.error('Error sincronizando dispositivos vía Socket.io', err);
        if (typeof ack === 'function') ack({ ok: false, error: err.message });
      }
    });

    // Solicitud de clima actualizado
    socket.on('weather:refresh', async (ack) => {
      try {
        const weather = await weatherService.getWeather(true);
        io.emit('weather:update', weather);
        if (typeof ack === 'function') ack({ ok: true, data: weather });
      } catch (err) {
        if (typeof ack === 'function') ack({ ok: false, error: err.message });
      }
    });

    socket.on('disconnect', (reason) => {
      logger.debug(`Cliente Socket.io desconectado: ${socket.id}`, { reason });
    });
  });

  return io;
}

export function getIO() {
  return io;
}

export function getConnectedClientsCount() {
  return io ? io.engine.clientsCount : 0;
}

export function emitDeviceUpdate(device) {
  if (!io) return;
  io.emit('device:update', {
    device,
    timestamp: new Date().toISOString(),
  });
}

export function emitDevicesSnapshot(devices) {
  if (!io) return;
  io.emit('devices:snapshot', {
    devices,
    tuyaConfigured: tuyaService.isTuyaConfigured(),
    timestamp: new Date().toISOString(),
  });
}

export function emitAlert(alert) {
  if (!io) return;
  io.emit('alert:new', {
    ...alert,
    timestamp: new Date().toISOString(),
  });
}

export function closeSocket() {
  return new Promise((resolve) => {
    if (!io) return resolve();
    io.close(() => {
      logger.info('Servidor Socket.io cerrado correctamente');
      resolve();
    });
  });
}

export default {
  initSocket,
  getIO,
  getConnectedClientsCount,
  emitDeviceUpdate,
  emitDevicesSnapshot,
  emitAlert,
  closeSocket,
};
