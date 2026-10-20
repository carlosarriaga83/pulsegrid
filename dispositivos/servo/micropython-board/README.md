# MicroPython de bajo consumo TLS para Servo

El MicroPython genérico del Servo falla durante el handshake porque TLS necesita memoria del heap interno ESP-IDF; los ~96 KB de `gc.mem_free()` pertenecen al heap de MicroPython y no se pueden usar automáticamente para satisfacer esas asignaciones. El heap interno tenía solo ~22 KB libres y un bloque contiguo máximo de ~20.5 KB.

Este perfil personalizado configura mbedTLS con buffers de registro dinámicos. Los buffers se asignan al necesitarlos y se liberan conforme se consumen; desactiva DTLS, que Pulsegrid no usa y que impide activar esa función en esta versión de ESP-IDF. A diferencia de fijar un límite de entrada TLS menor, no establece un tamaño máximo de registro inferior a los 16 KB habituales, lo cual evita imponer ese límite a las descargas OTA.

## Construcción

Requiere MicroPython `v1.29.0` y ESP-IDF `v5.5.2`, con el entorno de compilación ESP32 activado. En Windows, MicroPython recomienda usar WSL. Desde WSL:

1. Clona MicroPython v1.29.0 con sus submódulos, compila `mpy-cross` y prepara ESP32 con `make -C ports/esp32 submodules`.
2. Construye el perfil pasando como `BOARD_DIR` la ruta WSL de `dispositivos/servo/micropython-board/PULSEGRID_SERVO` y `BOARD=PULSEGRID_SERVO` a `make -C ports/esp32`.
3. Comprueba en el `sdkconfig` generado que `CONFIG_MBEDTLS_DYNAMIC_BUFFER=y` y `CONFIG_MBEDTLS_SSL_PROTO_DTLS` no esté habilitado. El resultado combinado debe ser `ports/esp32/build-PULSEGRID_SERVO/firmware.bin`.

En la estación de desarrollo de Windows están ESP-IDF 5.5.2 y MicroPython v1.29.0. Usa el entorno ESP-IDF exportado más MSYS2/GNU Make para la compilación recursiva; una compilación que llame a `python3` desde `cmd.exe` puede resolver el alias de Microsoft Store, y Ninja necesita encontrar `ccache` y Xtensa en `PATH`. Confirma el `sdkconfig` final y valida repetidamente TLS y OTA en COM6 antes de distribuir el binario.

## Instalación y precauciones

La opción «Actualizar MicroPython (borra la flash)» del quemador elimina `config.py`, `blind_state.py` y `multiturn_state.py`. Guarda fuera de la placa la configuración y el estado/calibración antes de usarla; después vuelve a aprovisionar el Wi-Fi y restaura la calibración según corresponda. No flashees este perfil genérico en otra familia ESP32.

En la placa de prueba COM6 (ESP32-D0WD-V3), las lecturas iniciales mostraron `MBEDTLS_ERR_X509_ALLOC_FAILED`. Con buffers TLS dinámicos activados, las siguientes pruebas fallaron también; el heap interno y su bloque libre mayor bajaron durante los reintentos. Los ~68 KB de `gc.mem_free()` son el heap MicroPython y no sirven directamente para las asignaciones de mbedTLS hechas en el heap ESP-IDF. Detén los reintentos cloud antes de pruebas adicionales; cargar archivos `.py` no cambia el TLS compilado.

Cuando esté disponible el binario personalizado, primero valida en COM6 que arranca, conecta al Wi-Fi, completa TLS repetidamente y acepta un OTA de prueba. Si la actualización falla, no interrumpas la alimentación: el mecanismo de staging OTA debe conservar el firmware Python activo, pero tendrás que resolver la conexión por el puerto serie.
