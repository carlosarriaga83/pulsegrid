from machine import I2C, Pin, UART

import cortina as cortina_module
from webserver_min import serve
import pulsegrid_min as pulsegrid
import ota_boot


if not hasattr(cortina_module, "_controller"):
	uart = UART(1, baudrate=1000000, bits=8, parity=None, stop=1, rx=18, tx=19)
	i2c = I2C(0, scl=Pin(22), sda=Pin(21), freq=100000)
	cortina_module._controller = cortina_module.Cortina(uart, i2c, min_position=300, max_position=3700)

cortina = cortina_module._controller

ota_boot.confirm()

print("Cortina lista")
print("Usar: cortina.abrir(), cortina.cerrar(), cortina.parar()")
serve(cortina, pulsegrid.sync)
