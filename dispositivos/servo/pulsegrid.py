import json
import time
import gc
import os

try:
    import urequests
except ImportError:
    urequests = None

try:
    from pulsegrid_config import API_URL, API_KEY, DEVICE_ID
except ImportError:
    API_URL = ""
    API_KEY = ""
    DEVICE_ID = ""

try:
    from pulsegrid_config import COMMANDS_ENABLED
except ImportError:
    COMMANDS_ENABLED = False

try:
    from pulsegrid_config import TELEMETRY_PATH
except ImportError:
    TELEMETRY_PATH = "/api/telemetry"

try:
    from pulsegrid_config import COMMANDS_PATH
except ImportError:
    COMMANDS_PATH = "/api/device-commands"

REPORT_INTERVAL_MS = 2000  # cloud state refresh cadence
COMMAND_INTERVAL_MS = 1000
_last_report = None
_last_command_check = 0
_next_network_attempt = 0
NETWORK_RETRY_MS = 30000
PENDING_ACK_FILE = "pulsegrid_command_state.py"
CONFIG_FILE = "pulsegrid_config.py"
FIRMWARE_PATH = "/api/firmware"
FIRMWARE_FILES = ("main.py", "pulsegrid.py", "webserver.py", "cortina.py", "stservo.py", "ssd1306.py")
_pending_configuration = None
if API_URL.startswith("http://"):
    FIRMWARE_PATH = "/api/relay/firmware"


def _configured():
    return bool(urequests and API_URL and API_KEY and DEVICE_ID)


def configure(api_url, api_key, device_id, commands_enabled=False):
    api_url = str(api_url or '').strip().rstrip('/')
    api_key = str(api_key or '').strip()
    device_id = str(device_id or '').strip()
    if not api_url or not api_key or not device_id:
        raise ValueError('URL, API key y device ID son obligatorios')
    using_local_relay = api_url.startswith('http://')
    telemetry_path = '/api/relay/telemetry' if using_local_relay else '/api/telemetry'
    commands_path = '/api/relay/device-commands' if using_local_relay else '/api/device-commands'
    firmware_path = '/api/relay/firmware' if using_local_relay else '/api/firmware'
    _save_configuration(api_url, api_key, device_id, telemetry_path, commands_path, commands_enabled)
    _apply_configuration(api_url, api_key, device_id, commands_enabled, telemetry_path, commands_path, firmware_path)
    return {'apiUrl': API_URL, 'telemetryPath': TELEMETRY_PATH, 'commandsPath': COMMANDS_PATH, 'deviceId': DEVICE_ID, 'commandsEnabled': COMMANDS_ENABLED}


def _save_configuration(api_url, api_key, device_id, telemetry_path, commands_path, commands_enabled):
    content = ('API_URL = {!r}\n'
               'API_KEY = {!r}\n'
               'DEVICE_ID = {!r}\n'
               'TELEMETRY_PATH = {!r}\n'
               'COMMANDS_PATH = {!r}\n'
               'COMMANDS_ENABLED = {!r}\n').format(api_url, api_key, device_id, telemetry_path, commands_path, bool(commands_enabled))
    temporary_file = CONFIG_FILE + '.tmp'
    with open(temporary_file, 'w') as config_file:
        config_file.write(content)
    try:
        os.remove(CONFIG_FILE)
    except OSError:
        pass
    os.rename(temporary_file, CONFIG_FILE)


def _apply_configuration(api_url, api_key, device_id, commands_enabled, telemetry_path, commands_path, firmware_path):
    global API_URL, API_KEY, DEVICE_ID, COMMANDS_ENABLED, TELEMETRY_PATH, COMMANDS_PATH, FIRMWARE_PATH
    API_URL = api_url
    API_KEY = api_key
    DEVICE_ID = device_id
    TELEMETRY_PATH = telemetry_path
    COMMANDS_PATH = commands_path
    COMMANDS_ENABLED = bool(commands_enabled)
    FIRMWARE_PATH = firmware_path


def _headers():
    return {"Content-Type": "application/json", "X-API-Key": API_KEY}


def _status(cortina):
    servos = {}
    for servo_id in cortina.servo_ids:
        values = cortina.multiturn_status(servo_id)
        values["position"] = cortina.position(servo_id)
        servos[str(servo_id)] = values
    try:
        from pulsegrid_firmware import VERSION as firmware_version
    except (ImportError, AttributeError):
        firmware_version = "unversioned"
    return {"deviceId": DEVICE_ID, "kind": "curtain", "online": True, "firmwareVersion": firmware_version, "servos": servos}


def _post(path, body):
    gc.collect()
    response = None
    try:
        response = urequests.post(API_URL.rstrip("/") + path, headers=_headers(), data=json.dumps(body))
        status_code = response.status_code
        if status_code < 200 or status_code >= 300:
            raise ValueError("HTTP {} en {}".format(status_code, path))
        return status_code
    finally:
        if response:
            response.close()
        gc.collect()


