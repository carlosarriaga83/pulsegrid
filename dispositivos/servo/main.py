import gc
import machine
import network
import time
import sys
from machine import I2C, Pin, UART

try:
    import config as device_config
    WIFI_SSID = getattr(device_config, 'WIFI_SSID', '')
    WIFI_PASSWORD = getattr(device_config, 'WIFI_PASSWORD', '')
    API_URL = getattr(device_config, 'API_URL', '')
    DEVICE_CODE = getattr(device_config, 'DEVICE_CODE', '')
    DEVICE_ID = getattr(device_config, 'DEVICE_ID', '')
    COMMANDS_ENABLED = getattr(device_config, 'COMMANDS_ENABLED', True)
    DIRECTION_REVERSED = getattr(device_config, 'DIRECTION_REVERSED', False)
except ImportError:
    WIFI_SSID = WIFI_PASSWORD = API_URL = DEVICE_CODE = DEVICE_ID = ''
    COMMANDS_ENABLED = True
    DIRECTION_REVERSED = False

FIRMWARE_VERSION = '2026.10.19.servo-r15'
FIRMWARE_FILES = ('main.py', 'cloud_client.py', 'board_led.py', 'captive_portal.py', 'cortina.py', 'servo_calibration.py', 'stservo.py', 'boot.py', 'ota_boot.py', 'pulsegrid_ota.py', 'wifi_recovery.py')
COMMAND_POLL_MS = 1000
CALIBRATION_COMMAND_POLL_MS = 200
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
    import wifi_recovery
    try:
        reset_cause = machine.reset_cause()
        # ESP32 dev boards often report an EN/RESET button press as PWRON_RESET.
        count_reset = reset_cause in (getattr(machine, 'PWRON_RESET', 1), getattr(machine, 'HARD_RESET', 2))
    except Exception:
        reset_cause = 'unknown'
        count_reset = False
    recovery_mode = wifi_recovery.register_boot(count_reset)
    print('Causa de arranque: {}; reset manual contado: {}'.format(reset_cause, count_reset))
    boot_started_at = time.ticks_ms()
    controller = build_controller()
    controller.parar()
    import board_led
    board_led.set_enabled(True)
    wlan = network.WLAN(network.STA_IF)
    if recovery_mode:
        try:
            wlan.disconnect()
            wlan.active(False)
        except Exception as error:
            print('Wi-Fi STA desactivada para provisionamiento:', error)
        connected = False
    else:
        connected = connect_wifi(wlan)
    wifi_retry_ms = WIFI_RETRY_MIN_MS
    next_wifi_retry = time.ticks_add(time.ticks_ms(), wifi_retry_ms)
    import captive_portal
    captive_portal.start_background(controller, recovery_mode)
    if recovery_mode:
        print('Recuperacion Wi-Fi : cambie la red en el portal Pulsegrid y guarde para reiniciar')
    elif connected and DEVICE_CODE:
        print('Servo cloud activo; firmware {}'.format(FIRMWARE_VERSION))
    elif not DEVICE_CODE:
        print('Servo en modo provisionamiento; esperando el codigo del dispositivo')
    else:
        print('Conectando a la red Wi-Fi guardada antes de iniciar el portal local')
    from cloud_client import CloudClient
    client = CloudClient(API_URL, DEVICE_CODE, DEVICE_ID, COMMANDS_ENABLED)
    ota_boot = sys.modules.get('ota_boot')
    if ota_boot:
        ota_boot.confirm()
    last_state_publish = 0
    last_cloud_poll = 0
    wifi_recovery_cleared = False
    while True:
        if ota_boot:
            ota_boot.feed()
        controller.update_multiturn()
        now = time.ticks_ms()
        try:
            connected = wlan.isconnected()
        except Exception:
            connected = False
        if connected:
            wifi_connect_pending = False
            wifi_connect_started = None
        if recovery_mode:
            board_led.set_status('recovery')
        elif not DEVICE_CODE:
            board_led.set_status('provisioning')
        elif not connected or not client.is_online():
            board_led.set_status('offline')
        else:
            board_led.set_status('online')
        if not recovery_mode and not wifi_recovery_cleared and time.ticks_diff(now, boot_started_at) >= wifi_recovery.STABLE_BOOT_MS:
            wifi_recovery.clear_boots()
            wifi_recovery_cleared = True
        if connected and DEVICE_CODE and not recovery_mode:
            wifi_retry_ms = WIFI_RETRY_MIN_MS
            moving = any(controller.multiturn_active.values())
            calibrating = any(config.get('calibration_in_progress') for config in controller.blind_config.values())
            if not moving:
                poll_interval = CALIBRATION_COMMAND_POLL_MS if calibrating else COMMAND_POLL_MS
                if time.ticks_diff(now, last_cloud_poll) >= poll_interval:
                    last_cloud_poll = now
                    client.flush_ack()
                    if not client._pending_ack:
                        client.commands(controller, board_led.set_enabled)
                telemetry_interval = 500 if calibrating else 2000
                if not any(controller.multiturn_active.values()) and time.ticks_diff(now, last_state_publish) >= telemetry_interval:
                    last_state_publish = time.ticks_ms()
                    client.telemetry(controller, FIRMWARE_VERSION, board_led.is_enabled(), bool(controller.direction_reversed))
        else:
            if not recovery_mode and not connected and time.ticks_diff(now, next_wifi_retry) >= 0:
                connected = connect_wifi(wlan)
                if connected:
                    wifi_retry_ms = WIFI_RETRY_MIN_MS
                    last_state_publish = 0
                    last_cloud_poll = 0
                else:
                    wifi_retry_ms = min(wifi_retry_ms * 2, WIFI_RETRY_MAX_MS)
                next_wifi_retry = time.ticks_add(time.ticks_ms(), wifi_retry_ms)
        if client.firmware_update_requested:
            controller.parar()
            time.sleep_ms(250)
            machine.reset()
        board_led.tick()
        time.sleep_ms(10)


main()
