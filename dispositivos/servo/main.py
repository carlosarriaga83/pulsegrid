import gc
import json
import time
import network
import os
import socket
from machine import I2C, Pin, UART
import cortina as cortina_module
from stservo import STServoError

try:
    import ussl as tls
except ImportError:
    try:
        import ssl as tls
    except ImportError:
        tls = None

try:
    import ota_boot
except ImportError:
    ota_boot = None

try:
    from config import WIFI_SSID, WIFI_PASSWORD, API_URL, API_KEY, DEVICE_ID
    from config import COMMANDS_ENABLED, DIRECTION_REVERSED
except ImportError:
    WIFI_SSID = WIFI_PASSWORD = API_URL = API_KEY = DEVICE_ID = ''
    COMMANDS_ENABLED = True
    DIRECTION_REVERSED = False

FIRMWARE_TARGET = 'servo'
FIRMWARE_FILES = ('main.py', 'captive_portal.py', 'cortina.py', 'stservo.py', 'boot.py', 'ota_boot.py', 'pulsegrid_ota.py')
BOOTSTRAP_API_KEY = 'pg_bootstrap_v1'
REQUEST_TIMEOUT = 5
POLL_MS = 3000
TELEMETRY_MS = 5000
RETRY_MS = 5000
WIFI_RETRY_MS = 15000
STATUS_LED_PIN = 23
next_request_at = 0
next_wifi_retry = 0
last_poll = 0
last_telemetry = 0
last_presence = 0
bootstrap_retry_at = 0
pending_configuration = None
restart_requested = False
led_override = None
wifi_station = None


try:
    from pulsegrid_firmware import VERSION as FIRMWARE_VERSION
except (ImportError, AttributeError):
    FIRMWARE_VERSION = 'unversioned'


