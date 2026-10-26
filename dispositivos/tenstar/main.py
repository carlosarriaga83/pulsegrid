import gc
import json
import machine
import network
import socket
import time
import _thread

from tenstar_motor import TenstarMotor

try:
    import config
    WIFI_SSID = getattr(config, 'WIFI_SSID', '')
    WIFI_PASSWORD = getattr(config, 'WIFI_PASSWORD', '')
    API_URL = getattr(config, 'API_URL', 'https://pulse.2api2.com')
    DEVICE_CODE = getattr(config, 'DEVICE_CODE', '')
    DEVICE_ID = getattr(config, 'DEVICE_ID', '')
    PULSES_PER_REVOLUTION = getattr(config, 'PULSES_PER_REVOLUTION', 1980)
    KP = getattr(config, 'KP', 0.3)
    MINIMUM_SPEED_PCT = getattr(config, 'MINIMUM_SPEED_PCT', 20)
    COMMANDS_ENABLED = getattr(config, 'COMMANDS_ENABLED', True)
except ImportError:
    WIFI_SSID = WIFI_PASSWORD = DEVICE_CODE = DEVICE_ID = ''
    API_URL = 'https://pulse.2api2.com'
    PULSES_PER_REVOLUTION = 1980
    KP = 0.3
    MINIMUM_SPEED_PCT = 20
    COMMANDS_ENABLED = True

FIRMWARE_TARGET = 'tenstar'
FIRMWARE_VERSION = '2026.10.25.tenstar-r2'
try:
    from pulsegrid_firmware import VERSION as FIRMWARE_VERSION
except (ImportError, AttributeError):
    pass
FIRMWARE_FILES = ('boot.py', 'main.py', 'tenstar_motor.py', 'ota_boot.py', 'pulsegrid_ota.py')
CALIBRATION_FILE = 'tenstar_calibration.json'
COMMAND_POLL_MS = 1000
TELEMETRY_MS = 2000
REQUEST_TIMEOUT = 5
RETRY_MS = 2000

motor = TenstarMotor(pulses_per_revolution=PULSES_PER_REVOLUTION, kp=KP, minimum_speed=MINIMUM_SPEED_PCT)
motor_lock = _thread.allocate_lock()
wlan = network.WLAN(network.STA_IF)
last_poll = 0
last_telemetry = 0
next_request_at = 0
next_wifi_retry = 0
pending_motion_command = None
ack_queue = []
position_valid = False
restart_requested = False
calibration = {'closed_marked': False, 'open_marked': False, 'calibrated': False, 'open_span_pulses': 0, 'open_direction': 1}


def load_calibration():
    global calibration
    try:
        with open(CALIBRATION_FILE, 'r') as state_file:
            saved = json.loads(state_file.read())
        if isinstance(saved, dict):
            span = int(saved.get('open_span_pulses', 0))
            direction = int(saved.get('open_direction', 1))
            calibration = {
                'closed_marked': bool(saved.get('closed_marked', False)),
                'open_marked': bool(saved.get('open_marked', False)),
                'calibrated': bool(saved.get('calibrated', False)) and bool(saved.get('closed_marked', False)) and bool(saved.get('open_marked', False)) and span >= 100 and direction in (-1, 1),
                'open_span_pulses': span if span >= 100 else 0,
                'open_direction': direction if direction in (-1, 1) else 1,
            }
    except (OSError, ValueError, TypeError):
        pass


def save_calibration():
    temporary = CALIBRATION_FILE + '.tmp'
    with open(temporary, 'w') as state_file:
        state_file.write(json.dumps(calibration))
    try:
        import os
        os.rename(temporary, CALIBRATION_FILE)
    except OSError:
        try:
            import os
            os.remove(CALIBRATION_FILE)
        except OSError:
            pass
        import os
        os.rename(temporary, CALIBRATION_FILE)


def _read_response(client):
    response = b''
    while True:
        chunk = client.recv(512)
        if not chunk:
            break
        response += chunk
        if len(response) > 20000:
            raise ValueError('Respuesta HTTP demasiado grande')
    split_at = response.find(b'\r\n\r\n')
    if split_at < 0:
        raise ValueError('Respuesta HTTP incompleta')
    header = response[:split_at].lower()
    status_line = response.split(b'\r\n', 1)[0]
    status = int(status_line[9:12])
    body = response[split_at + 4:]
    if b'transfer-encoding: chunked' in header:
        decoded = b''
        offset = 0
        while offset < len(body):
            end = body.find(b'\r\n', offset)
            if end < 0:
                raise ValueError('Respuesta chunked incompleta')
            size = int(body[offset:end].split(b';', 1)[0].strip(), 16)
            if size == 0:
                break
            start = end + 2
            decoded += body[start:start + size]
            offset = start + size + 2
        body = decoded
    if status < 200 or status >= 300:
        raise ValueError('HTTP {}'.format(status))
    return json.loads(body.decode()) if body else {}


