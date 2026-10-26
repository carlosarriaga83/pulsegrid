# Tenstar C3 Super Mini + DRV8871

Firmware MicroPython para controlar un motor de cortina con encoder incremental desde Pulsegrid. El quemador carga `boot.py`, `main.py`, `tenstar_motor.py`, `board_led.py`, `captive_portal.py` y los módulos compartidos `ota_boot.py`, `pulsegrid_ota.py` y `wifi_recovery.py`; genera `config.py` para la placa.

## Cableado

| Señal | GPIO ESP32-C3 |
| --- | ---: |
| DRV8871 IN1 / PWM | 0 |
| DRV8871 IN2 / PWM | 1 |
| Encoder A | 3 |
| Encoder B | 4 |
| LED de estado integrado (activo en bajo) | 8 |

El encoder usa pull-up interno y cuenta cuadratura en ambos flancos. No alimentar el motor desde el pin de 3.3 V de la placa. Comparte GND entre placa, driver y encoder; verifica tensiones y corriente admisibles del motor/driver antes de conectar.

## Wi-Fi, portal y diagnóstico

- Sin Wi-Fi configurado o mientras no logra conectar, anuncia la red abierta **Pulsegrid-Tenstar-XXXX**. Conéctate a esa red y abre **http://192.168.4.1/**. No depende de que el teléfono abra automáticamente una ventana de portal.
- Con Wi-Fi conectado, apaga el AP y conserva el formulario en **http://IP-DE-LA-PLACA/** dentro de la red local. La IP aparece en Thonny. El portal comparte el hilo de red; una petición HTTPS puede retrasar su respuesta, pero no el control local del motor.
- El portal solo modifica Wi-Fi: conserva identidad, API, parámetros del encoder, LED y calibración. Dejar la clave vacía conserva la anterior; marcar **Red abierta** la borra. Guardar reinicia la placa y exige que el motor esté detenido.
- Tres encendidos/reinicios físicos dentro de la ventana de 30 segundos activan recuperación Wi-Fi. En ese modo el AP permanece disponible hasta guardar la red en el portal. Un reinicio desde software no cuenta como pulsación física.
- El AP de configuración es abierto, como los otros perfiles Pulsegrid: úsalo en un entorno controlado. No muestra claves ni permite controlar o calibrar el motor.

El arranque imprime versión, destino Cloud, configuración del LED, inicio del hilo de red, dirección del portal y conexión Wi-Fi. Solo anuncia **Cloud conectado** tras una respuesta HTTPS correcta; tener Wi-Fi no implica estar registrado en Cloud. Un fallo indica la fase (`DNS`, `TCP`, `TLS`, `HTTP` o configuración) y el detalle del servidor, sin imprimir credenciales. Ante **HTTP 401**, verifica que Cloud tenga registrado el Device ID y el código generado por Quemador para esa placa.

Cloud comprueba la presencia reciente mediante `last_seen`, actualizado al recibir telemetría, consultas autenticadas de comandos o ACK. La antigüedad de una lectura idéntica deduplicada no convierte un Tenstar inmóvil en un dispositivo fuera de línea ni impide calibrarlo. Se conserva la deduplicación del historial.

### LED GPIO8

| Estado | Indicación |
| --- | --- |
| Cloud conectado | Encendido fijo |
| Conectando Wi-Fi | 250 ms encendido / 250 ms apagado |
| Wi-Fi conectado, sin respuesta Cloud válida reciente | Pulso breve cada 2 s |
| Sin Wi-Fi configurado o sin identidad | 500 ms encendido / 500 ms apagado |
| Recuperación Wi-Fi | 150 ms encendido / 150 ms apagado |
| Motor en movimiento | 80 ms encendido / 80 ms apagado |

El LED integrado de la C3 Super Mini se configura con `LED_PIN = 8` y `LED_ACTIVE_LOW = True`. Para una variante de placa con polaridad distinta, cambia `LED_ACTIVE_LOW` en `config.py`. Los estados se actualizan en el bucle local, sin esperar las llamadas de red.

