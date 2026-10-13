import socket
import sys
import time
import network
import os
import pulsegrid


try:
    from wifi_config import WIFI_SSID, WIFI_PASSWORD
except ImportError:
    WIFI_SSID = "8a"
    WIFI_PASSWORD = "12345678a"
HTTP_PORT = 80
_server_started = False
_restart_requested = False
FIRMWARE_UPLOAD_FILES = ('main.py', 'pulsegrid.py', 'webserver.py', 'cortina.py', 'stservo.py', 'ssd1306.py')
STYLE = '''<link rel=stylesheet href=/style.css>'''
RICH_CSS = '''*{box-sizing:border-box}body{margin:0 auto;max-width:760px;padding:0 18px 30px;background:#eef2f3;color:#17212b;font:15px system-ui,-apple-system,"Segoe UI",sans-serif}h1{margin:0 -18px 22px;padding:19px 22px;background:#123844;color:#fff;font-size:24px}h1:after{content:"Panel de control";display:block;margin-top:4px;color:#c6e3e4;font-size:12px;font-weight:400}h2{margin:22px 0 8px;padding-bottom:6px;border-bottom:2px solid #087f8c;font-size:18px}p:first-of-type{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 18px;padding:10px;background:#fff;border:1px solid #d8dee5;border-radius:8px}a{color:#087f8c;font-weight:700;text-decoration:none}a:hover{text-decoration:underline}form{margin:8px 0;padding:12px;background:#fff;border:1px solid #d8dee5;border-radius:8px;line-height:2.1;box-shadow:0 1px 2px #17212b12}input,select,button{min-height:32px;padding:5px 8px;border:1px solid #b9c4cc;border-radius:5px;background:#fff;color:#17212b}button{border:0;background:#087f8c;color:#fff;font-weight:700;cursor:pointer}button:hover{background:#066b75}iframe{width:100%;min-height:50px;margin-top:12px;padding:4px;border:1px solid #d8dee5;border-radius:8px;background:#fff}@media(max-width:520px){body{padding:0 12px 24px}h1{margin:0 -12px 18px}input{max-width:96px}}'''
CONTROL_TABLE_HTML = '''<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><title>Control</title><h1>Control de servos</h1><p><a href=/>Inicio</a> | <a href=/blind>Persiana</a> | <a href=/config>Configuracion</a> | <a href=/pulsegrid>Pulsegrid</a> | <a href=/status target=r>Estado</a></p><form class=actions><button formaction=/api/abrir formtarget=r>Abrir ambos</button><button formaction=/api/cerrar formtarget=r>Cerrar ambos</button><button formaction=/api/parar formtarget=r>Parar ambos</button></form><h2>Movimiento</h2><form action=/api/move target=r><table><tr><td>Servo</td><td><input name=id value=1></td><td>Modo</td><td><select name=mode><option value=0>Servo</option><option value=1>Rueda</option><option value=3>Multivuelta</option></select></td></tr><tr><td>Posicion</td><td><input name=position value=2000></td><td>Velocidad</td><td><input name=speed value=800></td></tr><tr><td>Aceleracion</td><td><input name=acceleration value=50></td><td>Vueltas</td><td><input name=turns value=1></td></tr></table><button>Ejecutar</button></form><h2>Acciones por servo</h2><form class=actions><label>Servo <input name=id value=1></label><button formaction=/api/stop formtarget=r>Parar</button><button formaction=/api/reset_turns formtarget=r>Cero vueltas</button></form><form action=/api/torque target=r><table><tr><td>Servo</td><td><input name=id value=1></td><td>Torque</td><td><select name=enabled><option value=1>ON</option><option value=0>OFF</option></select></td></tr></table><button>Aplicar torque</button></form><iframe name=r title=resultado></iframe>'''
TABLE_CSS = '''table{width:100%;border-collapse:separate;border-spacing:6px}td{width:25%;vertical-align:middle}td:nth-child(odd){color:#526473;font-size:12px;font-weight:700}td input,td select{width:100%;margin:0}.actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.actions input{width:58px}@media(max-width:520px){table,tr,td{display:block;width:100%}tr{padding:6px 0;border-bottom:1px solid #e3e8ea}td{padding:2px 0}td:nth-child(odd){margin-top:4px}}'''
BLIND_TABLE_HTML = '''<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><title>Persiana</title><h1>Persiana</h1><p><a href=/>Inicio</a> | <a href=/control>Control</a> | <a href=/config>Configuracion</a> | <a href=/status target=r>Estado</a></p><h2>Extremos</h2><form action=/api/blind_config target=r><table><tr><td>Servo</td><td><input name=id value=1></td></tr><tr><td>Enrollada</td><td><input name=rolled value=0></td></tr><tr><td>Desenrollada</td><td><input name=unrolled value=10></td></tr></table><button>Guardar extremos</button></form><h2>Posicion deseada</h2><form action=/api/blind_move target=r><table><tr><td>Servo</td><td><input name=id value=1></td><td>Porcentaje</td><td><input name=percent value=50></td></tr><tr><td>Velocidad</td><td><input name=speed value=800></td><td>Aceleracion</td><td><input name=acceleration value=50></td></tr></table><button>Mover persiana</button></form><iframe name=r title=resultado></iframe>'''
CONFIG_TABLE_HTML = '''<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><title>Configuracion</title><h1>Configuracion</h1><p><a href=/>Inicio</a> | <a href=/control>Control</a> | <a href=/blind>Persiana</a> | <a href=/status target=r>Estado</a></p><form action=/api/configure target=r><table><tr><td>Servo</td><td><input name=id value=1></td><td>Modo</td><td><select name=mode><option value=0>Servo</option><option value=1>Rueda</option><option value=3>Multivuelta</option></select></td></tr><tr><td>Limite minimo</td><td><input name=min value=300></td><td>Limite maximo</td><td><input name=max value=3700></td></tr><tr><td>Torque maximo</td><td><input name=torque value=1000></td><td></td><td></td></tr></table><button>Aplicar configuracion</button></form><iframe name=r title=resultado></iframe>'''
PULSEGRID_HTML = '''<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><title>Pulsegrid</title><h1>Pulsegrid</h1><p><a href=/>Inicio</a> | <a href=/control>Control</a> | <a href=/config>Servo</a> | <a href=/status target=r>Estado</a></p><p>Esta configuracion se guarda localmente en la ESP32. La API key se muestra porque esta pagina solo esta disponible en tu red local.</p><form action=/api/pulsegrid_configure target=r><table><tr><td>API URL</td><td><input name=api_url value="{api_url}" size=42></td></tr><tr><td>API key</td><td><input name=api_key value="{api_key}" size=42 autocomplete=off></td></tr><tr><td>Device ID</td><td><input name=device_id value="{device_id}" size=28></td></tr><tr><td>Comandos</td><td><select name=commands_enabled><option value=0{commands_off}>Desactivados</option><option value=1{commands_on}>Activados</option></select></td></tr></table><button>Guardar Pulsegrid</button></form><h2>Actualizar firmware local</h2><p>Sube un archivo .py por vez y reinicia cuando termines todos.</p><form action=/api/firmware_update method=post enctype=multipart/form-data target=r><input type=file name=firmware accept=".py" required><button>Subir archivo</button></form><form action=/api/firmware_restart method=post target=r><button>Reiniciar ESP32</button></form><iframe name=r title=resultado></iframe>'''