def request(method, path, payload=None):
    global next_request_at
    if not API_URL.startswith('https://') or not DEVICE_CODE or not DEVICE_ID:
        return None
    now = time.ticks_ms()
    if time.ticks_diff(now, next_request_at) < 0:
        return None
    client = None
    try:
        gc.collect()
        host = API_URL.split('://', 1)[1].split('/', 1)[0]
        address = socket.getaddrinfo(host, 443, 0, socket.SOCK_STREAM)[0][-1]
        client = socket.socket()
        client.settimeout(REQUEST_TIMEOUT)
        client.connect(address)
        try:
            import ussl as tls
        except ImportError:
            import ssl as tls
        client = tls.wrap_socket(client, server_hostname=host)
        body = json.dumps(payload) if payload is not None else ''
        headers = 'Connection: close\r\nX-Device-Code: {}\r\n'.format(DEVICE_CODE)
        if body:
            headers += 'Content-Type: application/json\r\nContent-Length: {}\r\n'.format(len(body.encode()))
        message = '{} {} HTTP/1.1\r\nHost: {}\r\n{}\r\n{}'.format(method, path, host, headers, body)
        client.write(message.encode())
        result = _read_response(client)
        next_request_at = 0
        return result
    except Exception as error:
        print('Pulsegrid:', error)
        next_request_at = time.ticks_add(time.ticks_ms(), RETRY_MS)
        return None
    finally:
        if client:
            try:
                client.close()
            except Exception:
                pass
        gc.collect()


def acknowledge(command_id, status, error=None):
    payload = {'deviceId': DEVICE_ID, 'status': status}
    if error:
        payload['error'] = str(error)[:500]
    result = request('POST', '/api/device-commands/{}/ack'.format(command_id), payload)
    return bool(result and result.get('ok'))


def send_telemetry():
    pulses = motor.snapshot()
    span = calibration['open_span_pulses']
    position = max(0, min(100, round((pulses * calibration['open_direction'] / float(span)) * 100))) if span > 0 else None
    request('POST', '/api/telemetry', {
        'deviceId': DEVICE_ID,
        'kind': 'curtain',
        'firmwareTarget': FIRMWARE_TARGET,
        'firmwareVersion': FIRMWARE_VERSION,
        'online': True,
        'positionPulses': pulses,
        'positionTurns': round(pulses / float(PULSES_PER_REVOLUTION), 4),
        'position': position if position_valid and calibration['calibrated'] else None,
        'targetPosition': getattr(motor, 'target_position', None),
        'pulsesPerRevolution': PULSES_PER_REVOLUTION,
        'minimumSpeedPct': MINIMUM_SPEED_PCT,
        'positionValid': position_valid,
        'calibration': dict(calibration),
        'moving': motor.moving,
        'targetPulses': motor.target,
    })


