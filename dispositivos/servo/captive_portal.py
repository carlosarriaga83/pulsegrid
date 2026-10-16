import machine
import network
import socket
import time
import _thread

AP_IP = '192.168.4.1'
AP_SSID_PREFIX = 'Pulsegrid-Cortina'
DEFAULT_API_URL = 'https://pulse.2api2.com'
CONFIG_FILE = 'config.py'
PORTAL_HOST = AP_IP
_controller = None
_started = False


def _decode(value):
    value = value.replace('+', ' ')
    result = ''
    index = 0
    while index < len(value):
        if value[index] == '%' and index + 2 < len(value):
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
    for item in body.split('&'):
        if '=' in item:
            key, value = item.split('=', 1)
            values[_decode(key)] = _decode(value)
    return values


def _html(value):
    return str(value).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;')


def _config():
    try:
        import config
        return {
            'ssid': getattr(config, 'WIFI_SSID', ''),
            'password': getattr(config, 'WIFI_PASSWORD', ''),
            'api_url': getattr(config, 'API_URL', DEFAULT_API_URL),
            'device_code': getattr(config, 'DEVICE_CODE', ''),
            'device_id': getattr(config, 'DEVICE_ID', 'PULSE_XX'),
            'commands': getattr(config, 'COMMANDS_ENABLED', True),
            'reversed': getattr(config, 'DIRECTION_REVERSED', False),
        }
    except ImportError:
        return {'ssid': '', 'password': '', 'api_url': DEFAULT_API_URL, 'device_code': '', 'device_id': 'PULSE_XX', 'commands': True, 'reversed': False}


def _page(message=''):
    values = _config()
    normal = '' if values['reversed'] else ' selected'
    reversed_value = ' selected' if values['reversed'] else ''
    commands_no = '' if values['commands'] else ' selected'
    commands_yes = ' selected' if values['commands'] else ''
    notice = '<p class=notice>{}</p>'.format(_html(message)) if message else ''
    return """<!doctype html><meta name=viewport content='width=device-width'><title>Pulsegrid Servo</title>
<style>body{{font:15px sans-serif;max-width:680px;margin:0 auto;padding:20px 14px;background:#f3f7f7;color:#17212b}}header{{padding:18px 16px;background:#123844;color:white;border-radius:8px}}main,nav,section{{margin-top:14px;padding:14px;background:white;border:1px solid #d8e1e3;border-radius:8px}}a{{color:#087f8c;font-weight:700}}label{{display:block;margin:10px 0 4px;font-weight:700}}input,select{{box-sizing:border-box;width:100%;min-height:36px;padding:8px;border:1px solid #b9c7ca;border-radius:5px;font-size:16px}}button{{min-height:36px;padding:8px 12px;background:#087f8c;color:white;border:0;border-radius:5px;font-weight:bold;margin:5px 5px 0 0}}.stop{{background:#b42318}}.notice{{padding:10px;background:#e9f7e8;border-radius:5px}}.muted{{color:#526473;font-size:13px}}</style>
<header><h1>Configurar Pulsegrid</h1><p>Servo ST · portal local {portal}</p></header><nav><a href=/>Configuracion</a> · <a href=/status>Estado</a></nav><main>{notice}<p class=muted>Este portal solo guarda las credenciales de Wi-Fi. Los datos del dispositivo se conservan.</p><form method=post action=/save>
<label>Red Wi-Fi</label><input name=ssid required value='{ssid}'><label>Contrasena Wi-Fi</label><input name=password type=password value='{password}'><button type=submit>Guardar Wi-Fi</button></form><section><h2>Control local</h2><form method=post action=/control><button name=command value=open>Abrir</button><button name=command value=close>Cerrar</button><button class=stop name=command value=stop>Detener</button></form></section></main>""".format(
        notice=notice,
        portal=PORTAL_HOST,
        ssid=values['ssid'],
        password=values['password'],
        api_url=values['api_url'],
        device_id=values['device_id'],
        normal=normal,
        reversed=reversed_value,
        commands_no=commands_no,
        commands_yes=commands_yes,
    )