RICH_CSS = 'body{font:15px sans-serif;max-width:720px;margin:20px auto;padding:0 12px}a{color:#087f8c}form{margin:10px 0;padding:10px;border:1px solid #ccd;border-radius:6px}input,select,button{padding:6px;margin:3px}button{background:#087f8c;color:white;border:0;border-radius:4px}table{width:100%}td{padding:3px}'
TABLE_CSS = 'table{border-collapse:collapse}td{vertical-align:middle}'
CONTROL_TABLE_HTML = '<!doctype html><meta name=viewport content="width=device-width"><title>Control</title><h1>Control</h1><p><a href=/pulsegrid>Pulsegrid</a> | <a href=/blind>Persiana</a> | <a href=/config>Servo</a> | <a href=/status>Estado</a></p><form><button formaction=/api/abrir>Abrir</button><button formaction=/api/cerrar>Cerrar</button><button formaction=/api/parar>Parar</button></form><form action=/api/move>Servo <input name=id value=1> Modo <select name=mode><option value=0>Servo</option><option value=1>Rueda</option><option value=3>Multivuelta</option></select><br>Posicion <input name=position value=2000> Velocidad <input name=speed value=800> Aceleracion <input name=acceleration value=50> Vueltas <input name=turns value=1><br><button>Ejecutar</button></form>'
BLIND_TABLE_HTML = '<!doctype html><meta name=viewport content="width=device-width"><title>Persiana</title><h1>Persiana</h1><p><a href=/control>Control</a> | <a href=/pulsegrid>Pulsegrid</a> | <a href=/status>Estado</a></p><form action=/api/blind_config>Servo <input name=id value=1> Enrollada <input name=rolled value=0> Desenrollada <input name=unrolled value=10><button>Guardar</button></form><form action=/api/blind_move>Servo <input name=id value=1> Porcentaje <input name=percent value=50> Velocidad <input name=speed value=800> Aceleracion <input name=acceleration value=50><button>Mover</button></form>'
CONFIG_TABLE_HTML = '<!doctype html><meta name=viewport content="width=device-width"><title>Configuracion</title><h1>Configuracion</h1><p><a href=/control>Control</a> | <a href=/pulsegrid>Pulsegrid</a> | <a href=/status>Estado</a></p><form action=/api/configure>Servo <input name=id value=1> Modo <select name=mode><option value=0>Servo</option><option value=1>Rueda</option><option value=3>Multivuelta</option></select><br>Min <input name=min value=300> Max <input name=max value=3700> Torque <input name=torque value=1000><button>Aplicar</button></form>'
PULSEGRID_HTML = '<!doctype html><meta name=viewport content="width=device-width"><title>Pulsegrid</title><h1>Pulsegrid</h1><p><a href=/control>Control</a> | <a href=/config>Servo</a> | <a href=/status>Estado</a></p><form action=/api/pulsegrid_configure><label>API URL <input name=api_url value="{api_url}"></label><br><label>API key <input name=api_key value="{api_key}"></label><br><label>Device ID <input name=device_id value="{device_id}"></label><br><label>Comandos <select name=commands_enabled><option value=0{commands_off}>No</option><option value=1{commands_on}>Si</option></select></label><br><button>Guardar Pulsegrid</button></form><form action=/api/firmware_update method=post enctype=multipart/form-data><input type=file name=firmware accept=".py" required><button>Subir firmware</button></form><form action=/api/firmware_restart method=post><button>Reiniciar ESP32</button></form>'
CONTROL_HTML = None
BLIND_HTML = None
CONFIG_HTML = None


