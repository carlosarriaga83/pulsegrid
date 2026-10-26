# Quemador ESP32 de Pulsegrid

GUI de Tkinter para preparar una ESP32 nueva: detecta el puerto, identifica el chip, verifica MicroPython, borra y flashea una imagen `.bin`, y carga el perfil de archivos correcto para `servo`, `GA25`, `Tenstar C3` u `otros`.

## Instalacion

Desde PowerShell o una terminal de Windows:

```powershell
cd c:\xampp\htdocs\geriapp\v9\IOT\quemador
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe quemador.py
```

También puedes ejecutar `run_quemador.bat`: crea `.venv` e instala automáticamente las dependencias antes de abrir la GUI.

Tkinter forma parte de la instalacion normal de Python para Windows. La placa debe aparecer como un puerto COM y no debe estar ocupada por Thonny, Mu, Arduino IDE u otra terminal serial.

## Flujo recomendado

1. Conecta la ESP32 por USB.
2. Selecciona el modelo: `servo`, `ga25`, `tenstar` u `otros`.
3. Selecciona el tipo de chip o deja `Auto`.
4. Selecciona el COM.
6. Si el COM está ocupado por un intento anterior del quemador, pulsa `Liberar COM`. El botón detiene herramientas lanzadas por el quemador y comprueba que el puerto pueda abrirse.
7. Elige el `.bin` de MicroPython correspondiente al chip.
8. Pulsa `Detectar y verificar` para consultar el chip y la version instalada.
9. Si ya hay MicroPython instalado, desactiva `Actualizar MicroPython (borra la flash)`: el quemador usará `mpremote`, copiará los `.py` y hará un `soft-reset`.
10. Mantén activada esa casilla solo si la placa es nueva o necesita otra versión; en ese caso se usará `esptool` y se borrará la flash.
11. Configura Wi-Fi. Puedes introducir una MAC y pulsar `Calcular codigo` para obtener el Device ID y el código estable, o dejar el campo vacío para que el quemador lea la MAC de la placa al cargarla. Copia el código y regístralo en cloud. El portal local del ESP32 solo sirve para cambiar Wi-Fi.
12. Pulsa `VERIFICAR Y CARGAR`.

`Liberar COM` no termina procesos externos por seguridad. Si el puerto sigue ocupado, cierra Thonny, Arduino IDE, otro monitor serial o el proceso que tenga abierta la ESP32 y vuelve a pulsar el botón.

El borrado de flash elimina el contenido de la ESP32. La herramienta solo debe usarse cuando se tenga una copia de las credenciales necesarias.

## Perfiles

### Servo

Toma los archivos de `dispositivos/servo`:

```text
main.py
cloud_client.py
board_led.py
captive_portal.py
cortina.py
stservo.py
boot.py
ota_boot.py
pulsegrid_ota.py
wifi_recovery.py
```

Genera y carga un unico `config.py` con Wi-Fi, API URL HTTPS, código único, Device ID, comandos y sentido. Tras cargar, registra el Device ID y el código mostrado por el quemador en el cloud; el código no se imprime en el registro. El portal local solo cambia Wi-Fi.
La calibracion del servo se conserva en `blind_state.py` y `multiturn_state.py`; el quemador no elimina esos archivos al actualizar el firmware.
El `Device ID` se asigna como `PULSE_` seguido de los 12 dígitos hexadecimales de la MAC. El código estable de 44 caracteres concatena la MAC normalizada y los primeros 32 caracteres hexadecimales de SHA-256 sobre `pulsegrid-device-code-v1:` más la MAC. Se aceptan MAC compactas, con `:` o con `-`. **El código es calculable por cualquiera que conozca la MAC y no debe tratarse como secreto ni como prueba fuerte de identidad.** Los dispositivos que aún tengan un código aleatorio anterior deben registrarse de nuevo en cloud con el código calculado y volver a cargarse.

### GA25

Toma los archivos de `dispositivos/ga25/esp32_motor`:

```text
main.py
captive_portal.py
motor_curtain.py
boot.py
ota_boot.py
wifi_recovery.py
```

Genera y carga `config.py` con Wi-Fi, API URL HTTPS, código único, Device ID, recorrido y sentido del motor. Registra el Device ID y el código mostrado en el cloud. El portal local solo cambia Wi-Fi y conserva los ajustes del motor.
El `Device ID` se asigna como `PULSE_` seguido de los 12 dígitos hexadecimales de la MAC. El código se deriva de forma determinista de la misma MAC y puede calcularse antes de conectar la placa. Su derivación pública implica que no es un secreto; consulta la advertencia del perfil Servo.

### Tenstar C3 Super Mini

