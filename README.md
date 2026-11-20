# PulseGrid

Plataforma web IoT y domótica para monitorear, controlar y automatizar dispositivos mediante la **API de Tuya Cloud**, diseñada para ejecutarse en **Hostinger Node.js Web Apps**.

## Stack Tecnológico
- **Backend:** Node.js (LTS, ESM), Express.js, Socket.io
- **Base de Datos:** MySQL / MariaDB (`mysql2/promise`)
- **IoT & Clima:** `@tuya/tuya-connector-nodejs` + Open-Meteo API
- **Automatizaciones & Alertas:** `node-cron`, `nodemailer` (SMTP)
- **Frontend:** HTML5, Tailwind CSS, Vanilla JS (ES6+), Chart.js

## Estructura del Proyecto
```text
pulsegrid/
├── database/
│   └── schema.sql          # Esquema MySQL/MariaDB con índices optimizados
├── public/                 # Frontend servido por Express
│   ├── css/
│   └── js/ui/
├── src/
│   ├── config/             # Variables de entorno y pool de MySQL
│   ├── controllers/        # Lógica de endpoints REST
│   ├── middlewares/        # Manejo de errores y validaciones
│   ├── routes/             # Definición de rutas /api
│   ├── services/           # Tuya Cloud, Open-Meteo, Automatizaciones, Telemetría, Email
│   ├── sockets/            # Eventos en tiempo real (Socket.io)
│   └── utils/              # Utilidades y logger
├── .env.example
└── package.json
```

## Configuración Inicial (Fase 1)
1. Copia `.env.example` a `.env` y completa tus credenciales de MySQL, Tuya Cloud y SMTP.
2. Importa `database/schema.sql` en tu base de datos MySQL/MariaDB de Hostinger (vía phpMyAdmin o CLI).
3. Instala las dependencias con `npm install`.
