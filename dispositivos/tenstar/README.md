# Tenstar C3 Super Mini + DRV8871

Firmware MicroPython para controlar un motor de cortina con encoder incremental desde Pulsegrid. El quemador carga `boot.py`, `main.py`, `tenstar_motor.py`, `tenstar_calibration.py`, `tenstar_http.py`, `board_led.py`, `captive_portal.py` y los módulos compartidos `ota_boot.py`, `pulsegrid_ota.py` y `wifi_recovery.py`; genera `config.py` para la placa.

## Cableado

| Señal | GPIO ESP32-C3 |
| --- | ---: |
| DRV8871 IN1 / PWM | 0 |
| DRV8871 IN2 / PWM | 1 |
| Encoder A | 3 |
| Encoder B | 4 |
| LED de estado integrado (activo en bajo) | 8 |

El encoder usa pull-up interno y cuenta cuadratura en ambos flancos. No alimentar el motor desde el pin de 3.3 V de la placa. Comparte GND entre placa, driver y encoder; verifica tensiones y corriente admisibles del motor/driver antes de conectar.

### Precisión de vueltas y red en r6

Se mantienen **1980 pulsos por vuelta**. En COM11, una vuelta manual registró 1994 pulsos y una orden de una vuelta sin hilo de red produjo aproximadamente 360°. La misma orden con HTTPS simultáneo terminó cerca de 1980 pulsos pero físicamente giró aproximadamente 540°: el encoder por interrupciones software pierde transiciones durante TLS. Este build MicroPython no admite `Pin.irq(hard=True)` ni expone un contador de pulsos por hardware.

La r6 suspende HTTPS, consultas de comandos y portal mientras el motor está en movimiento, incluso en la misma iteración que inicia la orden. Al terminar publica posición y confirma el comando. **No hay parada remota Cloud durante el movimiento**; Cloud rechaza esos comandos en este perfil y el asistente lo advierte. Mantén un corte físico accesible y usa movimientos cortos supervisados. El límite local de 60 s se conserva. Una operación larga puede aparecer temporalmente sin conexión; la telemetría se reanuda al detenerse. No se modifica la escala para compensar pulsos perdidos.

Validación física de r6 en COM11: orden de una vuelta iniciada desde el hilo de red, objetivo 1980 pulsos, final 1979, duración 2,23 s. El usuario confirmó aproximadamente 360° en el eje de salida, frente a los aproximadamente 540° observados con HTTPS simultáneo antes del cambio.

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

### Memoria TLS en ESP32-C3

La r4 separa el transporte HTTP en `tenstar_http.py` para reducir el pico de memoria al compilar los archivos Python durante el arranque. No vuelvas a unir este módulo con `main.py`: en MicroPython el heap Python puede crecer tomando memoria del heap interno ESP-IDF, y `gc.collect()` no devuelve necesariamente esa región a TLS.

Probado en COM11 con MicroPython v1.28.0, build `LOLIN_C3_MINI`, ESP32-C3FH4: antes de la separación, cargar la aplicación dejaba aproximadamente 35 KB internos libres y el hilo con portal unos 18 KB; el handshake fallaba con `ENOMEM` aunque `gc.mem_free()` superaba 100 KB. Con el transporte separado quedaron aproximadamente 102 KB internos antes del hilo y 85 KB con hilo/portal, manteniendo un bloque libre de 64 KB. Se verificaron telemetrías HTTPS autenticadas repetidas, un reinicio normal observado durante 45 segundos sin `ENOMEM` y respuesta HTTP 200 del portal por LAN, sin movimiento del motor ni borrado de flash.

Carga también `tenstar_http.py` al actualizar por USB, y reinicia para liberar los heaps del firmware anterior. Quemador y la lista OTA incluyen este nuevo módulo; el servidor Cloud debe permitirlo en las releases.

La descarga/activación OTA completa no fue validada en esa prueba. Importar adicionalmente el módulo compartido `pulsegrid_ota` durante una prueba aislada volvió a reducir el heap interno y a provocar `ENOMEM`; esa ruta requiere validación y optimización adicional antes de considerarla comprobada en este build. No es necesario cambiar MicroPython para la telemetría y el portal verificados con r4.

La r5 con el nuevo módulo de calibración también se cargó por COM11: aproximadamente 103 KB internos libres tras importar la aplicación, arranque normal con hilo de red, conexión Cloud autenticada, 45 segundos sin `ENOMEM` y portal LAN HTTP 200. Esta comprobación no movió el motor ni marcó extremos; el recorrido físico debe confirmarlo el usuario.

## Carga con el quemador

