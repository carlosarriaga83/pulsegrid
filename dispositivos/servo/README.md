# Servo ESP32

Firmware MicroPython para el controlador Waveshare Servo Driver con ESP32 y servos ST/STS. El dispositivo se administra por Pulsegrid y las actualizaciones deben publicarse y aplicarse por OTA; no se presupone acceso USB/COM.

El perfil usa un unico `config.py` con Wi-Fi, API URL, API key, Device ID, comandos y sentido. La API key puede quedar vacia: el dispositivo usa `pg_bootstrap_v1` para recibir un `device.configure`, y hasta entonces no envia telemetria ni acepta comandos normales.

Archivos incluidos en un release OTA: `main.py`, `cloud_client.py`, `board_led.py`, `captive_portal.py`, `cortina.py`, `servo_calibration.py`, `stservo.py`, `boot.py`, `ota_boot.py` y `pulsegrid_ota.py`. `config.py` se genera durante la provision y no se reemplaza por OTA.

`main.py` mantiene sólo el arranque, Wi-Fi y hardware; `cloud_client.py` contiene el transporte HTTPS mínimo para que mbedTLS tenga memoria suficiente en el ESP32.

La placa Waveshare usa un RGB WS2812 en GPIO23. `board_led.py` controla los píxeles 0 y 1 del indicador integrado; no debe manejarse con `Pin.value()`. El comando cloud `led.configure` con `enabled: false` apaga ambos píxeles.

El adaptador `cortina.py` mantiene la superficie de movimiento del cloud (`curtain.open`, `curtain.close`, `curtain.stop`, `curtain.move`) sobre el bus STServo. Tambien implementa el asistente de calibracion (`blind.setMotorSide`, `blind.beginCalibration`, `blind.markDeployed`, `blind.markRolled`, `blind.jog`) y persiste los extremos, lado del motor, porcentaje objetivo y recorrido absoluto. Los estados `blind_state.py` y `multiturn_state.py` quedan fuera de OTA y de la limpieza del perfil del quemador; sus escrituras usan temporal y respaldo para recuperarse de un reset durante el guardado. Si un reset interrumpe un movimiento, se conserva la calibracion pero la posicion queda marcada para recuperacion. Un borrado completo de flash sí elimina esos archivos.

OTA usa el staging transaccional de `ota_boot.py`. Descarga por bloques pequeños y acepta tanto `Content-Length` como respuestas `chunked` del proxy, valida el tamaño declarado en el manifiesto y SHA-256, y activa el release después de un arranque saludable. Los archivos persistentes de calibración no forman parte del release.