def blind_page(cortina, servo_id):
    target = cortina.blind_targets[servo_id]
    config = cortina.blind_config[servo_id]
    return BLIND_TABLE_HTML.replace(
        "<h2>Extremos</h2>", "<p><a href='/blind?id=1'>Servo 1</a> | <a href='/blind?id=2'>Servo 2</a></p><h2>Extremos</h2>"
    ).replace(
        "name=id value=1", "name=id value={}".format(servo_id)
    ).replace(
        "name=rolled value=0", "name=rolled value={}".format(config["rolled_turns"])
    ).replace(
        "name=unrolled value=10", "name=unrolled value={}".format(config["unrolled_turns"])
    ).replace(
        "name=percent value=50", "name=percent value={}".format(target["percent"])
    ).replace(
        "name=speed value=800", "name=speed value={}".format(target["speed"])
    ).replace(
        "name=acceleration value=50", "name=acceleration value={}".format(target["acceleration"])
    )
SIMPLE_HTML = '''<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><title>Cortina ESP32</title><h1>Cortina ESP32</h1><p><a href=/control>Control</a> | <a href=/blind>Persiana</a> | <a href=/config>Configuracion</a> | <a href=/pulsegrid>Pulsegrid</a> | <a href=/status>Estado</a></p><p>Interfaz compacta: sin animaciones ni actualizacion automatica.</p>'''
CONTROL_HTML = '''<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><title>Control</title><h1>Control de servos</h1><p><a href=/>Inicio</a> | <a href=/blind>Persiana</a> | <a href=/config>Configuracion</a> | <a href=/status target=r>Estado</a></p><p><button form=a>Abrir ambos</button> <button form=c>Cerrar ambos</button> <button form=p>Parar ambos</button></p><form id=a action=/api/abrir target=r></form><form id=c action=/api/cerrar target=r></form><form id=p action=/api/parar target=r></form><h2>Movimiento</h2><form action=/api/move target=r>Servo <input name=id value=1 size=2> Modo <select name=mode><option value=0>Servo</option><option value=1>Rueda</option><option value=3>Multivuelta</option></select><br>Posicion <input name=position value=2000 size=5> Velocidad <input name=speed value=800 size=5> Aceleracion <input name=acceleration value=50 size=3> Vueltas <input name=turns value=1 size=5><br><button>Ejecutar</button></form><p>Rueda: usa velocidad negativa para invertir. Multivuelta: usa vueltas con signo.</p><h2>Acciones por servo</h2><form action=/api/stop target=r>Servo <input name=id value=1 size=2><button>Parar</button></form><form action=/api/torque target=r>Servo <input name=id value=1 size=2> Torque <select name=enabled><option value=1>ON</option><option value=0>OFF</option></select><button>Aplicar</button></form><form action=/api/reset_turns target=r>Servo <input name=id value=1 size=2><button>Cero vueltas</button></form><iframe name=r title=resultado></iframe>'''



