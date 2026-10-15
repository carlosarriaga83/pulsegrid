# Firmware MicroPython: cortina GA25YN370

Para LOLIN S2 Mini / ESP32-S2:

- GPIO16: EN del puente H, PWM de velocidad.
- GPIO18: entrada de direccion A.
- GPIO33: entrada de direccion B.

El firmware consulta los comandos de Pulsegrid y envia telemetria. Sin encoder o sensor, `position` es una estimacion basada en tiempo; ajusta `FULL_TRAVEL_MS` despues de medir el recorrido real.

## Carga

1. Instala `mpremote` y carga `captive_portal.py`, `motor_curtain.py` y `main.py`.
2. Reinicia la placa. Si no existe `config.py` o no puede conectar a la red configurada, crea la red abierta `Pulsegrid-Cortina`.
3. Conecta el telefono o PC a esa red y abre `http://192.168.4.1/`. El portal guarda Wi-Fi, API key, `DEVICE_ID` y tiempo de recorrido.
4. La placa reinicia y se conecta a la red configurada.

Cuando la placa está conectada, el portal escucha en su IP dentro de la red Wi-Fi. El AP `Pulsegrid-Cortina` queda apagado y solo se activa como portal de recuperacion si la conexión se pierde o las credenciales dejan de funcionar. Si rotas la API key y la placa sigue conectada, abre el portal en su IP LAN; si pierde la conexión, usa el AP `192.168.4.1`.

Tambien puedes preparar `config.py` a partir de `config.example.py` y cargarlo directamente. La red de configuracion es abierta y no debe usarse para trafico sensible; solo expone el portal local durante la configuracion.

Ejemplo en PowerShell:

```powershell
python -m mpremote connect COM8 fs cp captive_portal.py :captive_portal.py
python -m mpremote connect COM8 fs cp motor_curtain.py :motor_curtain.py
python -m mpremote connect COM8 fs cp main.py :main.py
python -m mpremote connect COM8 reset
```

Comandos Pulsegrid soportados: `curtain.open`, `curtain.close`, `curtain.stop` y `curtain.move` con `position` o `percent`, opcionalmente `speed` de 10 a 100.

OTA uses a transactional flash staging area. Files are downloaded in chunks to `.pulsegrid_ota/stage`, checked against the declared `Content-Length` and SHA-256, then activated by `boot.py`. The previous set is retained in `.pulsegrid_ota/backup` until the new firmware confirms a healthy boot; a failed boot or watchdog reset restores that backup.

Migration from the older GA25 loader is two-step: publish the new `main.py` alone first, then publish the complete release containing `boot.py` and `ota_boot.py`. The transitional loader keeps a legacy direct-download path only until those boot files exist.
