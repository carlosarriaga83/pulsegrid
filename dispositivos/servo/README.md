# Servo ESP32

Firmware for COM6 (`ESP_Cortina_1`). OTA target: `servo`.

The cloud release should include the files used by `main.py`, including `pulsegrid_min.py`, `webserver_min.py`, `cortina.py`, and their driver dependencies.

OTA uses a transactional flash staging area. Files are downloaded in chunks to `.pulsegrid_ota/stage`, checked against the declared `Content-Length` and SHA-256, then activated by `boot.py`. The previous set is retained in `.pulsegrid_ota/backup` until the new firmware confirms a healthy boot; a failed boot or watchdog reset restores that backup.