def _json(value):
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, dict):
        return "{" + ",".join('"{}":{}'.format(k, _json(v)) for k, v in value.items()) + "}"
    return '"{}"'.format(str(value).replace('\\', '\\\\').replace('"', '\\"'))


def _html(value):
    return str(value).replace('&', '&amp;').replace('"', '&quot;').replace('<', '&lt;').replace('>', '&gt;')


def pulsegrid_page():
    return PULSEGRID_HTML.format(
        api_url=_html(pulsegrid.API_URL),
        api_key=_html(pulsegrid.API_KEY),
        device_id=_html(pulsegrid.DEVICE_ID),
        commands_off=' selected' if not pulsegrid.COMMANDS_ENABLED else '',
        commands_on=' selected' if pulsegrid.COMMANDS_ENABLED else ''
    )


def connect_wifi():
    ap = network.WLAN(network.AP_IF)
    ap.active(True)
    ap.config(essid="Pulsegrid-Cortina", authmode=network.AUTH_OPEN, max_clients=2)
    ap.ifconfig(("192.168.4.1", "255.255.255.0", "192.168.4.1", "192.168.4.1"))
    print("Portal de recuperacion: Pulsegrid-Cortina (http://192.168.4.1/pulsegrid)")
    wlan = network.WLAN(network.STA_IF)
    wlan.active(True)
    if not wlan.isconnected():
        wlan.connect(WIFI_SSID, WIFI_PASSWORD)
        deadline = time.ticks_add(time.ticks_ms(), 15000)
        while not wlan.isconnected() and time.ticks_diff(deadline, time.ticks_ms()) > 0:
            time.sleep_ms(250)
    if not wlan.isconnected():
        raise RuntimeError("No se pudo conectar a WiFi {}".format(WIFI_SSID))
    ip = wlan.ifconfig()[0]
    print("WiFi conectado: {}".format(ip))
    return ip


def status(cortina):
    result = {}
    for servo_id in cortina.servo_ids:
        cfg = cortina.configuration(servo_id)
        cfg["position"] = cortina.bus.position_signed(servo_id) if cfg["mode"] == 3 else cortina.position(servo_id)
        cfg.update(cortina.multiturn_status(servo_id))
        result[str(servo_id)] = cfg
    return result


def query(path):
    values = {}
    if "?" not in path:
        return values
    for part in path.split("?", 1)[1].split("&"):
        if "=" in part:
            key, value = part.split("=", 1)
            values[key] = _url_decode(value)
    return values


def _url_decode(value):
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


