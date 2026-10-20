import socket
import time
import network
import machine
import os
import _thread

AP_IP = "192.168.4.1"
AP_SSID_PREFIX = "Pulsegrid-Cortina"
CONFIG_FILE = "config.py"
DEFAULT_API_URL = "https://pulse.2api2.com"
PORTAL_HOST = AP_IP
_portal_server = None
_portal_started = False


def _decode(value):
    value = value.replace("+", " ")
    result = ""
    index = 0
    while index < len(value):
        if value[index] == "%" and index + 2 < len(value):
            try:
                result += chr(int(value[index + 1:index + 3], 16))
                index += 3
                continue
            except ValueError:
                pass
        result += value[index]
        index += 1
    return result


def _form(body):
    values = {}
    for item in body.split("&"):
        if "=" in item:
            key, value = item.split("=", 1)
            values[_decode(key)] = _decode(value)
    return values


def _html(value):
    return str(value).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def _page(message=""):
    try:
        import config
        defaults = {
            "ssid": getattr(config, "WIFI_SSID", ""),
            "api_url": getattr(config, "API_URL", DEFAULT_API_URL) if str(getattr(config, "API_URL", "")).startswith("https://") else DEFAULT_API_URL,
            "device_code": getattr(config, "DEVICE_CODE", ""),
            "device_id": getattr(config, "DEVICE_ID", "cortina-ga25-01"),
            "travel": getattr(config, "FULL_TRAVEL_MS", 15000),
            "direction_reversed": getattr(config, "DIRECTION_REVERSED", False),
        }
    except ImportError:
        defaults = {"ssid": "", "api_url": DEFAULT_API_URL, "device_code": "", "device_id": "cortina-ga25-01", "travel": 15000, "direction_reversed": False}
    notice = "<p class=notice>{}</p>".format(_html(message)) if message else ""
    return """<!doctype html><html><meta name=viewport content='width=device-width'><title>Pulsegrid GA25 · Wi-Fi</title>
<style>:root{{color-scheme:light}}body{{font:15px sans-serif;max-width:520px;margin:0 auto;padding:20px 14px;background:#f3f7f7;color:#17212b}}header,main{{margin-top:14px;padding:18px 16px;background:white;border:1px solid #d8e1e3;border-radius:8px}}header{{background:#123844;color:white}}label{{display:block;margin:14px 0 5px;font-weight:700}}input{{box-sizing:border-box;width:100%;min-height:42px;padding:9px;border:1px solid #b9c7ca;border-radius:5px;font-size:16px}}button{{min-height:40px;padding:9px 14px;background:#087f8c;color:white;border:0;border-radius:5px;font-weight:bold;margin-top:12px}}.notice{{padding:10px;background:#e9f7e8;border-radius:5px}}.muted{{color:#526473;font-size:13px}}</style>
<header><h1>Configurar Wi-Fi</h1><p>Pulsegrid GA25 · {portal_host}</p></header><main>{notice}<p class=muted>Este portal local solo administra la conexión Wi-Fi. El motor y la identidad cloud se configuran desde Pulsegrid.</p>
<form method=post action=/save><label>Red Wi-Fi</label><input name=ssid required value='{ssid}'>
<label>Contraseña Wi-Fi</label><input name=password type=password value='' placeholder='En blanco conserva la actual' autocomplete=new-password>
<button type=submit>Guardar y reiniciar</button></form></main></html>""".format(notice=notice, portal_host=PORTAL_HOST, **defaults)


def _write_config(values):
    ssid = values.get("ssid", "").strip()
    try:
        import config as current
        password = values.get("password", "") or str(getattr(current, "WIFI_PASSWORD", ""))
        api_url = str(getattr(current, "API_URL", DEFAULT_API_URL)).strip().rstrip("/")
        device_code = str(getattr(current, "DEVICE_CODE", "")).strip()
        device_id = str(getattr(current, "DEVICE_ID", "cortina-ga25-01")).strip()
        travel = max(1000, int(getattr(current, "FULL_TRAVEL_MS", 15000)))
        direction_reversed = bool(getattr(current, "DIRECTION_REVERSED", False))
        open_a_level = int(getattr(current, "OPEN_A_LEVEL", 1))
    except (ImportError, ValueError):
        password = values.get("password", "")
        api_url, device_code, device_id, travel, direction_reversed, open_a_level = DEFAULT_API_URL, "", "cortina-ga25-01", 15000, False, 1
    if not ssid:
        raise ValueError("SSID es obligatorio")
    if not api_url.startswith("https://"):
        api_url = DEFAULT_API_URL
    temporary = CONFIG_FILE + ".tmp"
    backup = CONFIG_FILE + ".bak"
    with open(temporary, "w") as config:
        config.write("WIFI_SSID = {!r}\n".format(ssid))
        config.write("WIFI_PASSWORD = {!r}\n".format(password))
        config.write("API_URL = {!r}\n".format(api_url))
        config.write("DEVICE_CODE = {!r}\n".format(device_code))
        config.write("DEVICE_ID = {!r}\n".format(device_id))
        config.write("FULL_TRAVEL_MS = {}\nOPEN_A_LEVEL = {}\nDIRECTION_REVERSED = {!r}\n".format(travel, open_a_level, direction_reversed))
    try:
        os.remove(backup)
    except OSError:
        pass
    try:
        os.stat(CONFIG_FILE)
        config_exists = True
    except OSError:
        config_exists = False
    if config_exists:
        os.rename(CONFIG_FILE, backup)
    try:
        os.rename(temporary, CONFIG_FILE)
    except Exception:
        if config_exists:
            try:
                os.rename(backup, CONFIG_FILE)
            except OSError:
                pass
        raise
    try:
        os.remove(backup)
    except OSError:
        pass
    try:
        import wifi_recovery
        wifi_recovery.clear_boots()
    except ImportError:
        pass