def _write_config(values):
    ssid = values.get('ssid', '').strip()
    current = _config()
    if not ssid:
        raise ValueError('SSID es obligatorio')
    content = "WIFI_SSID = {!r}\nWIFI_PASSWORD = {!r}\nAPI_URL = {!r}\nDEVICE_CODE = {!r}\nDEVICE_ID = {!r}\nCOMMANDS_ENABLED = {!r}\nDIRECTION_REVERSED = {!r}\n".format(
        ssid, values.get('password', ''), current['api_url'], current['device_code'], current['device_id'], current['commands'], current['reversed'],
    )
    with open(CONFIG_FILE, 'w') as config:
        config.write(content)


def _send(client, body, status='200 OK', content_type='text/html'):
    response = 'HTTP/1.1 {}\r\nContent-Type: {}; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}'.format(status, content_type, len(body), body)
    client.sendall(response.encode())


def _status():
    result = {}
    if _controller:
        for servo_id in _controller.servo_ids:
            values = _controller.multiturn_status(servo_id)
            values['position'] = _controller.position(servo_id)
            result[str(servo_id)] = values
    return str(result)


def _control(command):
    if not _controller:
        raise ValueError('Controlador no disponible')
    if command == 'open':
        _controller.abrir()
    elif command == 'close':
        _controller.cerrar()
    elif command == 'stop':
        _controller.parar()
    else:
        raise ValueError('Comando invalido')


def _enable_ap(ap):
    global PORTAL_HOST
    ap.active(True)
    suffix = ''.join('{:02X}'.format(value) for value in ap.config('mac')[-2:])
    ap.config(essid=AP_SSID_PREFIX + '-' + suffix, authmode=network.AUTH_OPEN, max_clients=2)
    ap.ifconfig((AP_IP, '255.255.255.0', AP_IP, AP_IP))
    PORTAL_HOST = AP_IP


def run(controller=None):
    global _controller, PORTAL_HOST, _started
    if _started:
        return
    _started = True
    _controller = controller
    values = _config()
    station = network.WLAN(network.STA_IF)
    if values['ssid']:
        station.active(True)
    ap = network.WLAN(network.AP_IF)
    ap.active(False)
    server = socket.socket()
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(('0.0.0.0', 80))
    server.listen(2)
    server.settimeout(0.2)
    while True:
        if station.isconnected():
            if ap.active():
                ap.active(False)
            PORTAL_HOST = station.ifconfig()[0]
        elif not ap.active():
            _enable_ap(ap)
        try:
            client, _ = server.accept()
        except OSError:
            time.sleep_ms(50)
            continue
        try:
            client.settimeout(10)
            data = client.recv(4096)
            end = data.find(b'\r\n\r\n')
            while end < 0:
                data += client.recv(4096)
                end = data.find(b'\r\n\r\n')
            headers = data[:end].decode()
            body = data[end + 4:]
            length = 0
            for line in headers.split('\r\n')[1:]:
                if line.lower().startswith('content-length:'):
                    length = int(line.split(':', 1)[1].strip())
            while len(body) < length:
                body += client.recv(4096)
            request = headers + '\r\n\r\n' + body.decode()
            if request.startswith('POST /save'):
                _write_config(_form(body.decode()))
                _send(client, '<h1>Guardado</h1><p>Reiniciando...</p>')
                client.close()
                time.sleep_ms(250)
                machine.reset()
            elif request.startswith('POST /control'):
                _control(_form(body.decode()).get('command', ''))
                _send(client, _page('Comando ejecutado'))
            elif request.startswith('GET /status'):
                _send(client, _status(), content_type='application/json')
            else:
                _send(client, _page())
        except Exception as error:
            try:
                _send(client, '<h1>Error</h1><p>{}</p>'.format(_html(error)), '400 Bad Request')
            except Exception:
                pass
        finally:
            client.close()


def start_background(controller=None):
    _thread.start_new_thread(run, (controller,))
