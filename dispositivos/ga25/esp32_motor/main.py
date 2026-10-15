import gc
import json
import time
import network
import os
import socket
from machine import Pin
from motor_curtain import CurtainMotor
import captive_portal

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
    from config import FULL_TRAVEL_MS, OPEN_A_LEVEL, DIRECTION_REVERSED
except ImportError:
    try:
        from config import WIFI_SSID, WIFI_PASSWORD, API_URL, API_KEY, DEVICE_ID, FULL_TRAVEL_MS, OPEN_A_LEVEL
    except ImportError:
        WIFI_SSID = WIFI_PASSWORD = API_URL = API_KEY = DEVICE_ID = ""
        FULL_TRAVEL_MS = 15000
        OPEN_A_LEVEL = 1
    DIRECTION_REVERSED = False

ENABLE_PIN = 16
DIRECTION_A_PIN = 18
DIRECTION_B_PIN = 33
STATUS_LED_PIN = 15
POLL_MS = 5000
TELEMETRY_MS = 5000
REQUEST_TIMEOUT = 5
RETRY_MS = 5000
next_request_at = 0
wifi_station = None
next_wifi_retry = 0
WIFI_RETRY_MS = 15000


class StatusLed:
    def __init__(self, pin=15):
        self.pin = pin
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

motor = CurtainMotor(ENABLE_PIN, DIRECTION_A_PIN, DIRECTION_B_PIN, FULL_TRAVEL_MS, OPEN_A_LEVEL, DIRECTION_REVERSED)
status_led = StatusLed(STATUS_LED_PIN)
last_poll = 0
last_telemetry = 0
last_presence = 0
pending_configuration = None
restart_requested = False
led_override = None
FIRMWARE_TARGET = "ga25"
FIRMWARE_FILES = ("main.py", "captive_portal.py", "motor_curtain.py", "boot.py", "ota_boot.py")

try:
    from pulsegrid_firmware import VERSION as FIRMWARE_VERSION
except (ImportError, AttributeError):
    FIRMWARE_VERSION = "unversioned"


def cloud_path(path):
    return path


def api_socket(timeout):
    secure = API_URL.startswith("https://")
    address = API_URL.split("://", 1)[-1].split("/", 1)[0]
    parts = address.split(":", 1)
    host = parts[0]
    port = int(parts[1]) if len(parts) > 1 else (443 if secure else 80)
    client = socket.socket()
    client.settimeout(timeout)
    client.connect((host, port))
    if secure:
        if tls is None:
            client.close()
            raise RuntimeError("TLS no disponible en este firmware")
        client = tls.wrap_socket(client, server_hostname=host)
    return client, host


def wifi_connect():
    global wifi_station
    if not WIFI_SSID:
        print("Configura firmware/esp32_motor/config.py antes de conectar")
        return False
    wlan = network.WLAN(network.STA_IF)
    wifi_station = wlan
    wlan.active(True)
    if not wlan.isconnected():
        print("Conectando WiFi...")
        wlan.connect(WIFI_SSID, WIFI_PASSWORD)
        deadline = time.ticks_add(time.ticks_ms(), 15000)
        while not wlan.isconnected() and time.ticks_diff(deadline, time.ticks_ms()) > 0:
            time.sleep_ms(250)
    if wlan.isconnected():
        print("WiFi:", wlan.ifconfig()[0])
        return True
    print("WiFi no disponible")
    return False


def headers():
    return {"Content-Type": "application/json", "X-API-Key": API_KEY}


def _unchunk(value):
    output = b""
    offset = 0
    while offset < len(value):
        end = value.find(b"\r\n", offset)
        if end < 0:
            break
        size = int(value[offset:end], 16)
        if size == 0:
            break
        start = end + 2
        output += value[start:start + size]
        offset = start + size + 2
    return output


