# Firmware MicroPython: cortina GA25YN370

Para LOLIN S2 Mini / ESP32-S2:

- GPIO16: EN del puente H, PWM de velocidad.
- GPIO18: entrada de direccion A.
- GPIO33: entrada de direccion B.

El firmware consulta los comandos de Pulsegrid y envia telemetria. Sin encoder o sensor, `position` es una estimacion basada en tiempo. El asistente de calibración GA25 mide únicamente el tiempo entre extremos; no puede inferir el sentido eléctrico que abre la cortina. Antes de iniciar, selecciona Normal o Invertido y observa el inicio del movimiento: debe avanzar hacia abierta. Si avanza hacia cerrada, cancela y cambia el sentido antes de volver a calibrar. El tiempo se guarda como `FULL_TRAVEL_MS`; no proporciona detección de atascos ni posición física real. Hay un corte local de seguridad a los 120 segundos.

La selección del sentido se aplica al instante con `direction.configure`, se guarda en `config.py` y conserva la posición estimada y el tiempo de recorrido actual. `OPEN_A_LEVEL` también determina qué polaridad de GPIO18 corresponde a abrir; firmware anteriores leían este parámetro pero no lo usaban al escribir los pines, por lo que cambiarlo no invertía el motor. El asistente de calibración ahora permite elegir Normal/Invertido antes de medir y recuerda verificar visualmente el primer desplazamiento.

`FULL_TRAVEL_MS` se guarda en `config.py`, que queda fuera de los manifiestos OTA y de la limpieza del perfil GA25 del quemador. Los reinicios, las actualizaciones OTA y la pérdida de Wi-Fi no borran ese ajuste; el guardado del portal y de la configuración remota conserva un respaldo para recuperarlo si hay un reset durante la escritura. La posición física no se puede conocer con exactitud tras un corte durante el movimiento sin encoder o finales de carrera. Borrar toda la flash sí elimina `config.py`.

El firmware autentica telemetría, comandos y OTA con `DEVICE_CODE`, derivado determinísticamente de la MAC por el quemador y guardado como hash en cloud. El código no es secreto: quien conozca la MAC puede calcularlo e imitar el dispositivo. La API key de usuario se reserva para integraciones externas; no se incluye en la configuración del motor.

## Carga

1. Instala `mpremote` y carga `captive_portal.py`, `motor_curtain.py`, `wifi_recovery.py` y `main.py`.
2. Reinicia la placa. Si no existe `config.py` o no puede conectar a la red configurada, crea la red abierta `Pulsegrid-Cortina`.
3. Conecta el telefono o PC a esa red y abre `http://192.168.4.1/`. El portal permite guardar solo Wi-Fi y conserva el código, Device ID y ajustes del motor.
4. La placa reinicia y se conecta a la red configurada.

Cuando la placa está conectada, el portal escucha en su IP dentro de la red Wi-Fi. El AP `Pulsegrid-Cortina` queda apagado y solo se activa como portal de recuperacion si la conexión se pierde o las credenciales dejan de funcionar. Para abrirlo aunque la red guardada siga conectando, corta y restablece la alimentación tres veces rápidamente; el LED parpadea mientras permanece en recuperación. La secuencia se cancela tras 30 s de funcionamiento estable y el AP se mantiene activo hasta guardar la nueva red.

Los comandos ESP se consultan cada segundo (antes cada cinco); la telemetría conserva su intervalo independiente.

Tambien puedes preparar `config.py` a partir de `config.example.py` y cargarlo directamente. La red de configuracion es abierta y no debe usarse para trafico sensible; solo expone el portal local durante la configuracion.

Ejemplo en PowerShell:

```powershell
python -m mpremote connect COM8 fs cp captive_portal.py :captive_portal.py
python -m mpremote connect COM8 fs cp motor_curtain.py :motor_curtain.py
python -m mpremote connect COM8 fs cp wifi_recovery.py :wifi_recovery.py
python -m mpremote connect COM8 fs cp main.py :main.py
python -m mpremote connect COM8 reset
```

Comandos Pulsegrid soportados: `curtain.open`, `curtain.close`, `curtain.stop` y `curtain.move` con `position` o `percent`, opcionalmente `speed` de 10 a 100. La calibración añade `blind.ga25CalibrationStart`, `blind.ga25CalibrationStop` y `blind.ga25CalibrationCancel`; requiere supervisión visual continua.

GA25 OTA releases contain `main.py`, `captive_portal.py`, `motor_curtain.py`, `boot.py` and `ota_boot.py`. OTA uses a transactional flash staging area. Files are streamed in bounded chunks to `.pulsegrid_ota/stage`; the loader accepts either `Content-Length` or proxy `chunked` transfer encoding, checks the manifest size and SHA-256, then activates the release through `boot.py`. The previous set is retained in `.pulsegrid_ota/backup` until the new firmware confirms a healthy boot; a failed boot or watchdog reset restores that backup. `firmware.update` is handled by the cloud command loop.

Migration from the older GA25 loader is two-step: publish the new `main.py` alone first, then publish the complete release containing `boot.py` and `ota_boot.py`. The transitional loader keeps a legacy direct-download path only until those boot files exist.
