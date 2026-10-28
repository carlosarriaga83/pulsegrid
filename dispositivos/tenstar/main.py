import gc
import json
import machine
import network
import time
import _thread

from tenstar_motor import TenstarMotor
import board_led
import captive_portal
import wifi_recovery
import tenstar_http
import tenstar_calibration
import tenstar_state

captive_portal.recover_config_file()

try:
    import config
    WIFI_SSID = getattr(config, 'WIFI_SSID', '')
    WIFI_PASSWORD = getattr(config, 'WIFI_PASSWORD', '')
    API_URL = getattr(config, 'API_URL', 'https://pulse.2api2.com')
    DEVICE_CODE = getattr(config, 'DEVICE_CODE', '')
    DEVICE_ID = getattr(config, 'DEVICE_ID', '')
    PULSES_PER_REVOLUTION = getattr(config, 'PULSES_PER_REVOLUTION', 11880)
    KP = getattr(config, 'KP', 0.3)
    MINIMUM_SPEED_PCT = getattr(config, 'MINIMUM_SPEED_PCT', 20)
    COMMANDS_ENABLED = getattr(config, 'COMMANDS_ENABLED', True)
    LED_PIN = getattr(config, 'LED_PIN', 8)
    LED_ACTIVE_LOW = getattr(config, 'LED_ACTIVE_LOW', True)
except ImportError:
    WIFI_SSID = WIFI_PASSWORD = DEVICE_CODE = DEVICE_ID = ''
    API_URL = 'https://pulse.2api2.com'
    PULSES_PER_REVOLUTION = 11880
    KP = 0.3
    MINIMUM_SPEED_PCT = 90
    COMMANDS_ENABLED = True
    LED_PIN = 8
    LED_ACTIVE_LOW = True

FIRMWARE_TARGET = 'tenstar'
FIRMWARE_VERSION = '2026.10.26.tenstar-r10'
try:
    from pulsegrid_firmware import VERSION as FIRMWARE_VERSION
except (ImportError, AttributeError):
    pass
FIRMWARE_FILES = ('boot.py', 'main.py', 'tenstar_motor.py', 'ota_boot.py', 'pulsegrid_ota.py', 'board_led.py', 'captive_portal.py', 'wifi_recovery.py', 'tenstar_http.py', 'tenstar_calibration.py', 'tenstar_state.py', 'tenstar_loop.py')
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
wifi_connect_started = None
wifi_was_connected = False
cloud_last_success = None
cloud_error = None
cloud_requests_ok = 0
cloud_requests_failed = 0
cloud_report_at = time.ticks_ms()
recovery_mode = False
worker_started = False
boot_started_at = time.ticks_ms()
pending_motion_command = None
ack_queue = []
position_valid = False
restart_requested = False
calibration = tenstar_calibration.empty()


def load_calibration():
    global calibration, position_valid
    calibration = tenstar_calibration.empty()
    position_valid = False
    saved, trusted = tenstar_state.load(CALIBRATION_FILE)
    if saved is None and not tenstar_state.exists(CALIBRATION_FILE + '.1'):
        if tenstar_state.exists(CALIBRATION_FILE):
            try:
                with open(CALIBRATION_FILE, 'r') as state_file:
                    saved = json.loads(state_file.read())
            except (OSError, ValueError) as error:
                print('Tenstar: calibracion anterior ilegible:', error)
    if saved is None:
        print('Tenstar: sin estado persistente valido')
        return
    try:
        if isinstance(saved, dict):
            board_led.set_enabled(saved.get('led_enabled', True) is True)
            span = int(saved.get('open_span_pulses', 0))
            direction = int(saved.get('open_direction', 1))
            valid = bool(saved.get('calibrated')) and bool(saved.get('closed_marked')) and bool(saved.get('open_marked')) and 100 <= span <= PULSES_PER_REVOLUTION * 20 and direction in (-1, 1)
            calibration = tenstar_calibration.empty()
            if valid:
                calibration.update({'closed_marked': True, 'open_marked': True, 'calibrated': True,
                                    'open_span_pulses': span, 'open_direction': direction,
                                    'close_direction': -direction, 'direction_confirmed': True})
                pulses = saved.get('position_pulses')
                if trusted and saved.get('position_valid') is True and isinstance(pulses, int) and -3 <= pulses * direction <= span + 3:
                    motor.set_position(pulses)
                    motor.target_position = round(max(0, min(span, pulses * direction)) * 100 / span)
                    position_valid = True
                print('Tenstar: recorrido restaurado; referencia', position_valid)
    except (ValueError, TypeError) as error:
        print('Tenstar: calibracion guardada invalida:', error)


def save_calibration():
    saved = dict(calibration)
    saved.update({'position_pulses': motor.snapshot(), 'position_valid': position_valid,
                  'led_enabled': board_led.is_enabled()})
    tenstar_state.save(CALIBRATION_FILE, saved)


def prepare_motion():
    tenstar_state.mark_moving(CALIBRATION_FILE)


def cloud_online():
    return wlan.isconnected() and cloud_last_success is not None and time.ticks_diff(time.ticks_ms(), cloud_last_success) < 15000