class StatusLed:
    def __init__(self, pin=STATUS_LED_PIN):
        self.rgb = None
        self.output = None
        try:
            import neopixel
            self.rgb = neopixel.NeoPixel(Pin(pin), 1)
        except (ImportError, TypeError):
            self.output = Pin(pin, Pin.OUT, value=0)

    def set(self, enabled):
        if self.rgb:
            self.rgb[0] = enabled if isinstance(enabled, tuple) else ((0, 30, 0) if enabled else (0, 0, 0))
            self.rgb.write()
        elif self.output:
            self.output.value(1 if enabled else 0)

    def portal_tick(self):
        self.set((time.ticks_ms() // 500) % 2 == 0)


def _controller():
    if not hasattr(cortina_module, '_controller'):
        uart = UART(1, baudrate=1000000, bits=8, parity=None, stop=1, rx=18, tx=19)
        i2c = I2C(0, scl=Pin(22), sda=Pin(21), freq=100000)
        cortina_module._controller = cortina_module.Cortina(
            uart, i2c, min_position=300, max_position=3700,
            servo_ids=(1, 2),
        )
    controller = cortina_module._controller
    controller.set_direction_reversed(bool(DIRECTION_REVERSED))
    return controller


def api_socket(timeout):
    gc.collect()
    secure = API_URL.startswith('https://')
    address = API_URL.split('://', 1)[-1].split('/', 1)[0]
    parts = address.split(':', 1)
    host = parts[0]
    port = int(parts[1]) if len(parts) > 1 else (443 if secure else 80)
    client = socket.socket()
    client.settimeout(timeout)
    client.connect((host, port))
    if secure:
        if tls is None:
            client.close()
            raise RuntimeError('TLS no disponible en este firmware')
        client = tls.wrap_socket(client, server_hostname=host)
    return client, host


def _unchunk(value):
    output = b''
    offset = 0
    while offset < len(value):
        end = value.find(b'\r\n', offset)
        if end < 0:
            break
        size = int(value[offset:end], 16)
        if size == 0:
            break
        start = end + 2
        output += value[start:start + size]
        offset = start + size + 2
    return output


def relay_request(method, path, body=None, api_key=None):
    client, host = api_socket(REQUEST_TIMEOUT)
    try:
        content = json.dumps(body) if body is not None else ''
        request_key = API_KEY if api_key is None else api_key
        request = '{} {} HTTP/1.1\r\nHost: {}\r\nX-API-Key: {}\r\nConnection: close\r\n'.format(method, path, host, request_key)
        if content:
            request += 'Content-Type: application/json\r\nContent-Length: {}\r\n'.format(len(content))
        client.send((request + '\r\n' + content).encode())
        result = b''
        while True:
            chunk = client.recv(512)
            if not chunk:
                break
            result += chunk
        separator = result.find(b'\r\n\r\n')
        status = int(result[9:12]) if len(result) >= 12 else 0
        if status < 200 or status >= 300:
            raise ValueError('HTTP {}'.format(status))
        header_end = separator if separator >= 0 else len(result)
        response_body = result[header_end + 4:] if separator >= 0 else b''
        if b'transfer-encoding: chunked' in result[:header_end].lower():
            response_body = _unchunk(response_body)
        return json.loads(response_body) if response_body else {}
    finally:
        client.close()
        gc.collect()


def request(method, path, body=None, api_key=None):
    global next_request_at
    key = API_KEY if api_key is None else api_key
    if not API_URL or not key or time.ticks_diff(time.ticks_ms(), next_request_at) < 0:
        return None
    try:
        return relay_request(method, path, body, key)
    except Exception as error:
        print('Pulsegrid:', error)
        next_request_at = time.ticks_add(time.ticks_ms(), RETRY_MS)
        return None
    finally:
        gc.collect()


def save_configuration(values):
    content = (
        'WIFI_SSID = {!r}\nWIFI_PASSWORD = {!r}\nAPI_URL = {!r}\nAPI_KEY = {!r}\n'
        'DEVICE_ID = {!r}\nCOMMANDS_ENABLED = {!r}\nDIRECTION_REVERSED = {!r}\n'
    ).format(
        values['wifi_ssid'], values['wifi_password'], values['api_url'], values['api_key'],
        values['device_id'], values['commands_enabled'], values['direction_reversed'],
    )
    with open('config.py.tmp', 'w') as config_file:
        config_file.write(content)
    try:
        os.remove('config.py')
    except OSError:
        pass
    os.rename('config.py.tmp', 'config.py')


def configure_from_command(payload, cortina):
    api_url = str(payload.get('apiUrl', '')).strip().rstrip('/')
    api_key = str(payload.get('apiKey', '')).strip() or API_KEY
    device_id = str(payload.get('deviceId', '')).strip()
    if not api_url or not api_key or not device_id:
        raise ValueError('API URL, API key y device ID son obligatorios')
    reversed_value = payload.get('reversed', DIRECTION_REVERSED)
    if not isinstance(reversed_value, bool):
        raise ValueError('reversed debe ser booleano')
    values = {
        'wifi_ssid': WIFI_SSID,
        'wifi_password': WIFI_PASSWORD,
        'api_url': api_url,
        'api_key': api_key,
        'device_id': device_id,
        'commands_enabled': COMMANDS_ENABLED,
        'direction_reversed': reversed_value,
    }
    save_configuration(values)
    cortina.set_direction_reversed(reversed_value)
    return values


def apply_configuration(values, cortina):
    global API_URL, API_KEY, DEVICE_ID, COMMANDS_ENABLED, DIRECTION_REVERSED
    API_URL = values['api_url']
    API_KEY = values['api_key']
    DEVICE_ID = values['device_id']
    COMMANDS_ENABLED = values['commands_enabled']
    DIRECTION_REVERSED = values['direction_reversed']
    cortina.set_direction_reversed(DIRECTION_REVERSED)


def poll_bootstrap(cortina):
    global bootstrap_retry_at, pending_configuration
    if not API_URL or not DEVICE_ID or API_KEY or time.ticks_diff(time.ticks_ms(), bootstrap_retry_at) < 0:
        return False
    bootstrap_retry_at = time.ticks_add(time.ticks_ms(), 60000)
    try:
        result = relay_request('GET', '/api/device-bootstrap?deviceId=' + DEVICE_ID, None, BOOTSTRAP_API_KEY)
        command = result.get('command') if result else None
        if command and command.get('name') == 'device.configure':
            pending_configuration = configure_from_command(command.get('payload') or {}, cortina)
            apply_configuration(pending_configuration, cortina)
            pending_configuration = None
            relay_request('POST', '/api/device-bootstrap/{}/ack'.format(command.get('id')), {'deviceId': DEVICE_ID, 'status': 'succeeded'}, BOOTSTRAP_API_KEY)
            print('Configuracion remota recibida; API key instalada')
            time.sleep_ms(250)
            import machine
            machine.reset()
            return True
    except Exception as error:
        print('Pulsegrid bootstrap:', error)
    return False


def acknowledge(command_id, status, error=None):
    body = {'deviceId': DEVICE_ID, 'status': status}
    if error:
        body['error'] = str(error)[:500]
    request('POST', '/api/device-commands/{}/ack'.format(command_id), body)


def update_firmware(version):
    import pulsegrid_ota
    pulsegrid_ota.update(API_URL, API_KEY, version, FIRMWARE_TARGET, FIRMWARE_FILES)


def execute(command, cortina):
    global pending_configuration, restart_requested, led_override
    name = command.get('name') or command.get('command')
    payload = command.get('payload') or {}
    if name == 'device.configure':
        pending_configuration = configure_from_command(payload, cortina)
    elif name == 'led.configure':
        if not isinstance(payload.get('enabled'), bool):
            raise ValueError('enabled debe ser booleano')
        led_override = payload['enabled']
    elif name == 'direction.configure':
        if not isinstance(payload.get('reversed'), bool):
            raise ValueError('reversed debe ser booleano')
        values = {
            'wifi_ssid': WIFI_SSID,
            'wifi_password': WIFI_PASSWORD,
            'api_url': API_URL,
            'api_key': API_KEY,
            'device_id': DEVICE_ID,
            'commands_enabled': COMMANDS_ENABLED,
            'direction_reversed': payload['reversed'],
        }
        save_configuration(values)
        cortina.set_direction_reversed(payload['reversed'])
    elif name == 'blind.setMotorSide':
        cortina.set_motor_side(int(payload.get('servoId', 1)), str(payload.get('side', '')))
    elif name == 'blind.beginCalibration':
        cortina.begin_blind_calibration(int(payload.get('servoId', 1)))
    elif name == 'blind.markDeployed':
        cortina.mark_deployed(int(payload.get('servoId', 1)))
    elif name == 'blind.markRolled':
        cortina.mark_rolled(int(payload.get('servoId', 1)))
    elif name == 'blind.jog':
        cortina.jog_blind(int(payload.get('servoId', 1)), str(payload.get('direction', '')), int(payload.get('speed', 800)), int(payload.get('acceleration', 50)))
    elif name == 'blind.configure':
        servo_id = int(payload.get('servoId', 1))
        rolled = float(payload['rolledTurns'])
        unrolled = float(payload['unrolledTurns'])
        if servo_id not in cortina.servo_ids or rolled == unrolled or abs(rolled) > cortina.MAX_LONG_TURNS or abs(unrolled) > cortina.MAX_LONG_TURNS:
            raise ValueError('extremos de calibracion invalidos')
        cortina.blind_config[servo_id]['rolled_turns'] = rolled
        cortina.blind_config[servo_id]['unrolled_turns'] = unrolled
        cortina.blind_config[servo_id]['calibrated'] = True
        cortina.position_recovery_required[servo_id] = False
        cortina._save_persistent_state()
    elif name == 'curtain.open':
        cortina.abrir(int(payload.get('speed', 800)), int(payload.get('acceleration', 50)))
    elif name == 'curtain.close':
        cortina.cerrar(int(payload.get('speed', 800)), int(payload.get('acceleration', 50)))
    elif name == 'curtain.stop':
        cortina.parar()
    elif name == 'curtain.move':
        value = payload.get('percent', payload.get('position'))
        if value is None:
            raise ValueError('curtain.move requiere percent o position')
        cortina.move_blind(int(payload.get('servoId', 1)), float(value), int(payload.get('speed', 800)), int(payload.get('acceleration', 50)))
    elif name == 'firmware.update':
        update_firmware(str(payload.get('version', '')))
        restart_requested = True
    else:
        raise ValueError('Comando no soportado: {}'.format(name))


def poll_commands(cortina):
    global pending_configuration, restart_requested
    if not API_KEY or not COMMANDS_ENABLED:
        return
    result = request('GET', '/api/device-commands?deviceId=' + DEVICE_ID)
    command = result.get('command') if result else None
    if not command:
        return
    try:
        execute(command, cortina)
        acknowledge(command.get('id'), 'succeeded')
        if command.get('name') == 'firmware.update':
            print('OTA completada; reiniciando')
            time.sleep_ms(250)
            import machine
            machine.reset()
            return
        if pending_configuration:
            apply_configuration(pending_configuration, cortina)
            pending_configuration = None
        if restart_requested:
            restart_requested = False
            import machine
            machine.reset()
        print('Comando ejecutado:', command.get('name'))
    except Exception as error:
        try:
            cortina.parar()
        except Exception:
            pass
        pending_configuration = None
        acknowledge(command.get('id'), 'failed', error)
        print('Comando rechazado:', error)


def send_telemetry(cortina):
    servos = {}
    for servo_id in cortina.servo_ids:
        try:
            values = cortina.multiturn_status(servo_id)
            values['position'] = cortina.position(servo_id)
            servos[str(servo_id)] = values
        except (OSError, STServoError, ValueError) as error:
            print('Servo {}: {}'.format(servo_id, error))
    state = {
        'deviceId': DEVICE_ID,
        'kind': 'curtain',
        'firmwareTarget': FIRMWARE_TARGET,
        'firmwareVersion': FIRMWARE_VERSION,
        'ledEnabled': led_override if led_override is not None else bool(API_KEY),
        'directionReversed': bool(cortina.direction_reversed),
        'online': True,
        'servos': servos,
    }
    request('POST', '/api/telemetry', state)


def wifi_connect():
    global wifi_station
    if not WIFI_SSID:
        print('Wi-Fi no configurado; el portal continua activo')
        return False
    wlan = network.WLAN(network.STA_IF)
    wifi_station = wlan
    wlan.active(True)
    if not wlan.isconnected():
        print('Conectando WiFi...')
        wlan.connect(WIFI_SSID, WIFI_PASSWORD)
        deadline = time.ticks_add(time.ticks_ms(), 15000)
        while not wlan.isconnected() and time.ticks_diff(deadline, time.ticks_ms()) > 0:
            time.sleep_ms(250)
    if wlan.isconnected():
        print('WiFi:', wlan.ifconfig()[0])
        return True
    print('Wi-Fi no disponible')
    return False


def main():
    global last_poll, last_telemetry, last_presence, next_wifi_retry
    cortina = _controller()
    cortina.parar()
    status_led = StatusLed()
    if ota_boot:
        ota_boot.confirm()
    print('Cortina servo lista; firmware {}'.format(FIRMWARE_VERSION))
    connected = wifi_connect()
    if connected and not API_KEY:
        poll_bootstrap(cortina)
    if not connected or not API_KEY:
        import captive_portal
        captive_portal.start_background(cortina)
    if connected:
        status_led.set(True if API_KEY else (30, 25, 0))
    else:
        status_led.portal_tick()
    while True:
        if ota_boot:
            ota_boot.feed()
        now = time.ticks_ms()
        cortina.update_multiturn()
        connected = bool(wifi_station and wifi_station.isconnected())
        if connected:
            status_led.set(led_override if led_override is not None else (True if API_KEY else (30, 25, 0)))
        else:
            status_led.portal_tick()
            if time.ticks_diff(now, next_wifi_retry) >= 0:
                next_wifi_retry = time.ticks_add(now, WIFI_RETRY_MS)
                wifi_connect()
        if connected and not API_KEY and time.ticks_diff(now, last_presence) >= 5000:
            last_presence = now
            poll_bootstrap(cortina)
        if connected and API_KEY and time.ticks_diff(now, last_poll) >= POLL_MS:
            last_poll = now
            poll_commands(cortina)
        if connected and API_KEY and time.ticks_diff(now, last_telemetry) >= TELEMETRY_MS:
            last_telemetry = now
            send_telemetry(cortina)
        time.sleep_ms(50)


main()
