import socket
import time
import network
import machine
import _thread

AP_IP = "192.168.4.1"
AP_SSID_PREFIX = "Pulsegrid-Cortina"
CONFIG_FILE = "config.py"
DEFAULT_API_URL = "https://pulsegrid.2api2.com"
motor_controller = None


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
            "password": getattr(config, "WIFI_PASSWORD", ""),
            "api_url": getattr(config, "API_URL", DEFAULT_API_URL) if str(getattr(config, "API_URL", "")).startswith("https://") else DEFAULT_API_URL,
            "api_key": getattr(config, "API_KEY", ""),
            "device_id": getattr(config, "DEVICE_ID", "cortina-ga25-01"),
            "travel": getattr(config, "FULL_TRAVEL_MS", 15000),
            "direction_reversed": getattr(config, "DIRECTION_REVERSED", False),
        }
    except ImportError:
        defaults = {"ssid": "", "password": "", "api_url": DEFAULT_API_URL, "api_key": "", "device_id": "cortina-ga25-01", "travel": 15000, "direction_reversed": False}
    defaults["direction_normal"] = "" if defaults["direction_reversed"] else " selected"
    defaults["direction_reverse"] = " selected" if defaults["direction_reversed"] else ""
    notice = "<p class=notice>{}</p>".format(_html(message)) if message else ""
    return """<!doctype html><html><meta name=viewport content='width=device-width'><title>Pulsegrid GA25</title>
<style>:root{{color-scheme:light}}body{{font:15px sans-serif;max-width:680px;margin:0 auto;padding:20px 14px;background:#f3f7f7;color:#17212b}}header{{padding:18px 16px;background:#123844;color:white;border-radius:8px}}header p{{margin:5px 0 0;color:#c6e3e4;font-size:13px}}main,nav,section{{margin-top:14px;padding:14px;background:white;border:1px solid #d8e1e3;border-radius:8px}}nav a{{color:#087f8c;font-weight:700}}label{{display:block;margin:10px 0 4px;font-weight:700}}input{{box-sizing:border-box;width:100%;min-height:36px;padding:8px;border:1px solid #b9c7ca;border-radius:5px;font-size:16px}}button{{box-sizing:border-box;min-height:36px;padding:8px 12px;background:#087f8c;color:white;border:0;border-radius:5px;font-weight:bold}}.motor-test{{margin-top:14px}}.motor-test button{{margin:5px 5px 0 0}}.stop{{background:#b42318}}.notice{{padding:10px;background:#e9f7e8;border-radius:5px}}.muted{{color:#526473;font-size:13px}}</style>
<header><h1>Configurar Pulsegrid</h1><p>Pulsegrid · Motor GA25 · portal local 192.168.4.1</p></header><nav><a href=/>Inicio</a> · <a href=/status>Estado</a></nav><main>{notice}<p class=muted>Configura la red Wi-Fi y la conexión cloud del motor GA25.</p>
<form method=post action=/save><label>Red Wi-Fi</label><input name=ssid required value='{ssid}'>
<label>Contrasena Wi-Fi</label><input name=password type=password value='{password}'>
<label>API URL</label><input name=api_url required value='{api_url}'>
<label>API key</label><input name=api_key required type=password value='{api_key}'>
<label>Device ID</label><input name=device_id required value='{device_id}'>
<label>Recorrido completo en milisegundos</label><input name=travel type=number min=1000 value='{travel}'><label>Sentido del motor</label><select name=direction_reversed><option value=0{direction_normal}>Normal</option><option value=1{direction_reverse}>Reversa</option></select><button type=submit>Guardar configuracion</button><a href=/ style="display:block;margin-top:12px">Cancelar</a></form>
<section class=motor-test><h2>Probar motor</h2><p class=muted>Cada prueba activa ENABLE al 100% durante 1500 ms y se detiene automaticamente.</p>
<form method=post action=/motor><button name=direction value=open>Abrir</button><button name=direction value=close>Cerrar</button><button class=stop name=direction value=stop>Detener</button></form></section></main></html>""".format(notice=notice, **defaults)


def _write_config(values):
    ssid = values.get("ssid", "").strip()
    password = values.get("password", "")
    api_url = values.get("api_url", "").strip().rstrip("/")
    api_key = values.get("api_key", "").strip()
    device_id = values.get("device_id", "").strip()
    try:
        travel = max(1000, int(values.get("travel", "15000")))
    except ValueError:
        travel = 15000
    if not ssid or not api_url or not api_key or not device_id:
        raise ValueError("SSID, API URL, API key y Device ID son obligatorios")
    with open(CONFIG_FILE, "w") as config:
        config.write("WIFI_SSID = {!r}\n".format(ssid))
        config.write("WIFI_PASSWORD = {!r}\n".format(password))
        config.write("API_URL = {!r}\n".format(api_url))
        config.write("API_KEY = {!r}\n".format(api_key))
        config.write("DEVICE_ID = {!r}\n".format(device_id))
        direction_reversed = values.get("direction_reversed", "0") == "1"
        config.write("FULL_TRAVEL_MS = {}\nOPEN_A_LEVEL = 1\nDIRECTION_REVERSED = {!r}\n".format(travel, direction_reversed))


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


def _test_motor(direction):
    if motor_controller is None:
        raise ValueError("Motor no disponible")
    if direction == "open":
        motor_controller.start(1, 100)
    elif direction == "close":
        motor_controller.start(-1, 100)
    elif direction == "stop":
        motor_controller.stop()
        return
    else:
        raise ValueError("Direccion de prueba invalida")
    time.sleep_ms(1500)
    motor_controller.stop()


def run(motor=None):
    global motor_controller
    motor_controller = motor
    ap = network.WLAN(network.AP_IF)
    ap.active(True)
    mac_suffix = "".join("{:02X}".format(value) for value in ap.config("mac")[-2:])
    ap_ssid = AP_SSID_PREFIX + "-" + mac_suffix
    ap.ifconfig((AP_IP, "255.255.255.0", AP_IP, AP_IP))
    ap.config(essid=ap_ssid, authmode=network.AUTH_OPEN, max_clients=2)
    print("Portal Wi-Fi abierto: {} ({})".format(ap_ssid, AP_IP))
    dns = _start_dns()
    server = socket.socket()
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("0.0.0.0", 80))
    server.listen(2)
    server.settimeout(0.2)
    try:
        while True:
            try:
                data, address = dns.recvfrom(256)
                dns.sendto(_dns_response(data), address)
            except OSError:
                pass
            try:
                client, _ = server.accept()
            except OSError:
                continue
            client.settimeout(1)
            try:
                request = client.recv(4096).decode()
                if request.startswith("POST /motor"):
                    body = request.split("\r\n\r\n", 1)[1] if "\r\n\r\n" in request else ""
                    _test_motor(_form(body).get("direction", ""))
                    _send(client, _page("Prueba de motor completada"))
                elif request.startswith("POST /save"):
                    body = request.split("\r\n\r\n", 1)[1] if "\r\n\r\n" in request else ""
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
        dns.close()
        server.close()


def start_background(motor=None):
    _thread.start_new_thread(run, (motor,))