def relay_request(method, path, body=None):
    client, host = api_socket(REQUEST_TIMEOUT)
    try:
        content = json.dumps(body) if body is not None else ""
        request = "{} {} HTTP/1.1\r\nHost: {}\r\nX-API-Key: {}\r\nConnection: close\r\n".format(method, path, host, API_KEY)
        if content:
            request += "Content-Type: application/json\r\nContent-Length: {}\r\n".format(len(content))
        client.send((request + "\r\n" + content).encode())
        result = b""
        while True:
            chunk = client.recv(512)
            if not chunk:
                break
            result += chunk
        separator = result.find(b"\r\n\r\n")
        status = int(result[9:12]) if len(result) >= 12 else 0
        if status < 200 or status >= 300:
            raise ValueError("HTTP {}".format(status))
        headers_end = separator if separator >= 0 else len(result)
        response_body = result[headers_end + 4:] if separator >= 0 else b""
        if b"transfer-encoding: chunked" in result[:headers_end].lower():
            response_body = _unchunk(response_body)
        return json.loads(response_body) if response_body else {}
    finally:
        client.close()
        gc.collect()


def request(method, path, body=None):
    global next_request_at
    if not API_URL or not API_KEY or time.ticks_diff(time.ticks_ms(), next_request_at) < 0:
        return None
    try:
        return relay_request(method, path, body)
    except Exception as error:
        error_text = str(error)
        if "MBEDTLS_ERR_SSL" in error_text or "SSL" in error_text:
            print("Pulsegrid TLS incompatible con el servidor: {}".format(error_text))
        else:
            print("Pulsegrid:", error_text)
        next_request_at = time.ticks_add(time.ticks_ms(), RETRY_MS)
        return None
    finally:
        gc.collect()


def send_presence():
    if not API_URL or not DEVICE_ID:
        return
    try:
        relay_request("POST", "/api/device-presence", {"deviceId": DEVICE_ID, "kind": "curtain", "firmwareTarget": FIRMWARE_TARGET, "firmwareVersion": FIRMWARE_VERSION, "apiKeyConfigured": bool(API_KEY)})
    except Exception as error:
        print("Pulsegrid presence:", error)


def acknowledge(command_id, status, error=None):
    body = {"deviceId": DEVICE_ID, "status": status}
    if error:
        body["error"] = str(error)[:500]
    request("POST", cloud_path("/api/device-commands/{}/ack".format(command_id)), body)


def save_configuration(values):
    content = ("WIFI_SSID = {!r}\nWIFI_PASSWORD = {!r}\nAPI_URL = {!r}\nAPI_KEY = {!r}\n"
               "DEVICE_ID = {!r}\nFULL_TRAVEL_MS = {}\nOPEN_A_LEVEL = {}\nDIRECTION_REVERSED = {!r}\n").format(
                   values["wifi_ssid"], values["wifi_password"], values["api_url"], values["api_key"],
                   values["device_id"], values["full_travel_ms"], values["open_a_level"], values["direction_reversed"])
    temporary = "config.py.tmp"
    with open(temporary, "w") as config_file:
        config_file.write(content)
    try:
        os.remove("config.py")
    except OSError:
        pass
    os.rename(temporary, "config.py")


def configure_from_command(payload):
    api_url = str(payload.get("apiUrl", "")).strip().rstrip("/")
    api_key = str(payload.get("apiKey", "")).strip() or API_KEY
    device_id = str(payload.get("deviceId", "")).strip()
    if not api_url or not api_key or not device_id:
        raise ValueError("API URL, API key y device ID son obligatorios")
    reversed_value = payload.get("reversed", DIRECTION_REVERSED)
    if isinstance(reversed_value, str):
        reversed_value = reversed_value.strip().lower() in ("1", "true", "yes", "on")
    elif not isinstance(reversed_value, bool):
        raise ValueError("reversed debe ser booleano")
    values = {"wifi_ssid": WIFI_SSID, "wifi_password": WIFI_PASSWORD, "api_url": api_url,
              "api_key": api_key, "device_id": device_id, "full_travel_ms": FULL_TRAVEL_MS,
              "open_a_level": OPEN_A_LEVEL, "direction_reversed": reversed_value}
    save_configuration(values)
    return values


