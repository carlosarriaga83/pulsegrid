import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import env, { isOriginAllowed } from './config/env.js';
import apiRoutes from './routes/index.js';
import { notFoundHandler, errorHandler } from './middlewares/errorHandler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, '..', 'public');

const app = express();

// Necesario detrás del reverse proxy de Hostinger
app.set('trust proxy', 1);

// Seguridad HTTP compatible con Tailwind CDN, Chart.js CDN y Socket.io en Fase 3-5
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.tailwindcss.com', 'https://cdn.jsdelivr.net'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'", 'ws:', 'wss:', 'https://api.open-meteo.com'],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

app.use(
  cors((req, callback) => {
    const origin = req.headers.origin;
    const reqHost = req.headers['x-forwarded-host'] || req.headers.host || '';
    if (isOriginAllowed(origin, reqHost)) {
      return callback(null, { origin: true, credentials: true });
    }
    return callback(new Error(`Origen CORS no permitido: ${origin}`));
  })
);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Rutas REST de la API
app.use('/api', apiRoutes);

// Frontend estático (public/)
app.use(express.static(publicDir));

// Fallback SPA para rutas no-API
app.get(/^\/(?!api\/).*/, (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