## Carga con el quemador

1. Selecciona el perfil `tenstar`, tipo de placa `ESP32-C3`, puerto COM y una imagen MicroPython compatible si hace falta borrar/programar la flash. El quemador instala el mecanismo de OTA; las releases Tenstar deben incluir los archivos listados en `FIRMWARE_FILES`.
2. Completa Wi-Fi y verifica que API use HTTPS.
3. Ajusta `PULSES_PER_REVOLUTION` tras comprobar una vuelta real. El valor inicial es 1980. El quemador fija el PWM mínimo entre 20 y 35%; no configures recorrido ni sentido de apertura.
4. Carga el perfil y registra el dispositivo en Pulsegrid con el Device ID y código único mostrados por el quemador. Mantén accesible una forma de cortar alimentación.
5. Desde el asistente Tenstar de Pulsegrid Cloud, borra una calibración anterior si aplica. Lleva manualmente la cortina al extremo cerrado, sin forzar el tope, y pulsa **Marcar extremo cerrado**.
6. Usa **Pulso − / Pulso +** de manera supervisada para avanzar en la dirección deseada. Cada pulso dura 350 ms al 25%; observa el mecanismo y detén el motor inmediatamente si se acerca al tope o algo no parece normal.
7. En el extremo abierto, sin empujar contra el tope, pulsa **Marcar extremo abierto**. El firmware aprende el recorrido absoluto y el sentido a partir del encoder; la posición porcentual queda limitada a esos extremos.
8. Tras cada reinicio de la placa, coloca la cortina manualmente en cerrado y pulsa **Estoy en cerrado · fijar referencia**. La calibración persistente se conserva, pero la posición no se considera válida hasta volver a referenciar.

## Controles Pulsegrid

- `curtain.open`, `curtain.close` y `curtain.move` operan dentro del recorrido aprendido; `curtain.move` recibe `percent` de 0 a 100 y opcionalmente `speedPct` de 20 a 100. Los payloads estándar de Pulsegrid con `speed` (0-1800) también se aceptan y se convierten a porcentaje PWM.
- `curtain.stop` detiene el motor.
- `tenstar.calibration.reset`, `.setClosed`, `.setOpen` y `.referenceClosed` forman el flujo del asistente cloud.
- `tenstar.jog` solo se admite durante la calibración, después de marcar cerrado: `direction` es 1 o -1, `speedPct` 20-35 y `durationMs` 100-750. El firmware detiene el JOG localmente al vencer el tiempo.

El firmware actualiza el encoder en un bucle local de 10 ms. El acceso HTTPS/polling y el portal corren en otro hilo para que una espera de red no congele el control. Los comandos de movimiento reciben ACK de éxito solo al alcanzar la posición; una parada remota marca el movimiento interrumpido como fallido. Cada movimiento también tiene un límite local de 60 s.

La posición telemétrica es relativa a los extremos físicos aprendidos. Si se desplaza el acople o se pierde la referencia, vuelve a colocar la cortina cerrada y re-referencia desde Cloud. Las actualizaciones OTA verifican hash y aplican los archivos de forma transaccional, conservando `config.py` y `tenstar_calibration.json`; el quemador por USB sigue siendo necesario para instalar MicroPython inicialmente o recuperar una placa. El firmware no puede detectar atascos mecánicos ni reemplaza finales de carrera; la calibración requiere observación manual y nunca debe buscar topes automáticamente.

## Pruebas sin hardware

Desde la raíz del repositorio:

```powershell
python -B -m unittest discover -s .\dispositivos\tenstar\tests -p test_connectivity.py
```

Las pruebas simulan las interfaces MicroPython de TLS, Wi-Fi, GPIO y portal; no sustituyen la comprobación de la placa, sus credenciales ni el enlace con el servidor real.