def request(method, path, payload=None):
    global next_request_at, cloud_last_success, cloud_error
    global cloud_requests_ok, cloud_requests_failed, cloud_report_at
    if motor.moving:
        raise RuntimeError('HTTPS suspendido durante movimiento para no perder pulsos del encoder')
    now = time.ticks_ms()
    if next_request_at and time.ticks_diff(now, next_request_at) < 0:
        return None
    try:
        if not DEVICE_CODE or not DEVICE_ID:
            raise ValueError('Falta DEVICE_CODE o DEVICE_ID; generar identidad con Quemador y registrar en Cloud')
        gc.collect()
        result = tenstar_http.request(API_URL, DEVICE_CODE, method, path, payload, REQUEST_TIMEOUT)
        cloud_requests_ok += 1
        if cloud_last_success is None or cloud_error:
            print('Cloud conectado: {} · {}'.format(DEVICE_ID, API_URL))
        cloud_last_success = time.ticks_ms()
        cloud_error = None
        next_request_at = 0
        if time.ticks_diff(cloud_last_success, cloud_report_at) >= 60000:
            print('Cloud diagnostico: {} solicitudes OK, {} fallos'.format(cloud_requests_ok, cloud_requests_failed))
            cloud_report_at = cloud_last_success
        return result
    except Exception as error:
        cloud_requests_failed += 1
        cloud_last_success = None
        cloud_error = str(error)
        print('Cloud {} {} fallo en {}'.format(method, path.split('?', 1)[0], cloud_error))
        next_request_at = time.ticks_add(time.ticks_ms(), RETRY_MS)
        return None


def acknowledge(command_id, status, error=None):
    payload = {'deviceId': DEVICE_ID, 'status': status}
    if error:
        payload['error'] = str(error)[:500]
    result = request('POST', '/api/device-commands/{}/ack'.format(command_id), payload)
    return bool(result and result.get('ok'))


def queue_ack(command_id, status, error=None):
    ack_queue.append((command_id, status, str(error) if error is not None else None))