def apply_configuration(values):
    global API_URL, API_KEY, DEVICE_ID, motor, DIRECTION_REVERSED
    API_URL = values["api_url"]
    API_KEY = values["api_key"]
    DEVICE_ID = values["device_id"]
    DIRECTION_REVERSED = values["direction_reversed"]
    motor = CurtainMotor(ENABLE_PIN, DIRECTION_A_PIN, DIRECTION_B_PIN, values["full_travel_ms"], values["open_a_level"], DIRECTION_REVERSED)


def _legacy_update_firmware(version):
    import uhashlib
    manifest = request("GET", cloud_path("/api/firmware/manifest?version={}&targetModel={}".format(version, FIRMWARE_TARGET)))
    if not manifest or manifest.get("version") != version or manifest.get("targetModel") not in (FIRMWARE_TARGET, "Todos los dispositivos"):
        raise ValueError("Version de firmware no coincide con GA25")
    downloads = []
    for file_info in manifest.get("files", []):
        name = str(file_info.get("name", ""))
        if name not in FIRMWARE_FILES:
            raise ValueError("Archivo de firmware invalido: " + name)
        temporary_name = name + ".ota"
        client = None
        try:
            path = cloud_path("/api/firmware/files/{}/{}?targetModel={}".format(version, name, FIRMWARE_TARGET))
            client, host = api_socket(REQUEST_TIMEOUT)
            client.send("GET {} HTTP/1.1\r\nHost: {}\r\nX-API-Key: {}\r\nConnection: close\r\n\r\n".format(path, host, API_KEY).encode())
            header = b""
            while b"\r\n\r\n" not in header:
                chunk = client.recv(256)
                if not chunk:
                    break
                header += chunk
                if len(header) > 2048:
                    raise ValueError("Encabezado HTTP demasiado grande")
            separator = header.find(b"\r\n\r\n")
            if separator < 0 or header[9:12] != b"200":
                raise ValueError("Descarga HTTP para " + name)
            digest = uhashlib.sha256()
            with open(temporary_name, "wb") as firmware_file:
                chunk = header[separator + 4:]
                while chunk:
                    firmware_file.write(chunk)
                    digest.update(chunk)
                    chunk = client.recv(512)
            actual_hash = "".join("{:02x}".format(value) for value in digest.digest())
            if actual_hash != file_info.get("sha256"):
                raise ValueError("Hash invalido para " + name)
            downloads.append((name, temporary_name))
        except Exception:
            try:
                os.remove(temporary_name)
            except OSError:
                pass
            raise
        finally:
            if client:
                client.close()
            gc.collect()
    for name, temporary_name in downloads:
        try:
            os.remove(name)
        except OSError:
            pass
        os.rename(temporary_name, name)
    with open("pulsegrid_firmware.py", "w") as version_file:
        version_file.write("VERSION = {!r}\n".format(version))
    return True


