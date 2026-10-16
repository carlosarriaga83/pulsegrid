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
WIFI_RETRY_MIN_MS = 2000
WIFI_RETRY_MAX_MS = 60000
WIFI_CONNECT_TIMEOUT_MS = 20000
wifi_connect_started = None
wifi_connect_pending = False


def connect_wifi(wlan):
    global wifi_connect_started, wifi_connect_pending
    if not WIFI_SSID:
        return False
    try:
        wlan.active(True)
        if wlan.isconnected():
            wifi_connect_started = None
            wifi_connect_pending = False
            return True
        now = time.ticks_ms()
        if wifi_connect_pending:
            if wifi_connect_started is not None and time.ticks_diff(now, wifi_connect_started) < WIFI_CONNECT_TIMEOUT_MS:
                return False
            wlan.disconnect()
            wifi_connect_started = None
            wifi_connect_pending = False
            return False
        wifi_connect_started = now
        wifi_connect_pending = True
        wlan.connect(WIFI_SSID, WIFI_PASSWORD)
        return wlan.isconnected()
    except Exception as error:
        print('Wi-Fi reconexion:', error)
        return False


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
    global wifi_connect_pending, wifi_connect_started
    controller = build_controller()
    controller.parar()
    import board_led
    board_led.set_enabled(bool(API_KEY))
    wlan = network.WLAN(network.STA_IF)
    connected = connect_wifi(wlan)
    wifi_retry_ms = WIFI_RETRY_MIN_MS
    next_wifi_retry = time.ticks_add(time.ticks_ms(), wifi_retry_ms)
    if not connected or not API_KEY:
        import captive_portal
        captive_portal.start_background(controller)
    if not connected or not API_KEY:
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
        try:
            connected = wlan.isconnected()
        except Exception:
            connected = False
        if connected:
            wifi_connect_pending = False
            wifi_connect_started = None
        if connected and API_KEY:
            wifi_retry_ms = WIFI_RETRY_MIN_MS
            if time.ticks_diff(now, last_poll) >= 3000:
                last_poll = now
                client.commands(controller, board_led.set_enabled)
            if time.ticks_diff(now, last_telemetry) >= 5000:
                last_telemetry = now
                client.telemetry(controller, FIRMWARE_VERSION, bool(API_KEY), bool(controller.direction_reversed))
        else:
            board_led.set_provisioning()
            if not connected and time.ticks_diff(now, next_wifi_retry) >= 0:
                connected = connect_wifi(wlan)
                if connected:
                    wifi_retry_ms = WIFI_RETRY_MIN_MS
                    last_poll = 0
                    last_telemetry = 0
                else:
                    wifi_retry_ms = min(wifi_retry_ms * 2, WIFI_RETRY_MAX_MS)
                next_wifi_retry = time.ticks_add(time.ticks_ms(), wifi_retry_ms)
        time.sleep_ms(50)


main()