def execute(command):
    global pending_motion_command, position_valid, restart_requested
    name = command.get('name')
    payload = command.get('payload') or {}
    command_id = command.get('id')
    try:
        if command_id is None:
            raise ValueError('El comando cloud no tiene ID')
        if name in ('tenstar.stop', 'curtain.stop'):
            if payload:
                raise ValueError('El comando stop no recibe payload')
            with motor_lock:
                motor.stop()
                interrupted = pending_motion_command
                pending_motion_command = None
            if interrupted is not None:
                acknowledge(interrupted, 'failed', 'Movimiento detenido por comando de parada')
            acknowledge(command_id, 'succeeded')
        elif name == 'tenstar.calibration.reset':
            if payload:
                raise ValueError('El reset de calibracion no recibe payload')
            with motor_lock:
                if motor.moving:
                    raise ValueError('Deten el motor antes de reiniciar la calibracion')
                calibration.update({'closed_marked': False, 'open_marked': False, 'calibrated': False, 'open_span_pulses': 0, 'open_direction': 1})
                position_valid = False
                motor.zero()
                motor.target_position = None
                save_calibration()
            acknowledge(command_id, 'succeeded')
        elif name == 'tenstar.calibration.setClosed':
            if payload:
                raise ValueError('Marcar cerrado no recibe payload')
            with motor_lock:
                if motor.moving:
                    raise ValueError('Deten el motor antes de marcar el extremo cerrado')
                motor.zero()
                motor.target_position = 0
                position_valid = True
                calibration['closed_marked'] = True
                calibration['open_marked'] = False
                calibration['calibrated'] = False
                calibration['open_span_pulses'] = 0
                calibration['open_direction'] = 1
                save_calibration()
            acknowledge(command_id, 'succeeded')
        elif name == 'tenstar.calibration.referenceClosed':
            if payload:
                raise ValueError('Referenciar cerrado no recibe payload')
            with motor_lock:
                if motor.moving:
                    raise ValueError('Deten el motor antes de referenciar el extremo cerrado')
                if not calibration['calibrated']:
                    raise ValueError('Completa primero la calibracion de ambos extremos')
                motor.zero()
                motor.target_position = 0
                position_valid = True
            acknowledge(command_id, 'succeeded')
        elif name == 'tenstar.calibration.setOpen':
            if payload:
                raise ValueError('Marcar abierto no recibe payload')
            with motor_lock:
                if motor.moving:
                    raise ValueError('Deten el motor antes de marcar el extremo abierto')
                if not calibration['closed_marked'] or not position_valid:
                    raise ValueError('Marca primero el extremo cerrado durante esta sesion')
                pulses = motor.snapshot()
                span = abs(pulses)
                if span < 100 or span > PULSES_PER_REVOLUTION * 20:
                    raise ValueError('Recorrido invalido: debe superar 100 pulsos y no exceder 20 vueltas')
                calibration['open_span_pulses'] = span
                calibration['open_direction'] = 1 if pulses > 0 else -1
                calibration['open_marked'] = True
                calibration['calibrated'] = True
                save_calibration()
            acknowledge(command_id, 'succeeded')
        elif name == 'tenstar.moveTurns':
            if set(payload) - {'turns', 'direction', 'speedPct'}:
                raise ValueError('Payload tenstar.moveTurns contiene campos desconocidos')
            turns = float(payload.get('turns'))
            direction = int(payload.get('direction'))
            speed = int(payload.get('speedPct', 70))
            if turns <= 0 or turns > 20 or direction not in (-1, 1) or speed < MINIMUM_SPEED_PCT or speed > 100:
                raise ValueError('turns: (0,20], direction: -1 o 1, speedPct: {}-100'.format(MINIMUM_SPEED_PCT))
            if not position_valid or not calibration['calibrated']:
                raise ValueError('Completa la calibracion de extremos y fija la referencia cerrada desde Cloud')
            with motor_lock:
                current = motor.snapshot()
                target = current + int(turns * PULSES_PER_REVOLUTION) * direction
                maximum = calibration['open_span_pulses']
                projected = target * calibration['open_direction']
                if projected < 0 or projected > maximum:
                    raise ValueError('El movimiento solicitado sale del recorrido calibrado')
                delta = target - current
                motor.move_turns(abs(delta) / float(PULSES_PER_REVOLUTION), 1 if delta > 0 else -1, speed)
                motor.target_position = round(projected / float(maximum) * 100)
                pending_motion_command = command_id
        elif name in ('curtain.open', 'curtain.close', 'curtain.move'):
            allowed = {'speedPct', 'speed', 'acceleration'} if name != 'curtain.move' else {'percent', 'speedPct', 'speed', 'acceleration', 'servoId', 'allServos'}
            if set(payload) - allowed:
                raise ValueError('Payload de cortina contiene campos no compatibles con Tenstar')
            if not position_valid or not calibration['calibrated']:
                raise ValueError('Completa la calibracion de extremos y fija la referencia cerrada desde Cloud')
            if name == 'curtain.open':
                percent = 100
            elif name == 'curtain.close':
                percent = 0
            else:
                percent = float(payload.get('percent'))
            if percent < 0 or percent > 100 or calibration['open_span_pulses'] <= 0:
                raise ValueError('percent debe estar entre 0 y 100 y la calibracion debe estar completa')
            current_pulses = motor.snapshot()
            target_pulses = int(round(percent * calibration['open_span_pulses'] / 100.0)) * calibration['open_direction']
            delta_pulses = target_pulses - current_pulses
            if abs(delta_pulses) <= 3:
                acknowledge(command_id, 'succeeded')
            else:
                turns = abs(delta_pulses) / float(PULSES_PER_REVOLUTION)
                direction = 1 if delta_pulses > 0 else -1
                configured_speed = payload.get('speedPct')
                if configured_speed is None:
                    configured_speed = round(float(payload.get('speed', 1260)) / 18.0)
                speed = int(configured_speed)
                if speed < MINIMUM_SPEED_PCT or speed > 100:
                    raise ValueError('speedPct fuera de rango')
                with motor_lock:
                    motor.move_turns(turns, direction, speed)
                    motor.target_position = percent
                    pending_motion_command = command_id
        elif name == 'tenstar.jog':
            if set(payload) - {'direction', 'speedPct', 'durationMs'}:
                raise ValueError('Payload tenstar.jog contiene campos desconocidos')
            direction = int(payload.get('direction'))
            speed = int(payload.get('speedPct', 35))
            duration_ms = int(payload.get('durationMs', 1000))
            if calibration['calibrated'] or not calibration['closed_marked'] or not position_valid:
                raise ValueError('El avance manual requiere una calibracion nueva, despues de marcar cerrado')
            if direction not in (-1, 1) or speed < MINIMUM_SPEED_PCT or speed > 35 or duration_ms < 100 or duration_ms > 750:
                raise ValueError('direction: -1 o 1, speedPct: {}-35, durationMs: 100-750'.format(MINIMUM_SPEED_PCT))
            with motor_lock:
                motor.jog(direction, speed, duration_ms)
                motor.target_position = None
                pending_motion_command = command_id
        elif name == 'firmware.update':
            if set(payload) - {'version', 'targetModel'}:
                raise ValueError('Payload firmware.update contiene campos desconocidos')
            version = str(payload.get('version', ''))
            target_model = str(payload.get('targetModel', FIRMWARE_TARGET)).lower()
            if not version or target_model not in (FIRMWARE_TARGET, 'todos los dispositivos'):
                raise ValueError('Version o modelo de firmware invalido para Tenstar')
            with motor_lock:
                if motor.moving:
                    raise ValueError('Deten el motor antes de actualizar el firmware')
            import pulsegrid_ota
            pulsegrid_ota.update(API_URL, DEVICE_CODE, DEVICE_ID, version, FIRMWARE_TARGET, FIRMWARE_FILES)
            acknowledge(command_id, 'succeeded')
            restart_requested = True
        else:
            raise ValueError('Comando no compatible con Tenstar: ' + str(name))
    except Exception as error:
        acknowledge(command_id, 'failed', error)