def update_firmware(version):
    import uhashlib
    try:
        import ota_boot
    except ImportError:
        return _legacy_update_firmware(version)
    try:
        from pulsegrid_firmware import VERSION
        if VERSION == version:
            print("OTA ya instalada:", version)
            return False
    except (ImportError, AttributeError):
        pass
    manifest = request("GET", cloud_path("/api/firmware/manifest?version={}&targetModel={}".format(version, FIRMWARE_TARGET)))
    if not manifest or manifest.get("version") != version or manifest.get("targetModel") not in (FIRMWARE_TARGET, "Todos los dispositivos"):
        raise ValueError("Version de firmware no coincide con GA25")
    files = manifest.get("files", [])
    if not files:
        raise ValueError("Manifest OTA vacio")
    total_bytes = sum(int(file_info.get("size", 0)) for file_info in files)
    ota_boot.begin(version, total_bytes)
    staged = []
    for file_info in files:
        name = str(file_info.get("name", ""))
        if name not in FIRMWARE_FILES:
            raise ValueError("Archivo de firmware invalido: " + name)
        temporary_name = ota_boot.stage_path(name)
        client = None
        try:
            path = cloud_path("/api/firmware/files/{}/{}?targetModel={}".format(version, name, FIRMWARE_TARGET))
            client, host = api_socket(REQUEST_TIMEOUT)
            client.send("GET {} HTTP/1.1\r\nHost: {}\r\nX-API-Key: {}\r\nConnection: close\r\n\r\n".format(path, host, API_KEY).encode())
            header = b""
            while b"\r\n\r\n" not in header:
                chunk = client.recv(256)
                if not chunk:
                    break
                header += chunk
                if len(header) > 2048:
                    raise ValueError("Encabezado HTTP demasiado grande")
            separator = header.find(b"\r\n\r\n")
            status_line = header[:header.find(b"\r\n")] if header else b""
            status_parts = status_line.split(b" ", 2)
            status_code = status_parts[1] if len(status_parts) > 1 else b"0"
            if separator < 0 or status_code != b"200":
                detail = header[separator + 4:separator + 164] if separator >= 0 else status_line
                raise ValueError("Descarga HTTP para {}: {} {}".format(name, status_code.decode(), detail.decode(errors="replace").strip()))
            response_body = header[separator + 4:]
            if b"transfer-encoding: chunked" in header[:separator].lower():
                raise ValueError("OTA requiere Content-Length")
            content_length = None
            for line in header[:separator].lower().split(b"\r\n"):
                if line.startswith(b"content-length:"):
                    content_length = int(line.split(b":", 1)[1].strip())
            expected_length = int(file_info.get("size", content_length or 0))
            if content_length is None or content_length != expected_length:
                raise ValueError("Tamano OTA no coincide para " + name)
            digest = uhashlib.sha256()
            received = 0
            with open(temporary_name, "wb") as firmware_file:
                while response_body:
                    chunk, response_body = response_body[:512], response_body[512:]
                    if received + len(chunk) > expected_length:
                        raise ValueError("Respuesta OTA excede el tamano declarado para " + name)
                    firmware_file.write(chunk)
                    digest.update(chunk)
                    received += len(chunk)
                while True:
                    chunk = client.recv(512)
                    if not chunk:
                        break
                    if received + len(chunk) > expected_length:
                        raise ValueError("Respuesta OTA excede el tamano declarado para " + name)
                    firmware_file.write(chunk)
                    digest.update(chunk)
                    received += len(chunk)
            if received != expected_length:
                raise ValueError("Descarga OTA incompleta para " + name)
            actual_hash = "".join("{:02x}".format(value) for value in digest.digest())
            if actual_hash != file_info.get("sha256"):
                raise ValueError("Hash invalido para " + name)
            staged.append(name)
        except Exception:
            try:
                os.remove(temporary_name)
            except OSError:
                pass
            raise
        finally:
            if client:
                client.close()
            gc.collect()
    version_stage = ota_boot.stage_path("pulsegrid_firmware.py")
    with open(version_stage, "w") as version_file:
        version_file.write("VERSION = {!r}\n".format(version))
    staged.append("pulsegrid_firmware.py")
    ota_boot.ready(version, staged)
    return True