Carga `boot.py`, `main.py`, `tenstar_motor.py`, `tenstar_calibration.py`, `tenstar_http.py`, `board_led.py` y `captive_portal.py` desde `dispositivos/tenstar`, además de los módulos compartidos de OTA y recuperación Wi-Fi, y genera `config.py` con Wi-Fi, identidad, LED GPIO8 activo en bajo y ajustes de encoder. El perfil selecciona ESP32-C3 y permite configurar pulsos por vuelta (inicialmente 11880) y PWM mínimo de calibración (20–35%). Desde r5 se empieza manualmente en abierto, se fija el origen, se prueba 0,05 vueltas para confirmar si subió/bajó y se avanza por vueltas hasta confirmar cerrado. El ESP guarda el recorrido real y adapta abrir/cerrar/porcentaje; el quemador no estima esos valores.

Sin conexión Wi-Fi, Tenstar ofrece la red abierta `Pulsegrid-Tenstar-XXXX` y el portal `http://192.168.4.1/`; con conexión, el formulario está en la IP local impresa en Thonny. El portal conserva identidad y ajustes del motor. Tres reinicios físicos rápidos activan recuperación Wi-Fi, igual que en Servo/GA25. Al actualizar desde una instalación anterior, carga el perfil completo, no solo `main.py`: ahora requiere también los módulos de portal, LED, recuperación y `tenstar_http.py`. Este último separa el transporte para evitar el pico de compilación que agotaba la memoria TLS en C3. Reinicia al finalizar la carga.

Consulta `dispositivos/tenstar/README.md` antes de energizar el motor. No hay finales de carrera: calibra desde Pulsegrid Cloud con movimientos supervisados, sin buscar los topes mecánicos. Actualiza también servidor y archivos web de Cloud para el asistente desde abierto. Tras reiniciar, coloca manualmente en abierto y recupera la referencia; el recorrido guardado se conserva. La instalación OTA completa aún requiere validación en el build C3: consulta la limitación de memoria documentada antes de depender de ella.

Desde Tenstar r6, la red HTTPS y el portal se pausan durante los movimientos para no perder pulsos del encoder software. **La parada remota Cloud no está disponible durante el giro**; mantén un corte físico accesible y usa pasos cortos. Los pulsos por vuelta siguen en 11880; no se compensan pérdidas de conteo cambiando la escala. Actualiza también el servidor y la interfaz para mostrar esta limitación.

Tenstar r7 incluye `tenstar_state.py`: conserva recorrido, posición detenida y preferencia de LED con dos registros verificados. Tras un corte durante el movimiento conserva la calibración pero solicita confirmar un extremo manualmente. No borres `tenstar_calibration.json`, `.0`, `.1` ni `.moving` al actualizar. El asistente vertical muestra pasos completados y termina cerrado; el siguiente movimiento debe ser abrir o mover. El LED GPIO8 puede habilitarse/deshabilitarse desde Cloud.

Tenstar r8 añade `tenstar_loop.py` al perfil USB y OTA para ejecutar HTTPS en el hilo principal, solo con el motor detenido. No actualices únicamente `main.py`. Las confirmaciones fallidas se reintentan antes de consultar nuevas órdenes y después de publicar la posición actualizada. El asistente conserva su columna original del layout, mantiene los pasos internos verticales e indica cuándo espera la confirmación del movimiento.

### Otros

Selecciona una carpeta propia. La herramienta carga todos sus archivos `.py`, excepto archivos de configuración conocidos. Para este perfil debes incluir manualmente el archivo de configuración que tu firmware necesite.

## MicroPython

La herramienta usa `esptool` para:

- Leer el identificador del chip.
- Borrar la flash cuando se solicita actualización.
- Escribir la imagen en `0x1000`.

Después usa `mpremote` para comprobar que MicroPython arranca y para cargar los archivos. Tras flashear, el quemador espera el primer arranque y reintenta errores transitorios al entrar al REPL; considera la carga completa solo cuando aparezca `Carga terminada correctamente`.

Las imágenes `.bin` no se descargan automáticamente: selecciona una imagen oficial o una imagen local compatible con el tipo de ESP32. El repositorio incluye una imagen genérica en `dispositivos/servo/ESP32_GENERIC-20260824-v1.29.0.bin`. Esa imagen genérica **no** incluye el perfil de buffers TLS dinámicos; actualizar solo los archivos `.py` o volver a instalar esa imagen no corrige el `ENOMEM` observado. Para ello hace falta compilar el perfil `PULSEGRID_SERVO` y seleccionar el `.bin` personalizado resultante.

Para ESP32-S2, S3, C3, C6 o H2 selecciona una imagen construida específicamente para ese chip.
