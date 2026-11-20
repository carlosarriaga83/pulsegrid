/**
 * Gestor de conexión en tiempo real vía Socket.io
 */

const listeners = {
  status: new Set(),
  snapshot: new Set(),
  deviceUpdate: new Set(),
  weatherUpdate: new Set(),
  alert: new Set(),
};

let socket = null;

export function connectSocket() {
  if (socket) return socket;

  socket = window.io({
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 8000,
  });

  socket.on('connect', () => {
    listeners.status.forEach((cb) => cb({ connected: true, id: socket.id }));
  });

  socket.on('disconnect', (reason) => {
    listeners.status.forEach((cb) => cb({ connected: false, reason }));
  });

  socket.on('connect_error', () => {
    listeners.status.forEach((cb) => cb({ connected: false, error: true }));
  });

  socket.on('devices:snapshot', (payload) => {
    listeners.snapshot.forEach((cb) => cb(payload));
  });

  socket.on('device:update', (payload) => {
    listeners.deviceUpdate.forEach((cb) => cb(payload));
  });

  socket.on('weather:update', (payload) => {
    listeners.weatherUpdate.forEach((cb) => cb(payload));
  });

  socket.on('alert:new', (payload) => {
    listeners.alert.forEach((cb) => cb(payload));
  });

  return socket;
}

export function onSocketEvent(event, handler) {
  if (listeners[event]) listeners[event].add(handler);
  return () => listeners[event]?.delete(handler);
}

/**
 * Envía comandos vía WebSocket con promesa de confirmación (ACK).
 * Si el socket no está conectado, rechaza para que el llamador use fallback REST.
 */
export function emitDeviceCommand(deviceId, commands) {
  return new Promise((resolve, reject) => {
    if (!socket || !socket.connected) {
      return reject(new Error('SOCKET_OFFLINE'));
    }
    socket.timeout(8000).emit('device:command', { deviceId, commands }, (err, response) => {
      if (err) return reject(new Error('Tiempo de espera agotado enviando comando'));
      if (!response?.ok) return reject(new Error(response?.error || 'Error enviando comando'));
      resolve(response.data);
    });
  });
}

export default { connectSocket, onSocketEvent, emitDeviceCommand };