def _get(path):
    gc.collect()
    response = None
    try:
        response = urequests.get(API_URL.rstrip("/") + path, headers={"X-API-Key": API_KEY})
        result = response.json()
        if response.status_code < 200 or response.status_code >= 300:
            raise ValueError("HTTP {}: {}".format(response.status_code, result.get("error", "Solicitud rechazada")))
        return result
    finally:
        if response:
            response.close()
        gc.collect()


def _get_text(path):
    gc.collect()
    response = None
    try:
        response = urequests.get(API_URL.rstrip("/") + path, headers={"X-API-Key": API_KEY})
        return response.text
    finally:
        if response:
            response.close()
        gc.collect()


def _download_firmware_file(version, name, expected_hash):
    import uhashlib
    gc.collect()
    response = None
    temporary_name = name + ".ota"
    try:
        response = urequests.get(API_URL.rstrip("/") + FIRMWARE_PATH + "/files/" + str(version) + "/" + name, headers={"X-API-Key": API_KEY})
        if response.status_code != 200:
            raise ValueError("Descarga HTTP {} para {}".format(response.status_code, name))
        digest = uhashlib.sha256()
        with open(temporary_name, "wb") as firmware_file:
            while True:
                chunk = response.raw.read(512)
                if not chunk:
                    break
                firmware_file.write(chunk)
                digest.update(chunk)
        actual_hash = "".join("{:02x}".format(value) for value in digest.digest())
        if actual_hash != expected_hash:
            raise ValueError("Hash invalido para " + name)
        return temporary_name
    except Exception:
        try:
            os.remove(temporary_name)
        except OSError:
            pass
        raise
    finally:
        if response:
            response.close()
        gc.collect()


def _update_firmware(version):
    manifest = _get(FIRMWARE_PATH + "/manifest?version=" + str(version))
    if manifest.get("version") != version:
        raise ValueError("Version de firmware no coincide")
    downloads = []
    for file_info in manifest.get("files", []):
        name = str(file_info.get("name", ""))
        if name not in FIRMWARE_FILES:
            raise ValueError("Archivo de firmware invalido")
        downloads.append((name, _download_firmware_file(version, name, file_info.get("sha256"))))
    for name, temporary_name in downloads:
        try:
            os.remove(name)
        except OSError:
            pass
        os.rename(temporary_name, name)
    with open("pulsegrid_firmware.py", "w") as version_file:
        version_file.write("VERSION = {!r}\n".format(version))


def _number(payload, key, default=None):
    value = payload.get(key, default)
    if isinstance(value, bool):
        raise ValueError("{} invalido".format(key))
    return value


def _load_pending_ack():
    try:
        from pulsegrid_command_state import PENDING_ACK
        return PENDING_ACK
    except (ImportError, AttributeError):
        return None


def _save_pending_ack(command_id, status, error=None):
    with open(PENDING_ACK_FILE + ".tmp", "w") as state_file:
        state_file.write("PENDING_ACK = {!r}\n".format({"id": command_id, "status": status, "error": error}))
    _clear_pending_ack()
    os.rename(PENDING_ACK_FILE + ".tmp", PENDING_ACK_FILE)


def _clear_pending_ack():
    try:
        os.remove(PENDING_ACK_FILE)
    except OSError:
        pass


def _acknowledge(command_id, status, error=None):
    payload = {"deviceId": DEVICE_ID, "status": status}
    if error:
        payload["error"] = str(error)[:500]
    response_status = _post(COMMANDS_PATH + "/{}/ack".format(command_id), payload)
    if 200 <= response_status < 300:
        _clear_pending_ack()
        return True
    return False


