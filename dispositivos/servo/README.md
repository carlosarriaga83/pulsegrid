# Servo ESP32

Firmware for COM6 (`ESP_Cortina_1`). OTA target: `servo`.

Cuando `API_KEY` está vacía, el firmware usa solo la clave de bootstrap `pg_bootstrap_v1` para anunciar presencia y consultar una configuración `device.configure` pendiente. No envía telemetría ni consulta comandos normales.

The cloud release should include the files used by `main.py`, including `pulsegrid_min.py`, `pulsegrid_bootstrap.py`, `webserver_min.py`, `cortina.py`, and their driver dependencies.

OTA uses a transactional flash staging area. Files are downloaded in chunks to `.pulsegrid_ota/stage`, checked against the declared `Content-Length` and SHA-256, then activated by `boot.py`. The previous set is retained in `.pulsegrid_ota/backup` until the new firmware confirms a healthy boot; a failed boot or watchdog reset restores that backup.

El portal de configuracion escucha en la IP que recibe la ESP32 dentro de la red Wi-Fi. La red abierta `Pulsegrid-Cortina` en `192.168.4.1` solo se activa como recuperacion cuando no hay conexion Wi-Fi.