import socket
import time
import network
from machine import Pin
import pulsegrid_min as pulsegrid

try:
    import ota_boot
except ImportError:
    ota_boot = None

HTTP_PORT = 80
_started = False
_restart_requested = False
AP_IP = '192.168.4.1'
AP_SSID_PREFIX = 'Pulsegrid-Cortina'
STATUS_LED_PIN = 23
DEFAULT_API_URL = 'https://pulse.2api2.com'
PORTAL_HOST = AP_IP


class StatusLed:
    def __init__(self):
        self.rgb = None
        self.output = None
        try:
            import neopixel
            self.rgb = neopixel.NeoPixel(Pin(STATUS_LED_PIN), 1)
        except (ImportError, TypeError):
            self.output = Pin(STATUS_LED_PIN, Pin.OUT, value=0)

    def set(self, enabled):
        if self.rgb:
            self.rgb[0] = enabled if isinstance(enabled, tuple) else ((0, 30, 0) if enabled else (0, 0, 0))
            self.rgb.write()
        elif self.output:
            self.output.value(1 if enabled else 0)

    def portal_tick(self):
        self.set((time.ticks_ms() // 500) % 2 == 0)

try:
    from wifi_config import WIFI_SSID, WIFI_PASSWORD
except ImportError:
    WIFI_SSID = ''
    WIFI_PASSWORD = ''


def esc(value):
    return str(value).replace('&', '&amp;').replace('"', '&quot;').replace('<', '&lt;').replace('>', '&gt;')


def decode(value):
    value = value.replace('+', ' ')
    result = ''
    index = 0
    while index < len(value):
        if value[index:index + 1] == '%' and index + 2 < len(value):
            try:
                result += chr(int(value[index + 1:index + 3], 16))
                index += 3
                continue
            except ValueError:
                pass
        result += value[index]
        index += 1
    return result


def query(path):
    values = {}
    if '?' not in path:
        return values
    for item in path.split('?', 1)[1].split('&'):
        if '=' in item:
            key, value = item.split('=', 1)
            values[key] = decode(value)
    return values


def number(values, key, default=0):
    try:
        return int(values.get(key, default))
    except (TypeError, ValueError):
        raise ValueError('Parametro invalido: ' + key)


def status(cortina):
    result = {}
    for servo_id in cortina.servo_ids:
        values = cortina.configuration(servo_id)
        values['position'] = cortina.bus.position_signed(servo_id) if values['mode'] == 3 else cortina.position(servo_id)
        values.update(cortina.multiturn_status(servo_id))
        result[str(servo_id)] = values
    return result


def page(title, content):
    return '<!doctype html><meta name=viewport content="width=device-width"><title>{}</title><style>:root{{color-scheme:light}}body{{font:15px sans-serif;max-width:680px;margin:0 auto;padding:20px 14px;background:#f3f7f7;color:#17212b}}header{{padding:18px 16px;background:#123844;color:white;border-radius:8px}}header p{{margin:5px 0 0;color:#c6e3e4;font-size:13px}}nav,section{{margin-top:14px;padding:14px;background:white;border:1px solid #d8e1e3;border-radius:8px}}a{{color:#087f8c;font-weight:700}}form{{margin-top:10px}}label{{display:block;margin:10px 0 4px;font-weight:700}}input,select,button{{box-sizing:border-box;min-height:36px;width:100%;padding:7px;border:1px solid #b9c7ca;border-radius:5px;background:white;color:#17212b}}button{{margin-top:10px;background:#087f8c;color:white;border:0;font-weight:700}}.muted{{color:#526473;font-size:13px}}.grid{{display:grid;grid-template-columns:1fr 1fr;gap:10px}}@media(max-width:520px){{.grid{{grid-template-columns:1fr}}}}</style><header><h1>{}</h1><p>Pulsegrid · Servo ESP32 · portal local {}</p></header><nav><a href=/wifi>Wi-Fi</a> · <a href=/pulsegrid>Pulsegrid</a> · <a href=/control>Control</a> · <a href=/config>Servo</a> · <a href=/status>Estado</a></nav>{}'.format(title, AP_IP, title, AP_IP, content)


def page(title, content):
    return ('<!doctype html><meta name=viewport content="width=device-width">'
            '<title>{}</title><style>body{{font:15px sans-serif;max-width:680px;margin:0 auto;padding:20px 14px;background:#f3f7f7;color:#17212b}}'
            'header{{padding:18px 16px;background:#123844;color:white;border-radius:8px}}'
            'header p{{margin:5px 0 0;color:#c6e3e4;font-size:13px}}'
            'nav,section{{margin-top:14px;padding:14px;background:white;border:1px solid #d8e1e3;border-radius:8px}}'
            'a{{color:#087f8c;font-weight:700}}form{{margin-top:10px}}label{{display:block;margin:10px 0 4px;font-weight:700}}'
            'input,select,button{{box-sizing:border-box;min-height:36px;width:100%;padding:7px;border:1px solid #b9c7ca;border-radius:5px;background:white;color:#17212b}}'
            'button{{margin-top:10px;background:#087f8c;color:white;border:0;font-weight:700}}.muted{{color:#526473;font-size:13px}}</style>'
            '<header><h1>{}</h1><p>Pulsegrid - Servo ESP32 - portal local {}</p></header>'
            '<nav><a href=/wifi>Wi-Fi</a> | <a href=/pulsegrid>Pulsegrid</a> | <a href=/control>Control</a> | <a href=/config>Servo</a> | <a href=/status>Estado</a></nav>{}').format(title, PORTAL_HOST, content)


def pulsegrid_page():
    api_url = pulsegrid.API_URL if pulsegrid.API_URL.startswith('https://') else DEFAULT_API_URL
    content = '<form action=/api/pulsegrid_configure>API URL <input name=api_url value="{}" required><br>API key <input name=api_key type=password value="{}" placeholder="Opcional"><br>Device ID <input name=device_id value="{}" required><br>Comandos <select name=commands_enabled><option value=0{}>No</option><option value=1{}>Si</option></select><br><button>Guardar Pulsegrid</button></form>'.format(esc(api_url), esc(pulsegrid.API_KEY), esc(pulsegrid.DEVICE_ID), '' if pulsegrid.COMMANDS_ENABLED else ' selected', ' selected' if pulsegrid.COMMANDS_ENABLED else '')
    return page('Pulsegrid', content)


def wifi_page():
    content = '<p class=muted>Servicio Pulsegrid: {}</p><form action=/api/wifi_configure>Red Wi-Fi <input name=ssid value="{}" required><br>Contrasena <input name=password type=password value="{}"><br><button>Guardar Wi-Fi y reiniciar</button></form>'.format(esc(DEFAULT_API_URL), esc(WIFI_SSID), esc(WIFI_PASSWORD))
    return page('Wi-Fi', content)


def action(path, cortina):
    global WIFI_SSID, WIFI_PASSWORD, _restart_requested
    values = query(path)
    if path.startswith('/api/pulsegrid_configure'):
        return pulsegrid.configure(values.get('api_url'), values.get('api_key'), values.get('device_id'), number(values, 'commands_enabled') != 0)
    if path.startswith('/api/wifi_configure'):
        ssid = str(values.get('ssid', '')).strip()
        password = str(values.get('password', ''))
        if not ssid:
            raise ValueError('SSID es obligatorio')
        with open('wifi_config.py.tmp', 'w') as target:
            target.write('WIFI_SSID = {!r}\nWIFI_PASSWORD = {!r}\n'.format(ssid, password))
        try:
            import os
            os.remove('wifi_config.py')
        except OSError:
            pass
        import os
        os.rename('wifi_config.py.tmp', 'wifi_config.py')
        WIFI_SSID, WIFI_PASSWORD = ssid, password
        _restart_requested = True
        return {'message': 'Wi-Fi guardado; reiniciando'}
    if path == '/api/status':
        return {'status': status(cortina)}
    if path == '/api/abrir':
        cortina.abrir()
    elif path == '/api/cerrar':
        cortina.cerrar()
    elif path == '/api/parar':
        cortina.parar()
    elif path.startswith('/api/stop'):
        cortina.parar_servo(number(values, 'id', 1))
    elif path.startswith('/api/pc'):
        scope = {'cortina': cortina, '__name__': '__main__'}
        exec(decode(values.get('code', '')), scope)
    else:
        raise ValueError('Ruta no encontrada')
    return {'message': 'Comando ejecutado', 'status': status(cortina)}


def connect_wifi():
    wlan = network.WLAN(network.STA_IF)
    if not str(WIFI_SSID or '').strip():
        try:
            wlan.disconnect()
        except Exception:
            pass
        try:
            wlan.active(False)
        except Exception:
            pass
        return None
    try:
        wlan.active(True)
        if not wlan.isconnected():
            wlan.connect(WIFI_SSID, WIFI_PASSWORD)
        return wlan if wlan.isconnected() else None
    except Exception as error:
        print('Wi-Fi no conectado: {}'.format(error))
        try:
            wlan.disconnect()
        except Exception:
            pass
        return None


def serve(cortina, sync_callback=None):
    global _started, _restart_requested, PORTAL_HOST
    if _started:
        return
    status_led = StatusLed()
    ap = network.WLAN(network.AP_IF)
    ap.active(False)
    wlan = connect_wifi()
    if wlan:
        status_led.set(pulsegrid.led_enabled(True if pulsegrid.API_KEY else (30, 25, 0)))
        PORTAL_HOST = wlan.ifconfig()[0]
        if pulsegrid.API_KEY:
            print('Wi-Fi conectado: LED verde; portal: http://{}/'.format(PORTAL_HOST))
        else:
            print('Wi-Fi conectado: LED amarillo; portal: http://{}/ (esperando API key)'.format(PORTAL_HOST))
    else:
        _enable_ap(ap)
        status_led.portal_tick()
        print('Wi-Fi no disponible: portal AP activo en http://{}/ y LED parpadeando 1 Hz'.format(AP_IP))
    _started = True
    address = socket.getaddrinfo('0.0.0.0', HTTP_PORT)[0][-1]
    server = socket.socket()
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(address)
    server.listen(2)
    server.settimeout(0.1)
    next_wifi_retry = 0
    while True:
        if ota_boot:
            ota_boot.feed()
        cortina.update_multiturn()
        now = time.ticks_ms()
        connected = bool(wlan and wlan.isconnected())
        if connected:
            status_led.set(pulsegrid.led_enabled(True if pulsegrid.API_KEY else (30, 25, 0)))
            if ap.active():
                ap.active(False)
            PORTAL_HOST = wlan.ifconfig()[0]
        else:
            status_led.portal_tick()
            if not ap.active():
                _enable_ap(ap)
            if time.ticks_diff(now, next_wifi_retry) >= 0:
                next_wifi_retry = time.ticks_add(now, 15000)
                wlan = connect_wifi()
        if connected and sync_callback and not any(cortina.multiturn_active.values()):
            sync_callback(cortina)
        try:
            client, _ = server.accept()
        except OSError:
            time.sleep_ms(50)
            continue
        try:
            client.settimeout(10)
            data = client.recv(2048)
            split = data.find(b'\r\n\r\n')
            while split < 0:
                data += client.recv(2048)
                split = data.find(b'\r\n\r\n')
            headers = data[:split].decode()
            body = data[split + 4:]
            length = 0
            for line in headers.split('\r\n')[1:]:
                if line.lower().startswith('content-length:'):
                    length = int(line.split(':', 1)[1].strip())
            while len(body) < length:
                body += client.recv(2048)
            first = headers.split('\r\n', 1)[0].split(' ')
            method = first[0]
            path = first[1]
            if path == '/pulsegrid':
                content_type = 'text/html'
                output = pulsegrid_page()
            elif path == '/wifi':
                content_type = 'text/html'
                output = wifi_page()
            elif path == '/status':
                content_type = 'application/json'
                output = str({'status': status(cortina)})
            elif path == '/control':
                content_type = 'text/html'
                output = page('Control', '<form><button formaction=/api/abrir>Abrir</button><button formaction=/api/cerrar>Cerrar</button><button formaction=/api/parar>Parar</button></form>')
            elif path == '/config':
                content_type = 'text/html'
                output = page('Configuracion', '<h2>Configuracion del dispositivo</h2><p><a href=/wifi>Configurar Wi-Fi</a></p><p><a href=/pulsegrid>Configurar Pulsegrid, API key y Device ID</a></p><p><a href=/control>Ir al control del servo</a></p>')
            elif path == '/':
                content_type = 'text/html'
                output = page('Cortina ESP32', '<h2>Configuracion rapida</h2><p>Selecciona una opcion:</p><p><a href=/wifi>Configurar Wi-Fi</a></p><p><a href=/pulsegrid>Configurar Pulsegrid</a></p><p><a href=/control>Controlar cortina</a></p><p><a href=/status>Ver estado</a></p>')
            elif path.startswith('/api/'):
                content_type = 'application/json'
                output = str(action(path, cortina))
            else:
                content_type = 'text/plain'
                output = 'Not found'
            encoded = output.encode()
            response = 'HTTP/1.1 200 OK\r\nContent-Type: {}; charset=utf-8\r\nConnection: close\r\nContent-Length: {}\r\n\r\n'.format(content_type, len(encoded)).encode() + encoded
            client.sendall(response)
            if _restart_requested:
                _restart_requested = False
                import machine
                machine.reset()
        except Exception as error:
            print('HTTP error:', error)
        finally:
            client.close()


def _enable_ap(ap):
    global PORTAL_HOST
    ap.active(True)
    mac_suffix = ''.join('{:02X}'.format(value) for value in ap.config('mac')[-2:])
    ap.config(essid='Pulsegrid-Cortina-' + mac_suffix, authmode=network.AUTH_OPEN, max_clients=2)
    ap.ifconfig((AP_IP, '255.255.255.0', AP_IP, AP_IP))
    PORTAL_HOST = AP_IP