def number(values, key, default=0):
    try:
        return int(values.get(key, default))
    except (TypeError, ValueError):
        raise ValueError("Parametro invalido: {}".format(key))


def decimal(values, key, default=0):
    try:
        return float(values.get(key, default))
    except (TypeError, ValueError):
        raise ValueError("Parametro invalido: {}".format(key))


def handle(path, cortina):
    try:
        if path == "/api/status":
            return {"message": "Estado actualizado", "status": status(cortina)}
        if path.startswith("/api/pulsegrid_configure"):
            values = query(path)
            result = pulsegrid.configure(values.get("api_url"), values.get("api_key"), values.get("device_id"), number(values, "commands_enabled") != 0)
            return {"message": "Configuracion Pulsegrid guardada", "config": result}
        if path.startswith("/api/pc"):
            values = query(path)
            scope = {"__name__": "__main__", "cortina": cortina}
            exec("main = type('MainProxy', (), {'cortina': cortina})()\n" + values.get("code", ""), scope)
            return {"message": "Operacion terminada"}
        if path == "/api/abrir":
            cortina.abrir()
        elif path == "/api/cerrar":
            cortina.cerrar()
        elif path == "/api/parar":
            cortina.parar()
        elif path.startswith("/api/stop"):
            cortina.parar_servo(number(query(path), "id"))
        elif path.startswith("/api/reset_turns"):
            cortina.reset_absolute_turns(number(query(path), "id"))
        elif path.startswith("/api/blind_config"):
            values = query(path)
            cortina.configure_blind(number(values, "id"), decimal(values, "rolled"), decimal(values, "unrolled"))
        elif path.startswith("/api/blind_move"):
            values = query(path)
            cortina.move_blind(number(values, "id"), decimal(values, "percent"), number(values, "speed", 800), number(values, "acceleration", 50))
        elif path.startswith("/api/torque"):
            values = query(path)
            cortina.torque_servo(number(values, "id"), number(values, "enabled") != 0)
        elif path.startswith("/api/move"):
            values = query(path)
            servo_id = number(values, "id")
            mode = number(values, "mode")
            speed = number(values, "speed")
            acceleration = number(values, "acceleration", 50)
            cortina.configure_motion(speed, acceleration)
            if mode == 0:
                cortina.comando(0, position=number(values, "position"), servo_id=servo_id)
            elif mode == 1:
                cortina.comando(1, speed=speed, servo_id=servo_id)
            else:
                cortina.comando(3, turns=decimal(values, "turns"), servo_id=servo_id)
        elif path.startswith("/api/configure"):
            values = query(path)
            cortina.configure_servo(number(values, "id"), number(values, "min"), number(values, "max"), number(values, "mode"), number(values, "torque"))
        else:
            return {"message": "Ruta no encontrada"}
        return {"message": "Comando ejecutado", "status": status(cortina)}
    except Exception as error:
        return {"message": "Error: {}".format(error)}


def _firmware_upload(body_bytes):
    marker = b'filename="'
    filename_start = body_bytes.find(marker)
    if filename_start < 0:
        raise ValueError("Archivo no encontrado")
    filename_start += len(marker)
    filename_end = body_bytes.find(b'"', filename_start)
    filename = body_bytes[filename_start:filename_end].decode("utf-8")
    if filename not in FIRMWARE_UPLOAD_FILES:
        raise ValueError("Archivo no permitido")
    content_start = body_bytes.find(b"\r\n\r\n", filename_end)
    if content_start < 0:
        raise ValueError("Carga invalida")
    content_start += 4
    boundary_start = body_bytes.find(b"\r\n--", content_start)
    if boundary_start < 0:
        raise ValueError("Carga incompleta")
    content = body_bytes[content_start:boundary_start]
    if not content:
        raise ValueError("Archivo vacio")
    temporary_name = filename + ".upload"
    with open(temporary_name, "wb") as firmware_file:
        firmware_file.write(content)
    try:
        os.remove(filename)
    except OSError:
        pass
    os.rename(temporary_name, filename)
    return {"message": "Archivo actualizado", "file": filename, "bytes": len(content)}


