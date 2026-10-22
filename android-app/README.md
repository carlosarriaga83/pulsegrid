# Pulsegrid Android

Aplicación Android nativa para Pulsegrid, desarrollada con Kotlin y Jetpack Compose. El MVP permite iniciar sesión con tokens móviles, revisar dispositivos y actividad, vincular una placa Pulsegrid ya grabada, controlar cortinas y funciones Tuya declaradas por el cloud, y configurar Wi‑Fi mediante el portal local del ESP32.

## Requisitos

- Android Studio con JDK 17 incluido (Android Studio JBR también sirve).
- Android SDK Platform 36 y Android SDK Build Tools instalados.
- Android 10 o posterior para el asistente Wi‑Fi local; el resto de las pantallas declara mínimo Android 8.0 (API 26).
- Una cuenta Pulsegrid existente y el backend con soporte `/api/mobile/*` actualizado.

## Abrir y ejecutar

Abre la carpeta `android-app` en Android Studio, sincroniza Gradle y ejecuta el módulo `app` en un emulador o teléfono. El proyecto usa `https://pulse.2api2.com/` como API por defecto. Para cambiarlo en una compilación local, define la propiedad Gradle `pulsegridApiBaseUrl` con una URL que termine en `/`; no habilites cleartext para el cloud.

El wrapper Gradle debe generarse al completar la sincronización inicial de Android Studio si no está presente. El `compileSdk` objetivo es 36 y el `minSdk` es 26.

## API móvil requerida

El servidor necesita desplegar previamente las rutas nuevas:

- `POST /api/mobile/auth/login`, `POST /api/mobile/auth/refresh`, `POST /api/mobile/auth/logout`.
- `GET /api/mobile/me`, `GET/POST /api/mobile/devices`.
- `GET /api/mobile/telemetry?deviceId=...`, `GET/POST /api/mobile/commands`.

Los access tokens duran 15 minutos; el refresh token se rota y se almacena en Android mediante almacenamiento cifrado. El backend guarda hashes de tokens y revoca la familia al cerrar sesión o detectar reutilización. Las sesiones web por cookie siguen siendo independientes. No configures credenciales Tuya ni API keys en la app.

## Configuración Wi‑Fi y seguridad

El aprovisionamiento conecta al AP `Pulsegrid-Cortina-*` y envía los campos URL-encoded `ssid` y `password` por `POST http://192.168.4.1/save`. La app usa la API `WifiNetworkSpecifier` (Android solicita autorización) y limita cleartext al host local en la configuración de seguridad de red.

El portal actual usa una red abierta y HTTP local. El asistente muestra una advertencia y debe usarse cerca del dispositivo, en una instalación supervisada. Antes de distribuir públicamente la app, endurece el firmware con una clave única/QR o un mecanismo de emparejamiento autenticado; la app no hace segura por sí sola la red abierta. El flujo solo contempla placas ya grabadas con identidad Pulsegrid; no configura `DEVICE_CODE` ni reemplaza al quemador.

## Alcance actual

- Login, listado/estado y refresco periódico, registro por código, historial compacto de comandos.
- Comandos de cortina mediante la API Pulsegrid; la UI bloquea movimiento Servo sin referencia y calibración listas.
- Controles Tuya se envían exclusivamente al cloud como `tuya.set` según las capabilities del dispositivo.
- Provisionamiento Wi‑Fi local para placas pregrabadas.
- Automatizaciones, gráficas, OTA y notificaciones quedan para una iteración posterior.

Prueba el cambio de red en un teléfono real. El emulador no valida unirse al SoftAP ni el comportamiento de reconexión de Android/fabricantes.