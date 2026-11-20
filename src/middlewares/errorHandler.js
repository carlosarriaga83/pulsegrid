import logger from '../utils/logger.js';
import env from '../config/env.js';

export function notFoundHandler(req, res) {
  res.status(404).json({
    ok: false,
    error: `Ruta no encontrada: ${req.method} ${req.originalUrl}`,
  });
}

export function errorHandler(err, req, res, _next) {
  const statusCode = err.statusCode || err.status || 500;
  logger.error(`${req.method} ${req.originalUrl} -> ${statusCode}`, err);

  res.status(statusCode).json({
    ok: false,
    error: err.message || 'Error interno del servidor',
    ...(env.isProd ? {} : { stack: err.stack }),
  });
}

export default { notFoundHandler, errorHandler };