def _serve_loop(cortina, sync_callback=None):
    global _restart_requested
    address = socket.getaddrinfo("0.0.0.0", HTTP_PORT)[0][-1]
    server = socket.socket()
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(address)
    server.listen(2)
    server.settimeout(0.1)
    while True:
        cortina.update_multiturn()
        if sync_callback and not any(cortina.multiturn_active.values()):
            sync_callback(cortina)
        try:
            client, _ = server.accept()
        except OSError:
            time.sleep(0.05)
            continue
        try:
            client.settimeout(20)
            request_bytes = client.recv(2048)
            header_end = request_bytes.find(b"\r\n\r\n")
            while header_end < 0:
                request_bytes += client.recv(2048)
                header_end = request_bytes.find(b"\r\n\r\n")
            headers = request_bytes[:header_end].decode("utf-8")
            body_bytes = request_bytes[header_end + 4:]
            content_length = 0
            for header in headers.split("\r\n")[1:]:
                if header.lower().startswith("content-length:"):
                    content_length = int(header.split(":", 1)[1].strip())
            while len(body_bytes) < content_length:
                body_bytes += client.recv(2048)
            request = headers + "\r\n\r\n" + body_bytes[:content_length].decode("utf-8")
            first_line = headers.split("\r\n", 1)[0]
            path = first_line.split(" ")[1]
            method = first_line.split(" ")[0]
            page = path.split("?", 1)[0]
            if method == "POST" and page == "/api/firmware_update":
                body = _json(_firmware_upload(body_bytes))
                content_type = "application/json"
            elif method == "POST" and page == "/api/firmware_restart":
                _restart_requested = True
                body = _json({"message": "Reinicio solicitado"})
                content_type = "application/json"
            else:
                request = headers + "\r\n\r\n" + body_bytes[:content_length].decode("utf-8")
                if method == "POST" and path == "/api/pc":
                    path += "?" + request.split("\r\n\r\n", 1)[1]
                page = path.split("?", 1)[0]
            if method == "POST" and page in ("/api/firmware_update", "/api/firmware_restart"):
                pass
            elif page == "/":
                body = STYLE + SIMPLE_HTML
                content_type = "text/html"
            elif page == "/control":
                body = STYLE + CONTROL_TABLE_HTML
                content_type = "text/html"
            elif page == "/blind":
                values = query(path)
                servo_id = number(values, "id", 1)
                if servo_id not in cortina.servo_ids:
                    raise ValueError("ID de servo no detectado")
                body = STYLE + blind_page(cortina, servo_id)
                content_type = "text/html"
            elif page == "/config":
                body = STYLE + CONFIG_TABLE_HTML
                content_type = "text/html"
            elif page == "/pulsegrid":
                body = STYLE + pulsegrid_page()
                content_type = "text/html"
            elif page == "/style.css":
                body = RICH_CSS + TABLE_CSS
                content_type = "text/css"
            elif page == "/status":
                body = _json({"status": status(cortina)})
                content_type = "application/json"
            elif page in ("/generate_204", "/hotspot-detect.html", "/connecttest.txt", "/ncsi.txt"):
                body = STYLE + SIMPLE_HTML
                content_type = "text/html"
            elif path.startswith("/api/"):
                body = _json(handle(path, cortina))
                content_type = "application/json"
            else:
                body = "Not found"
                content_type = "text/plain"
            response = "HTTP/1.1 200 OK\r\nContent-Type: {}; charset=utf-8\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}".format(content_type, len(body.encode()), body).encode()
            client.sendall(response)
            if _restart_requested:
                _restart_requested = False
                import machine
                machine.reset()
        except Exception as error:
            print("HTTP error:", error)
            sys.print_exception(error)
        finally:
            client.close()


def serve(cortina, sync_callback=None):
    global _server_started
    if _server_started:
        return
    ip = connect_wifi()
    try:
        from pulsegrid_firmware import VERSION as firmware_version
    except (ImportError, AttributeError):
        firmware_version = "unversioned"
    cortina._show("WiFi conectado", ip, "FW: " + firmware_version)
    print("Web GUI: http://{}".format(ip))
    _server_started = True
    _serve_loop(cortina, sync_callback)