def poll_command():
    if not COMMANDS_ENABLED or motor.moving:
        return
    result = request('GET', '/api/device-commands?deviceId={}'.format(DEVICE_ID))
    command = result.get('command') if result else None
    if command:
        execute(command)


def connect_wifi():
    try:
        wlan.active(True)
        if wlan.isconnected():
            return True
        wlan.connect(WIFI_SSID, WIFI_PASSWORD)
    except Exception as error:
        print('Wi-Fi:', error)
        return False
    started = time.ticks_ms()
    while not wlan.isconnected() and time.ticks_diff(time.ticks_ms(), started) < 15000:
        time.sleep_ms(250)
    return wlan.isconnected()


def network_loop():
    global last_poll, last_telemetry, next_wifi_retry
    while True:
        now = time.ticks_ms()
        try:
            if not wlan.isconnected():
                if time.ticks_diff(now, next_wifi_retry) >= 0:
                    connect_wifi()
                    next_wifi_retry = time.ticks_add(time.ticks_ms(), 10000)
                time.sleep_ms(100)
                continue
            while ack_queue:
                with motor_lock:
                    command_id, status, error = ack_queue[0]
                if acknowledge(command_id, status, error):
                    with motor_lock:
                        if ack_queue and ack_queue[0][0] == command_id:
                            ack_queue.pop(0)
                else:
                    break
            with motor_lock:
                moving = motor.moving
            if moving and time.ticks_diff(now, last_poll) >= COMMAND_POLL_MS:
                result = request('GET', '/api/device-commands?deviceId={}&priorityOnly=1'.format(DEVICE_ID))
                command = result.get('command') if result else None
                if command:
                    execute(command)
                last_poll = time.ticks_ms()
            elif not moving and time.ticks_diff(now, last_poll) >= COMMAND_POLL_MS:
                poll_command()
                last_poll = time.ticks_ms()
            if restart_requested:
                time.sleep_ms(250)
                machine.reset()
            if time.ticks_diff(now, last_telemetry) >= TELEMETRY_MS:
                send_telemetry()
                last_telemetry = time.ticks_ms()
        except Exception as error:
            print('Pulsegrid worker:', error)
        time.sleep_ms(50)


def main():
    global pending_motion_command, position_valid
    if not WIFI_SSID:
        raise RuntimeError('El quemador debe generar config.py con la red Wi-Fi')
    load_calibration()
    try:
        import ota_boot
        ota_boot.confirm()
    except ImportError:
        ota_boot = None
    if not connect_wifi():
        print('No se pudo conectar a Wi-Fi; reinicia o vuelve a cargar config.py desde el quemador')
    print('Tenstar Pulsegrid iniciado · {} · firmware {}'.format(DEVICE_ID, FIRMWARE_VERSION))
    _thread.start_new_thread(network_loop, ())
    while True:
        try:
            if ota_boot:
                ota_boot.feed()
            with motor_lock:
                completed = motor.update()
                if completed is True and pending_motion_command is not None:
                    ack_queue.append((pending_motion_command, 'succeeded', None))
                    pending_motion_command = None
        except Exception as error:
            with motor_lock:
                motor.stop()
                failed_command = pending_motion_command
                pending_motion_command = None
            if failed_command is not None:
                with motor_lock:
                    ack_queue.append((failed_command, 'failed', str(error)))
        time.sleep_ms(10)


main()
