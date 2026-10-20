import machine
import network
import socket
import time
import _thread
import ujson

AP_IP = '192.168.4.1'
AP_SSID_PREFIX = 'Pulsegrid-Cortina'
DEFAULT_API_URL = 'https://pulse.2api2.com'
CONFIG_FILE = 'config.py'
PORTAL_HOST = AP_IP
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
    notice = '<p class=notice>{}</p>'.format(_html(message)) if message else ''
    return """<!doctype html><meta name=viewport content='width=device-width'><title>Pulsegrid Wi-Fi</title>
<style>body{{font:15px sans-serif;max-width:520px;margin:0 auto;padding:20px 14px;background:#f3f7f7;color:#17212b}}header,main{{margin-top:14px;padding:18px 16px;background:white;border:1px solid #d8e1e3;border-radius:8px}}header{{background:#123844;color:white}}label{{display:block;margin:14px 0 5px;font-weight:700}}input{{box-sizing:border-box;width:100%;min-height:42px;padding:9px;border:1px solid #b9c7ca;border-radius:5px;font-size:16px}}button{{min-height:40px;padding:9px 14px;background:#087f8c;color:white;border:0;border-radius:5px;font-weight:bold;margin-top:12px}}.notice{{padding:10px;background:#e9f7e8;border-radius:5px}}</style>
<header><h1>Configurar Wi-Fi</h1><p>Pulsegrid Servo · {portal}</p></header><main>{notice}<form method=post action=/save><label>Red Wi-Fi</label><input name=ssid required value='{ssid}' autocomplete=off><label>Contraseña Wi-Fi</label><input name=password type=password value='' placeholder='En blanco conserva la actual' autocomplete=new-password><button type=submit>Guardar y reiniciar</button></form></main>""".format(
        notice=notice,
        portal=PORTAL_HOST,
        ssid=values['ssid'],
    )


def _write_config(values):
    ssid = values.get('ssid', '').strip()
    current = _config()
    if not ssid:
        raise ValueError('SSID es obligatorio')
    password = values.get('password', '') or current['password']
    content = "WIFI_SSID = {!r}\nWIFI_PASSWORD = {!r}\nAPI_URL = {!r}\nDEVICE_CODE = {!r}\nDEVICE_ID = {!r}\nCOMMANDS_ENABLED = {!r}\nDIRECTION_REVERSED = {!r}\n".format(
        ssid, password, current['api_url'], current['device_code'], current['device_id'], current['commands'], current['reversed'],
    )
    with open(CONFIG_FILE, 'w') as config:
        config.write(content)
    try:
        import wifi_recovery
        wifi_recovery.clear_boots()
    except ImportError:
        pass


def _send(client, body, status='200 OK', content_type='text/html'):
    encoded = body.encode()
    headers = 'HTTP/1.1 {}\r\nContent-Type: {}; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n'.format(status, content_type, len(encoded))
    client.sendall(headers.encode() + encoded)


def _enable_ap(ap):
    global PORTAL_HOST
    ap.active(True)
    suffix = ''.join('{:02X}'.format(value) for value in ap.config('mac')[-2:])
    ap.config(essid=AP_SSID_PREFIX + '-' + suffix, authmode=network.AUTH_OPEN, max_clients=2)
    ap.ifconfig((AP_IP, '255.255.255.0', AP_IP, AP_IP))
    PORTAL_HOST = AP_IP


def run(controller=None, force_ap=False):
    global PORTAL_HOST, _started
    if _started:
        return
    _started = True
    values = _config()
    station = network.WLAN(network.STA_IF)
    if values['ssid'] and not force_ap:
        station.active(True)
    else:
        try:
            station.disconnect()
        except Exception:
            pass
        station.active(False)
    ap = network.WLAN(network.AP_IF)
    ap.active(False)
    server = socket.socket()
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(('0.0.0.0', 80))
    server.listen(2)
    server.settimeout(0.2)
    while True:
        if station.isconnected() and not force_ap:
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
            data = client.recv(512)
            end = data.find(b'\r\n\r\n')
            while end < 0:
                data += client.recv(512)
                end = data.find(b'\r\n\r\n')
            headers = data[:end].decode()
            body = data[end + 4:]
            length = 0
            for line in headers.split('\r\n')[1:]:
                if line.lower().startswith('content-length:'):
                    length = int(line.split(':', 1)[1].strip())
            if length > 1024:
                raise ValueError('Formulario demasiado grande')
            while len(body) < length:
                body += client.recv(512)
            request = headers + '\r\n\r\n' + body.decode()
            if request.startswith('POST /save'):
                _write_config(_form(body.decode()))
                _send(client, '<h1>Guardado</h1><p>Reiniciando...</p>')
                client.close()
                time.sleep_ms(250)
                machine.reset()
            else:
                _send(client, _page())
        except Exception as error:
            try:
                _send(client, '<h1>Error</h1><p>{}</p>'.format(_html(error)), '400 Bad Request')
            except Exception:
                pass
        finally:
            client.close()


def start_background(controller=None, force_ap=False):
    _thread.stack_size(8192)
    _thread.start_new_thread(run, (controller, force_ap))
