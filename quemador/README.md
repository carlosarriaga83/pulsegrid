# Quemador ESP32 de Pulsegrid

GUI de Tkinter para preparar una ESP32 nueva: detecta el puerto, identifica el chip, verifica MicroPython, borra y flashea una imagen `.bin`, y carga el perfil de archivos correcto para `servo`, `GA25` u `otros`.

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
2. Selecciona el modelo: `servo`, `ga25` u `otros`.
3. Selecciona el tipo de chip o deja `Auto`.
4. Selecciona el COM.
6. Si el COM está ocupado por un intento anterior del quemador, pulsa `Liberar COM`. El botón detiene herramientas lanzadas por el quemador y comprueba que el puerto pueda abrirse.
7. Elige el `.bin` de MicroPython correspondiente al chip.
8. Pulsa `Detectar y verificar` para consultar el chip y la version instalada.
9. Si ya hay MicroPython instalado, desactiva `Actualizar MicroPython (borra la flash)`: el quemador usará `mpremote`, copiará los `.py` y hará un `soft-reset`.
10. Mantén activada esa casilla solo si la placa es nueva o necesita otra versión; en ese caso se usará `esptool` y se borrará la flash.
11. API URL, API key y Wi-Fi pueden dejarse vacíos: el firmware iniciará su portal de configuración.
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
```

Genera y carga un unico `config.py` con Wi-Fi, API URL, API key, Device ID, comandos y sentido. Si Wi-Fi o API key quedan vacíos, se configuran después desde el portal local o mediante bootstrap remoto.
La calibracion del servo se conserva en `blind_state.py` y `multiturn_state.py`; el quemador no elimina esos archivos al actualizar el firmware.
El `Device ID` se asigna automáticamente como `PULSE_XX`, donde `XX` es el último byte de la MAC de la ESP32.

### GA25

Toma los archivos de `dispositivos/ga25/esp32_motor`:

```text
main.py
captive_portal.py
motor_curtain.py
boot.py
ota_boot.py
```

Genera y carga `config.py` con Wi-Fi, API, Device ID, recorrido y sentido del motor. Si Wi-Fi, API URL o API key quedan vacíos, se configuran después desde el portal local.
El `Device ID` se asigna automáticamente como `PULSE_XX`, donde `XX` es el último byte de la MAC de la ESP32.

### Otros

Selecciona una carpeta propia. La herramienta carga todos sus archivos `.py`, excepto archivos de configuración conocidos. Para este perfil debes incluir manualmente el archivo de configuración que tu firmware necesite.

## MicroPython

La herramienta usa `esptool` para:

- Leer el identificador del chip.
- Borrar la flash cuando se solicita actualización.
- Escribir la imagen en `0x1000`.

Después usa `mpremote` para comprobar que MicroPython arranca y para cargar los archivos. Las imágenes `.bin` no se descargan automáticamente: selecciona una imagen oficial o una imagen local compatible con el tipo de ESP32. El repositorio incluye una imagen genérica en `dispositivos/servo/ESP32_GENERIC-20260824-v1.29.0.bin`.

Para ESP32-S2, S3, C3, C6 o H2 selecciona una imagen construida específicamente para ese chip.
