import gc
import network
import time
import sys
from machine import I2C, Pin, UART

try:
    from config import WIFI_SSID, WIFI_PASSWORD, API_URL, API_KEY, DEVICE_ID, COMMANDS_ENABLED, DIRECTION_REVERSED
except ImportError:
    WIFI_SSID = WIFI_PASSWORD = API_URL = API_KEY = DEVICE_ID = ''
    COMMANDS_ENABLED = True
    DIRECTION_REVERSED = False

FIRMWARE_VERSION = '2026.10.15.servo'
FIRMWARE_FILES = ('main.py', 'cloud_client.py', 'board_led.py', 'captive_portal.py', 'cortina.py', 'servo_calibration.py', 'stservo.py', 'boot.py', 'ota_boot.py', 'pulsegrid_ota.py')


def connect_wifi():
    wlan = network.WLAN(network.STA_IF)
    wlan.active(True)
    if not wlan.isconnected():
        wlan.connect(WIFI_SSID, WIFI_PASSWORD)
        time.sleep_ms(8000)
    return wlan if wlan.isconnected() else None


def build_controller():
    import cortina as cortina_module
    uart = UART(1, baudrate=1000000, bits=8, parity=None, stop=1, rx=18, tx=19)
    i2c = I2C(0, scl=Pin(22), sda=Pin(21), freq=100000)
    controller = cortina_module.Cortina(uart, i2c, min_position=300, max_position=3700, servo_ids=(1, 2))
    controller.set_direction_reversed(bool(DIRECTION_REVERSED))
    cortina_module = None
    sys.modules.pop('cortina', None)
    gc.collect()
    return controller


def main():
    controller = build_controller()
    controller.parar()
    import board_led
    board_led.set_enabled(bool(API_KEY))
    wlan = connect_wifi()
    if not wlan or not API_KEY:
        import captive_portal
        captive_portal.start_background(controller)
    if not wlan or not API_KEY:
        print('Servo en modo provisionamiento')
    else:
        print('Servo cloud activo; firmware {}'.format(FIRMWARE_VERSION))
    from cloud_client import CloudClient
    client = CloudClient(API_URL, API_KEY, DEVICE_ID, COMMANDS_ENABLED)
    last_poll = 0
    last_telemetry = 0
    while True:
        controller.update_multiturn()
        now = time.ticks_ms()
        if wlan and wlan.isconnected() and API_KEY:
            if time.ticks_diff(now, last_poll) >= 3000:
                last_poll = now
                client.commands(controller, board_led.set_enabled)
            if time.ticks_diff(now, last_telemetry) >= 5000:
                last_telemetry = now
                client.telemetry(controller, FIRMWARE_VERSION, bool(API_KEY), bool(controller.direction_reversed))
        else:
            board_led.set_provisioning()
            if not wlan or not wlan.isconnected():
                wlan = connect_wifi()
        time.sleep_ms(50)


main()
