# MicroPython de bajo consumo TLS para Servo

El MicroPython genérico del Servo falla durante el handshake porque TLS necesita memoria del heap interno ESP-IDF; los ~96 KB de `gc.mem_free()` pertenecen al heap de MicroPython y no se pueden usar automáticamente para satisfacer esas asignaciones. El heap interno tenía solo ~22 KB libres y un bloque contiguo máximo de ~20.5 KB.

Este perfil personalizado configura mbedTLS con buffers de registro dinámicos. Los buffers se asignan al necesitarlos y se liberan conforme se consumen; desactiva DTLS, que Pulsegrid no usa y que impide activar esa función en esta versión de ESP-IDF. También reduce los buffers estáticos RX de Wi-Fi a 6, igual al tamaño de la ventana BA, para devolver heap interno al handshake TLS. A diferencia de fijar un límite de entrada TLS menor, no establece un tamaño máximo de registro inferior a los 16 KB habituales, lo cual evita imponer ese límite a las descargas OTA.

## Construcción

Requiere MicroPython `v1.29.0` y ESP-IDF `v5.5.2`, con el entorno de compilación ESP32 activado. En Windows, MicroPython recomienda usar WSL. Desde WSL:

1. Clona MicroPython v1.29.0 con sus submódulos, compila `mpy-cross` y prepara ESP32 con `make -C ports/esp32 submodules`.
2. Construye el perfil pasando como `BOARD_DIR` la ruta WSL de `dispositivos/servo/micropython-board/PULSEGRID_SERVO` y `BOARD=PULSEGRID_SERVO` a `make -C ports/esp32`.
3. Comprueba en el `sdkconfig` generado que `CONFIG_MBEDTLS_DYNAMIC_BUFFER=y` y `CONFIG_MBEDTLS_SSL_PROTO_DTLS` no esté habilitado. El resultado combinado debe ser `ports/esp32/build-PULSEGRID_SERVO/firmware.bin`.

En la estación Windows, Ninja delega la compilación de `mpy-cross` a MSYS2 `make`; asegúrate de que `python3` resuelva al Python 3.11 de ESP-IDF, no al alias de Microsoft Store. La compilación validada aquí usó `C:\Espressif\python_env\idf5.5_py3.11_env\Scripts\python3.exe` como enlace a `python.exe`, junto con CMake, Ninja, ccache y Xtensa de ESP-IDF en `PATH`.

Imagen generada el 20-oct-2026: `PULSEGRID_SERVO-20261020-TLS.bin`, imagen combinada con bootloader, tabla de particiones y aplicación, preparada para escribirse desde el offset `0x1000`. SHA-256: `2D556F4B2DAB765EBB9414168169C1BA8BD45DC28C4FF9D065878C3B6EACFF2F`. El build final verifica `CONFIG_ESP_WIFI_STATIC_RX_BUFFER_NUM=6`, `CONFIG_ESP_WIFI_RX_BA_WIN=6`, `CONFIG_MBEDTLS_DYNAMIC_BUFFER=y`, DTLS deshabilitado y tamaños de registro TLS estándar de entrada/salida de 16384/4096 bytes. La compilación y la suite cloud (107 pruebas) terminaron correctamente; el handshake TLS y OTA en COM6 aún deben probarse con esta imagen antes de considerarla validada en hardware.

## Instalación y precauciones

La opción «Actualizar MicroPython (borra la flash)» del quemador elimina `config.py`, `blind_state.py` y `multiturn_state.py`. Guarda fuera de la placa la configuración y el estado/calibración antes de usarla; después vuelve a aprovisionar el Wi-Fi y restaura la calibración según corresponda. No flashees este perfil genérico en otra familia ESP32. El binario combinado se puede seleccionar en el quemador con ESP32; no selecciones una imagen `micropython.bin` sola, que no incluye el bootloader ni la tabla de particiones.

En la placa de prueba COM6 (ESP32-D0WD-V3), las lecturas iniciales mostraron `MBEDTLS_ERR_X509_ALLOC_FAILED`. Con buffers TLS dinámicos activados, las siguientes pruebas fallaron también; el heap interno y su bloque libre mayor bajaron durante los reintentos. Los ~68 KB de `gc.mem_free()` son el heap MicroPython y no sirven directamente para las asignaciones de mbedTLS hechas en el heap ESP-IDF. Detén los reintentos cloud antes de pruebas adicionales; cargar archivos `.py` no cambia el TLS compilado.

Para probarlo en COM6, primero respalda `config.py`, `blind_state.py` y `multiturn_state.py`; luego valida arranque, conexión Wi-Fi y varios handshakes TLS exitosos antes de probar OTA. Si la actualización falla, no interrumpas la alimentación: el mecanismo de staging OTA debe conservar el firmware Python activo, pero tendrás que resolver la conexión por el puerto serie.
