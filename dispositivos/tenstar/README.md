# Tenstar C3 Super Mini + DRV8871

Firmware MicroPython para controlar un motor de cortina con encoder incremental desde Pulsegrid. El quemador carga `main.py`, `tenstar_motor.py` y genera `config.py` para la placa.

## Cableado

| Señal | GPIO ESP32-C3 |
| --- | ---: |
| DRV8871 IN1 / PWM | 0 |
| DRV8871 IN2 / PWM | 1 |
| Encoder A | 3 |
| Encoder B | 4 |

El encoder usa pull-up interno y cuenta cuadratura en ambos flancos. No alimentar el motor desde el pin de 3.3 V de la placa. Comparte GND entre placa, driver y encoder; verifica tensiones y corriente admisibles del motor/driver antes de conectar.

## Carga con el quemador

1. Selecciona el perfil `tenstar`, tipo de placa `ESP32-C3`, puerto COM y una imagen MicroPython compatible si hace falta borrar/programar la flash.
2. Completa Wi-Fi y verifica que API use HTTPS.
3. Ajusta `PULSES_PER_REVOLUTION` tras comprobar una vuelta real. El valor inicial es 1980.
4. Ajusta `TRAVEL_TURNS` al recorrido físico medido de la cortina, y el sentido `OPEN_DIRECTION` (1 o -1). No asumas que los valores iniciales describen tu mecanismo.
5. En un sitio despejado, con posibilidad de cortar alimentación, usa una velocidad baja para validar el giro. No uses el movimiento para buscar topes mecánicos: no hay finales de carrera.
6. Carga el perfil, registra el dispositivo en Pulsegrid con el Device ID y código único mostrados por el quemador.
7. Coloca la cortina manualmente en su posición cerrada y envía `tenstar.zero` una sola vez. Esto establece la referencia de posición.
8. Prueba primero `curtain.move` a un porcentaje pequeño y confirma que abre/cierra en el sentido esperado antes de permitir movimientos completos.

## Controles Pulsegrid

- `curtain.open`, `curtain.close` y `curtain.move` operan dentro del recorrido configurado; `curtain.move` recibe `percent` de 0 a 100 y opcionalmente `speedPct` de 20 a 100. Los payloads estándar de Pulsegrid con `speed` (0-1800) también se aceptan y se convierten a porcentaje PWM.
- `curtain.stop` detiene el motor.
- `tenstar.zero` establece cero solo con el motor detenido. Debe ejecutarse desde la posición cerrada.
- `tenstar.jog` mueve brevemente: `direction` es 1 o -1, `speedPct` 20-100 y `durationMs` 100-5000. El firmware detiene el JOG localmente al vencer el tiempo.

El firmware actualiza el encoder en un bucle local de 10 ms. El acceso HTTPS/polling corre en otro hilo para que una espera de red no congele el control. Los comandos de movimiento reciben ACK de éxito solo al alcanzar la posición; una parada remota marca el movimiento interrumpido como fallido. Cada movimiento también tiene un límite local de 60 s.

La posición telemétrica es relativa al cero manual y usa el recorrido configurado. Si se desplaza el acople o se pierde la referencia, vuelve a colocar la cortina cerrada y establece el cero de nuevo. El firmware no puede detectar atascos mecánicos ni reemplaza finales de carrera.