def execute(command):
    global pending_configuration, restart_requested, led_override
    name = command.get("name") or command.get("command")
    payload = command.get("payload") or {}
    if name == "device.configure":
        pending_configuration = configure_from_command(payload)
    elif name == "led.configure":
        if not isinstance(payload.get("enabled"), bool):
            raise ValueError("enabled debe ser booleano")
        led_override = payload["enabled"]
    elif name == "direction.configure":
        if not isinstance(payload.get("reversed"), bool):
            raise ValueError("reversed debe ser booleano")
        pending_configuration = {"wifi_ssid": WIFI_SSID, "wifi_password": WIFI_PASSWORD, "api_url": API_URL,
                                 "api_key": API_KEY, "device_id": DEVICE_ID, "full_travel_ms": FULL_TRAVEL_MS,
                                 "open_a_level": OPEN_A_LEVEL, "direction_reversed": payload["reversed"]}
        save_configuration(pending_configuration)
    elif name == "curtain.open":
        motor.start(1, payload.get("speed", 70), 100)
    elif name == "curtain.close":
        motor.start(-1, payload.get("speed", 70), 0)
    elif name == "curtain.stop":
        motor.stop()
    elif name == "curtain.move":
        value = payload.get("position", payload.get("percent"))
        if value is None:
            raise ValueError("curtain.move requiere position o percent")
        motor.move_to(value, payload.get("speed", 70))
    elif name == "firmware.update":
        restart_requested = update_firmware(str(payload.get("version", "")))
    else:
        raise ValueError("Comando no soportado: {}".format(name))


def poll_commands():
    global pending_configuration, restart_requested
    result = request("GET", cloud_path("/api/device-commands?deviceId=" + DEVICE_ID))
    command = result.get("command") if result else None
    if not command:
        return
    try:
        execute(command)
        acknowledge(command.get("id"), "succeeded")
        if command.get("name") == "firmware.update":
            print("OTA completada; reiniciando")
            time.sleep_ms(250)
            import machine
            machine.reset()
            return
        if pending_configuration:
            apply_configuration(pending_configuration)
            pending_configuration = None
        if restart_requested:
            restart_requested = False
            import machine
            machine.reset()
        print("Comando ejecutado:", command.get("name"))
    except Exception as error:
        motor.stop()
        pending_configuration = None
        acknowledge(command.get("id"), "failed", error)
        print("Comando rechazado:", error)


def send_telemetry():
    state = motor.status()
    state["deviceId"] = DEVICE_ID
    state["kind"] = "curtain"
    state["firmwareTarget"] = FIRMWARE_TARGET
    state["ledEnabled"] = led_override if led_override is not None else bool(API_KEY)
    state["directionReversed"] = bool(motor.direction_reversed)
    try:
        from pulsegrid_firmware import VERSION
        state["firmwareVersion"] = VERSION
    except (ImportError, AttributeError):
        state["firmwareVersion"] = "unversioned"
    request("POST", cloud_path("/api/telemetry"), state)


def main():
    motor.stop()
    status_led.set(False)
    print("Pulsegrid GA25YN370 listo; firmware {}; PWM GPIO16, direccion GPIO18/GPIO33".format(FIRMWARE_VERSION))
    captive_portal.start_background(motor)
    if ota_boot:
        ota_boot.confirm()
    if not WIFI_SSID:
        print("Portal de configuracion: LED parpadeando 1 Hz")
    if not wifi_connect():
        print("Wi-Fi no disponible: el portal continua activo; LED parpadeando 1 Hz")
    else:
        if API_KEY:
            status_led.set(True)
            print("LED de estado: verde; Pulsegrid configurado")
        else:
            status_led.set((30, 25, 0))
            print("LED de estado: amarillo; esperando API key")
    global last_poll, last_telemetry, last_presence, next_wifi_retry
    while True:
        if ota_boot:
            ota_boot.feed()
        now = time.ticks_ms()
        motor.tick()
        connected = bool(wifi_station and wifi_station.isconnected())
        if connected:
            status_led.set(led_override if led_override is not None else (True if API_KEY else (30, 25, 0)))
        else:
            status_led.portal_tick()
            if time.ticks_diff(now, next_wifi_retry) >= 0:
                next_wifi_retry = time.ticks_add(now, WIFI_RETRY_MS)
                wifi_connect()
        if connected and time.ticks_diff(now, last_poll) >= POLL_MS:
            last_poll = now
            poll_commands()
        if connected and not API_KEY and time.ticks_diff(now, last_presence) >= 10000:
            last_presence = now
            send_presence()
        if connected and time.ticks_diff(now, last_telemetry) >= TELEMETRY_MS:
            last_telemetry = now
            send_telemetry()
        time.sleep_ms(50)


main()