def send_telemetry():
    pulses = motor.snapshot()
    span = calibration['open_span_pulses']
    position = max(0, min(100, round((pulses * calibration['open_direction'] / float(span)) * 100))) if span > 0 else None
    return request('POST', '/api/telemetry', {
        'deviceId': DEVICE_ID,
        'kind': 'curtain',
        'firmwareTarget': FIRMWARE_TARGET,
        'firmwareVersion': FIRMWARE_VERSION,
        'calibrationMode': 'open-first-v1',
        'networkDuringMotion': False,
        'remoteStopDuringMotion': False,
        'ledEnabled': board_led.is_enabled(),
        'referenceRecoveryRequired': calibration['calibrated'] and not position_valid,
        'atClosed': calibration['calibrated'] and position_valid and abs(pulses) <= 3,
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
    global pending_motion_command, position_valid, restart_requested, last_telemetry
    name = command.get('name')
    payload = command.get('payload') or {}
    command_id = command.get('id')
    # print the command variables for debugging
    print("Executing command:", command)
    print("Command name:", name)
    print("Command payload:", payload)
    print("Command ID:", command_id)
    try:
        if command_id is None:
            raise ValueError('El comando cloud no tiene ID')
        if name == 'led.configure':
            if not isinstance(payload, dict) or set(payload) != {'enabled'} or not isinstance(payload['enabled'], bool):
                raise ValueError('enabled debe ser booleano')
            if motor.moving:
                raise ValueError('Espera a que termine el movimiento')
            previous = board_led.is_enabled()
            board_led.set_enabled(payload['enabled'])
            try:
                save_calibration()
            except OSError:
                board_led.set_enabled(previous)
                raise
            last_telemetry = 0
            queue_ack(command_id, 'succeeded')
        elif name in ('tenstar.stop', 'curtain.stop'):
            if payload:
                raise ValueError('El comando stop no recibe payload')
            with motor_lock:
                motor.stop()
                interrupted = pending_motion_command
                pending_motion_command = None
                save_calibration()
            if interrupted is not None:
                queue_ack(interrupted, 'failed', 'Movimiento detenido por comando de parada')
            last_telemetry = 0
            queue_ack(command_id, 'succeeded')
        elif str(name).startswith('tenstar.calibration.'):
            with motor_lock:
                position_valid = tenstar_calibration.handle(name, payload, motor, calibration, PULSES_PER_REVOLUTION, MINIMUM_SPEED_PCT, position_valid, prepare_motion)
                started_motion = motor.moving
                if started_motion:
                    pending_motion_command = command_id
                else:
                    try:
                        save_calibration()
                    except OSError:
                        position_valid = False
                        calibration['active'] = False
                        raise
                last_telemetry = 0
            if not started_motion:
                queue_ack(command_id, 'succeeded')
        elif name == 'tenstar.moveTurns':
            if set(payload) - {'turns', 'direction', 'speedPct'}:
                raise ValueError('Payload tenstar.moveTurns contiene campos desconocidos')
            turns = float(payload.get('turns'))
            direction = int(payload.get('direction'))
            speed = int(payload.get('speedPct', 40))
            if not 0 < turns <= 20 or direction not in (-1, 1) or speed < MINIMUM_SPEED_PCT or speed > 100:
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
                prepare_motion()
                motor.move_turns(abs(delta) / float(PULSES_PER_REVOLUTION), 1 if delta > 0 else -1, speed)
                motor.target_position = round(projected / float(maximum) * 100)
                pending_motion_command = command_id
        elif name in ('curtain.open', 'curtain.close', 'curtain.move'):
            allowed = {'speedPct', 'speed', 'acceleration'} if name != 'curtain.move' else {'percent', 'speedPct', 'speed', 'acceleration', 'servoId', 'allServos'}
            if set(payload) - allowed:
                raise ValueError('Payload de cortina contiene campos no compatibles con Tenstar')
            if not position_valid or not calibration['calibrated']:
                raise ValueError('Completa la calibracion de extremos y fija la referencia cerrada desde Cloud')
            if name == 'curtain.close' and abs(motor.snapshot()) <= 3:
                raise ValueError('La cortina ya esta completamente cerrada; usa abrir o mover')
            if name == 'curtain.open':
                percent = 100
            elif name == 'curtain.close':
                percent = 0
            else:
                percent = float(payload.get('percent'))
            if not 0 <= percent <= 100 or calibration['open_span_pulses'] <= 0:
                raise ValueError('percent debe estar entre 0 y 100 y la calibracion debe estar completa')
            current_pulses = motor.snapshot()
            target_pulses = int(round(percent * calibration['open_span_pulses'] / 100.0)) * calibration['open_direction']
            delta_pulses = target_pulses - current_pulses
            if abs(delta_pulses) <= 3:
                queue_ack(command_id, 'succeeded')
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
                    prepare_motion()
                    motor.move_turns(turns, direction, speed)
                    motor.target_position = percent
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
            queue_ack(command_id, 'succeeded')
            restart_requested = True
        else:
            raise ValueError('Comando no compatible con Tenstar: ' + str(name))
    except Exception as error:
        queue_ack(command_id, 'failed', error)


def poll_command():
    if not COMMANDS_ENABLED or motor.moving:
        return
    result = request('GET', '/api/device-commands?deviceId={}'.format(DEVICE_ID))
    command = result.get('command') if result else None
    if command:
        execute(command)


def connect_wifi():
    global wifi_connect_started, wifi_was_connected, next_wifi_retry, cloud_last_success
    now = time.ticks_ms()
    try:
        if wlan.isconnected():
            if not wifi_was_connected:
                print('Wi-Fi conectado: IP {}'.format(wlan.ifconfig()[0]))
            wifi_was_connected = True
            wifi_connect_started = None
            return True
        if wifi_was_connected:
            print('Wi-Fi desconectado; reintentando')
            cloud_last_success = None
            wifi_was_connected = False
        if recovery_mode or not WIFI_SSID:
            return False
        if wifi_connect_started is not None:
            if time.ticks_diff(now, wifi_connect_started) < 15000:
                return False
            print('Wi-Fi: conexion agotada, estado {}'.format(wlan.status()))
            wlan.disconnect()
            wifi_connect_started = None
            next_wifi_retry = time.ticks_add(now, 10000)
        elif not next_wifi_retry or time.ticks_diff(now, next_wifi_retry) >= 0:
            wlan.active(True)
            print('Wi-Fi: conectando a la red guardada')
            wlan.connect(WIFI_SSID, WIFI_PASSWORD)
            wifi_connect_started = now
    except Exception as error:
        print('Wi-Fi:', error)
        wifi_connect_started = None
        next_wifi_retry = time.ticks_add(now, 10000)
    return False


def start_network():
    global worker_started
    print('Tenstar: worker de red iniciado en hilo principal')
    try:
        portal = captive_portal.Portal(wlan, recovery_mode)
    except Exception as error:
        print('ERROR: no se pudo iniciar el portal Tenstar:', error)
        raise
    worker_started = True
    return portal


def network_step(portal):
    global last_poll, last_telemetry
    # TLS runs on the main thread, and never while the encoder is tracking motion.
    if motor.moving:
        return
    portal.poll(allow_save=not restart_requested)
    if not connect_wifi():
        return
    if last_telemetry == 0 or time.ticks_diff(time.ticks_ms(), last_telemetry) >= TELEMETRY_MS:
        if send_telemetry():
            last_telemetry = time.ticks_ms()
        else:
            return
    while ack_queue:
        command_id, status, error = ack_queue[0]
        if not acknowledge(command_id, status, error):
            return
        ack_queue.pop(0)
    if restart_requested:
        time.sleep_ms(250)
        machine.reset()
        return
    if time.ticks_diff(time.ticks_ms(), last_poll) >= COMMAND_POLL_MS:
        poll_command()
        last_poll = time.ticks_ms()


def main():
    import tenstar_loop
    tenstar_loop.run(globals())


if __name__ == '__main__':
    main()