1. Selecciona el perfil `tenstar`, tipo de placa `ESP32-C3`, puerto COM y una imagen MicroPython compatible si hace falta borrar/programar la flash. El quemador instala el mecanismo de OTA; las releases Tenstar deben incluir los archivos listados en `FIRMWARE_FILES`.
2. Completa Wi-Fi y verifica que API use HTTPS.
3. Ajusta `PULSES_PER_REVOLUTION` tras comprobar una vuelta real. El valor inicial es 1980. El quemador fija el PWM mínimo entre 20 y 35%; no configures recorrido ni sentido de apertura.
4. Carga el perfil y registra el dispositivo en Pulsegrid con el Device ID y código único mostrados por el quemador. Mantén accesible una forma de cortar alimentación.
5. Coloca manualmente la cortina completamente **abierta**, sin forzar el tope, y pulsa **Estoy en abierto · iniciar / resetear calibración**. Esto borra la calibración anterior y pone el encoder en cero, sin mover el motor.
6. Pulsa **Probar un paso pequeño (0,05 vueltas)**, vigila el mecanismo y confirma **El paso subió** o **El paso bajó**. Se usa encoder y PWM de al menos 25% (o el mínimo configurado, hasta 35%). Si no se registran pulsos, revisa el encoder y reinicia el asistente; no se adivina el sentido.
7. Introduce las vueltas por movimiento y usa **Bajar** o **Subir** tantas veces como haga falta. El ESP registra los pulsos reales, incluyendo la prueba y las correcciones. Cada orden y el recorrido total tienen un máximo de 20 vueltas; no se permite avanzar por encima del origen abierto. En r6 **no hay parada remota durante el giro**: mantén accesible el corte físico y usa pasos cortos.
8. Cuando compruebes que está completamente **cerrada**, sin empujar contra el tope, pulsa **Está completamente cerrada · guardar recorrido**. Se guardan recorrido y sentido en `tenstar_calibration.json`; abierto queda en 100% y cerrado en 0%.
9. Tras cada reinicio, coloca manualmente la cortina en abierto y pulsa **Estoy en abierto · recuperar referencia**, sin repetir toda la calibración. El encoder es incremental: el origen es una referencia de software, no una posición absoluta recuperable tras apagar. Una calibración interrumpida debe empezar otra vez desde abierto; las calibraciones completas anteriores se conservan.

Este asistente requiere firmware **r5 o posterior** y actualizar tanto `server.js` como los archivos web de Cloud. Carga también el nuevo módulo `tenstar_calibration.py` al actualizar por USB. La pantalla muestra las vueltas y pulsos relativos; el botón inicial y la confirmación final no mueven el motor.

## Controles Pulsegrid

- `curtain.open`, `curtain.close` y `curtain.move` operan dentro del recorrido aprendido; `curtain.move` recibe `percent` de 0 a 100 y opcionalmente `speedPct` de 20 a 100. Los payloads estándar de Pulsegrid con `speed` (0-1800) también se aceptan y se convierten a porcentaje PWM.
- `curtain.stop` es un comando local; en r6 Cloud rechaza la parada remota porque el dispositivo no consulta la cola mientras gira.
- `tenstar.calibration.begin` recibe `{"atOpen": true}` y fija el origen abierto. `.testDirection` inicia la prueba; `.confirmDirection` recibe `{"movement": "up"}` o `"down"`.
- `tenstar.calibration.step` recibe `{"turns": 0.25, "direction": "down"}` (o `"up"`); `.setClosed` guarda el extremo cerrado confirmado. Estos movimientos solo se permiten durante una calibración activa y con sentido confirmado.
- `.referenceOpen` o `.referenceClosed` fijan una referencia física manual de una calibración completa, sin mover; `.reset` elimina la calibración sin fijar referencia. No se admiten los comandos antiguos `.setOpen` y `tenstar.jog`.

El firmware controla el motor en un bucle local de 10 ms. HTTPS/polling y portal corren en otro hilo, pero desde r6 solo cuando el motor está detenido para evitar pérdida de pulsos. Los comandos de movimiento reciben ACK de éxito solo al alcanzar la posición. Cada movimiento también tiene un límite local de 60 s; no sustituye un corte físico ni finales de carrera.

La posición telemétrica es relativa a los extremos físicos aprendidos. Si se desplaza el acople o se pierde la referencia, vuelve a colocar la cortina abierta y recupera la referencia desde Cloud. Las actualizaciones OTA verifican hash y aplican los archivos de forma transaccional, conservando `config.py` y `tenstar_calibration.json`; el quemador por USB sigue siendo necesario para instalar MicroPython inicialmente o recuperar una placa. El firmware no puede detectar atascos mecánicos ni reemplaza finales de carrera; la calibración requiere observación manual y nunca debe buscar topes automáticamente.

## Pruebas sin hardware

Desde la raíz del repositorio:

```powershell
python -B -m unittest discover -s .\dispositivos\tenstar\tests -p "test_*.py"
```

Las pruebas simulan las interfaces MicroPython de TLS, Wi-Fi, GPIO y portal, y verifican calibración desde abierto en ambos sentidos, límites, persistencia, recuperación de referencia y porcentajes de apertura. No sustituyen la comprobación física del mecanismo.