def _execute(cortina, command):
    global _pending_configuration
    name = command["name"]
    payload = command.get("payload") or {}
    if name == "device.configure":
        api_url = str(payload.get("apiUrl", "")).strip().rstrip("/")
        api_key = str(payload.get("apiKey", "")).strip()
        device_id = str(payload.get("deviceId", "")).strip()
        if not api_url or not api_key or not device_id:
            raise ValueError("API URL, API key y device ID son obligatorios")
        using_local_relay = api_url.startswith("http://")
        telemetry_path = "/api/relay/telemetry" if using_local_relay else "/api/telemetry"
        commands_path = "/api/relay/device-commands" if using_local_relay else "/api/device-commands"
        firmware_path = "/api/relay/firmware" if using_local_relay else "/api/firmware"
        _save_configuration(api_url, api_key, device_id, telemetry_path, commands_path, COMMANDS_ENABLED)
        _pending_configuration = (api_url, api_key, device_id, COMMANDS_ENABLED, telemetry_path, commands_path, firmware_path)
    elif name == "firmware.update":
        version = str(_number(payload, "version"))
        _update_firmware(version)
    elif name == "curtain.open":
        cortina.abrir(int(_number(payload, "speed", 800)), int(_number(payload, "acceleration", 50)))
    elif name == "curtain.close":
        cortina.cerrar(int(_number(payload, "speed", 800)), int(_number(payload, "acceleration", 50)))
    elif name == "curtain.stop":
        cortina.parar()
    elif name == "curtain.move":
        servo_id = int(_number(payload, "servoId", 1))
        percent = float(_number(payload, "percent"))
        speed = int(_number(payload, "speed", 800))
        acceleration = int(_number(payload, "acceleration", 50))
        cortina.move_blind(servo_id, percent, speed, acceleration)
    elif name == "servo.configure":
        servo_id = int(_number(payload, "servoId", 1))
        min_angle = int(_number(payload, "min", 300))
        max_angle = int(_number(payload, "max", 3700))
        mode = int(_number(payload, "mode", 0))
        torque_limit = int(_number(payload, "torqueLimit", 1000))
        cortina.configure_servo(servo_id, min_angle, max_angle, mode, torque_limit)
    elif name == "blind.configure":
        servo_id = int(_number(payload, "servoId", 1))
        rolled_turns = float(_number(payload, "rolledTurns", 0))
        unrolled_turns = float(_number(payload, "unrolledTurns", 10))
        cortina.configure_blind(servo_id, rolled_turns, unrolled_turns)
    elif name == "blind.markRolled":
        cortina.mark_blind_reference(int(_number(payload, "servoId", 1)), "rolled")
    elif name == "blind.markDeployed":
        cortina.mark_blind_reference(int(_number(payload, "servoId", 1)), "deployed")
    elif name == "blind.setMotorSide":
        cortina.set_motor_side(int(_number(payload, "servoId", 1)), str(payload.get("side", "")))
    elif name == "blind.beginCalibration":
        cortina.begin_blind_calibration(int(_number(payload, "servoId", 1)))
    elif name == "blind.jog":
        cortina.jog_blind(
            int(_number(payload, "servoId", 1)),
            str(payload.get("direction", "deployed")),
            int(_number(payload, "speed", 800)),
            int(_number(payload, "acceleration", 50)),
        )
    elif name == "motion.configure":
        speed = int(_number(payload, "speed", 800))
        acceleration = int(_number(payload, "acceleration", 50))
        cortina.configure_motion(speed, acceleration)
    elif name == "servo.torque":
        servo_id = int(_number(payload, "servoId", 1))
        enabled = payload.get("enabled")
        if not isinstance(enabled, bool):
            raise ValueError("enabled debe ser booleano")
        cortina.torque_servo(servo_id, enabled)
    elif name == "servo.resetTurns":
        cortina.reset_absolute_turns(int(_number(payload, "servoId", 1)))
    else:
        raise ValueError("comando no permitido: {}".format(name))


def _report_status(cortina):
    global _last_report
    _post(TELEMETRY_PATH, _status(cortina))
    _last_report = time.ticks_ms()


def sync(cortina):
    global _last_report, _last_command_check, _pending_configuration, _next_network_attempt
    if not _configured():
        return
    now = time.ticks_ms()
    if time.ticks_diff(now, _next_network_attempt) < 0:
        return
    if _last_report is None or time.ticks_diff(now, _last_report) >= REPORT_INTERVAL_MS:
        try:
            _report_status(cortina)
        except Exception as error:
            print("Pulsegrid telemetria:", error)
    if not COMMANDS_ENABLED or time.ticks_diff(now, _last_command_check) < COMMAND_INTERVAL_MS:
        return
    _last_command_check = now
    try:
        result = _get(COMMANDS_PATH + "?deviceId=" + DEVICE_ID)
        command = result.get("command")
        if not command:
            return
        pending_ack = _load_pending_ack()
        if pending_ack and pending_ack.get("id") == command["id"]:
            _acknowledge(command["id"], pending_ack.get("status", "failed"), pending_ack.get("error"))
            return
        try:
            _execute(cortina, command)
            status = "succeeded"
            error_message = None
        except Exception as error:
            print("Pulsegrid comando:", error)
            status = "failed"
            error_message = "{}: {}".format(type(error).__name__, error)
        _save_pending_ack(command["id"], status, error_message)
        acknowledged = _acknowledge(command["id"], status, error_message)
        if acknowledged and status == "succeeded" and _pending_configuration:
            _apply_configuration(*_pending_configuration)
            _pending_configuration = None
        if acknowledged and status == "succeeded" and command.get("name") == "firmware.update":
            import machine
            machine.reset()
        try:
            _report_status(cortina)
        except Exception as error:
            print("Pulsegrid estado:", error)
    except Exception as error:
        print("Pulsegrid comandos:", error)
        _next_network_attempt = time.ticks_add(time.ticks_ms(), NETWORK_RETRY_MS)