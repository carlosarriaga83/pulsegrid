# Servo ESP32

Firmware para el servo ST/STS de COM6 (`PULSE_10`), con la misma arquitectura cloud que el firmware GA25: `main.py` contiene el transporte HTTPS, bootstrap, telemetria y comandos; `captive_portal.py` se carga solo durante provisionamiento o recuperacion.

El perfil usa un unico `config.py` con Wi-Fi, API URL, API key, Device ID, comandos y sentido. La API key puede quedar vacia: el dispositivo usa `pg_bootstrap_v1` para recibir un `device.configure`, y hasta entonces no envia telemetria ni acepta comandos normales.

Archivos del perfil: `main.py`, `captive_portal.py`, `cortina.py`, `stservo.py`, `boot.py`, `ota_boot.py`, `pulsegrid_ota.py` y `config.py`.

El adaptador `cortina.py` mantiene la superficie de movimiento del cloud (`curtain.open`, `curtain.close`, `curtain.stop`, `curtain.move`) sobre el bus STServo. Tambien implementa el asistente de calibracion (`blind.setMotorSide`, `blind.beginCalibration`, `blind.markDeployed`, `blind.markRolled`, `blind.jog`) y persiste los extremos, lado del motor, porcentaje objetivo y recorrido absoluto. El recorrido se guarda por checkpoints de media vuelta y al finalizar un movimiento para evitar escrituras continuas en flash.

OTA usa el staging transaccional de `ota_boot.py`; los archivos se descargan por bloques, se verifican con `Content-Length` y SHA-256, y se activan después de un arranque saludable.