def _dns_response(query):
    if len(query) < 12:
        return b""
    transaction = query[:2]
    question = query[12:]
    while len(question) and question[0] != 0:
        size = question[0]
        question = question[size + 1:]
    question = question[1:]
    question = question[:4]
    return transaction + b"\x81\x80\x00\x01\x00\x01\x00\x00\x00\x00" + question + b"\xc0\x0c\x00\x01\x00\x01\x00\x00\x00\x3c\x00\x04\xc0\xa8\x04\x01"


def _start_dns():
    dns = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    dns.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    dns.bind(("0.0.0.0", 53))
    dns.settimeout(0.2)
    return dns


def _send(client, body, status="200 OK"):
    response = "HTTP/1.1 {}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}".format(status, len(body), body)
    client.sendall(response.encode())


def _request_path(request):
    first_line = request.split("\r\n", 1)[0]
    parts = first_line.split(" ")
    return parts[1] if len(parts) > 1 else "/"


def run(motor=None, force_ap=False):
    global PORTAL_HOST, _portal_server, _portal_started
    if _portal_started:
        return
    _portal_started = True
    try:
        import config
        wifi_ssid = str(getattr(config, "WIFI_SSID", "")).strip()
    except ImportError:
        wifi_ssid = ""
    station = network.WLAN(network.STA_IF)
    try:
        if wifi_ssid and not force_ap:
            station.active(True)
        else:
            station.disconnect()
            station.active(False)
    except Exception as error:
        print("Wi-Fi STA no disponible: {}".format(error))
        wifi_ssid = ""
        try:
            station.disconnect()
        except Exception:
            pass
        try:
            station.active(False)
        except Exception:
            pass
    ap = network.WLAN(network.AP_IF)
    ap.active(False)
    dns = None
    portal_mode = None
    server = None
    for attempt in range(3):
        try:
            if _portal_server:
                try:
                    _portal_server.close()
                except Exception:
                    pass
            server = socket.socket()
            _portal_server = server
            server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            server.bind(("0.0.0.0", 80))
            server.listen(2)
            server.settimeout(0.2)
            break
        except Exception as error:
            print("Portal HTTP intento {} no pudo abrir el puerto 80: {}".format(attempt + 1, error))
            if server:
                try:
                    server.close()
                except Exception:
                    pass
            server = None
            _portal_server = None
            if attempt < 2:
                time.sleep_ms(250)
    if server is None:
        print("Portal HTTP no pudo abrir el puerto 80 después de 3 intentos")
        _portal_started = False
        return
    try:
        while True:
            connected = bool(not force_ap and wifi_ssid and station.active() and station.isconnected())
            if connected:
                if ap.active():
                    ap.active(False)
                if dns:
                    dns.close()
                    dns = None
                PORTAL_HOST = station.ifconfig()[0]
                if portal_mode != "station":
                    print("Portal de configuracion Wi-Fi: http://{}/".format(PORTAL_HOST))
                    portal_mode = "station"
            else:
                if not ap.active():
                    _enable_ap(ap)
                if dns is None:
                    dns = _start_dns()
                if portal_mode != "ap":
                    print("Portal Wi-Fi abierto: {} ({})".format(ap.config("essid"), AP_IP))
                    portal_mode = "ap"
                try:
                    data, address = dns.recvfrom(256)
                    dns.sendto(_dns_response(data), address)
                except OSError:
                    pass
            try:
                client, _ = server.accept()
            except OSError:
                continue
            client.settimeout(10)
            try:
                request_bytes = client.recv(4096)
                header_end = request_bytes.find(b"\r\n\r\n")
                while header_end < 0:
                    request_bytes += client.recv(4096)
                    header_end = request_bytes.find(b"\r\n\r\n")
                headers = request_bytes[:header_end].decode()
                body = request_bytes[header_end + 4:]
                content_length = 0
                for header in headers.split("\r\n")[1:]:
                    if header.lower().startswith("content-length:"):
                        content_length = int(header.split(":", 1)[1].strip())
                while len(body) < content_length:
                    body += client.recv(4096)
                body = body.decode()
                request = headers + "\r\n\r\n" + body
                if request.startswith("POST /save"):
                    _write_config(_form(body))
                    _send(client, "<h1>Guardado</h1><p>Reiniciando...</p>")
                    client.close()
                    time.sleep(2)
                    machine.reset()
                else:
                    _send(client, _page())
            except Exception as error:
                try:
                    _send(client, "<h1>Error</h1><p>{}</p>".format(_html(error)), "400 Bad Request")
                except Exception:
                    pass
            finally:
                client.close()
    finally:
        if dns:
            dns.close()
        if server:
            server.close()
        _portal_server = None
        _portal_started = False


def _enable_ap(ap):
    global PORTAL_HOST
    ap.active(True)
    mac_suffix = "".join("{:02X}".format(value) for value in ap.config("mac")[-2:])
    ap_ssid = AP_SSID_PREFIX + "-" + mac_suffix
    ap.ifconfig((AP_IP, "255.255.255.0", AP_IP, AP_IP))
    ap.config(essid=ap_ssid, authmode=network.AUTH_OPEN, max_clients=2)
    PORTAL_HOST = AP_IP


def start_background(motor=None, force_ap=False):
    _thread.start_new_thread(run, (motor, force_ap))
