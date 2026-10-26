# Tenstar C3 Super Mini + DRV8871

Firmware MicroPython para controlar un motor de cortina con encoder incremental desde Pulsegrid. El quemador carga `main.py`, `tenstar_motor.py` y los módulos OTA compartidos `ota_boot.py` y `pulsegrid_ota.py`; genera `config.py` para la placa.

## Cableado

| Señal | GPIO ESP32-C3 |
| --- | ---: |
| DRV8871 IN1 / PWM | 0 |
| DRV8871 IN2 / PWM | 1 |
| Encoder A | 3 |
| Encoder B | 4 |

El encoder usa pull-up interno y cuenta cuadratura en ambos flancos. No alimentar el motor desde el pin de 3.3 V de la placa. Comparte GND entre placa, driver y encoder; verifica tensiones y corriente admisibles del motor/driver antes de conectar.

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

El firmware actualiza el encoder en un bucle local de 10 ms. El acceso HTTPS/polling corre en otro hilo para que una espera de red no congele el control. Los comandos de movimiento reciben ACK de éxito solo al alcanzar la posición; una parada remota marca el movimiento interrumpido como fallido. Cada movimiento también tiene un límite local de 60 s.

La posición telemétrica es relativa a los extremos físicos aprendidos. Si se desplaza el acople o se pierde la referencia, vuelve a colocar la cortina cerrada y re-referencia desde Cloud. Las actualizaciones OTA verifican hash y aplican los archivos de forma transaccional, conservando `config.py` y `tenstar_calibration.json`; el quemador por USB sigue siendo necesario para instalar MicroPython inicialmente o recuperar una placa. El firmware no puede detectar atascos mecánicos ni reemplaza finales de carrera; la calibración requiere observación manual y nunca debe buscar topes automáticamente.
