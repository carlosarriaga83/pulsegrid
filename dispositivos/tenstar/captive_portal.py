import machine
import network
import os
import select
import socket
import time

CONFIG_FILE = 'config.py'
AP_IP = '192.168.4.1'


def _exists(name):
    try:
        os.stat(name)
        return True
    except OSError:
        return False


def recover_config_file():
    backup = CONFIG_FILE + '.bak'
    if not _exists(CONFIG_FILE) and _exists(backup):
        os.rename(backup, CONFIG_FILE)
        print('Portal: config.py recuperado desde respaldo')


def _html(value):
    return str(value).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;').replace("'", '&#39;')


def _decode(value):
    value = value.replace('+', ' ')
    result = bytearray()
    index = 0
    while index < len(value):
        if value[index] == '%' and index + 2 < len(value):
            result.append(int(value[index + 1:index + 3], 16))
            index += 3
        else:
            result.extend(value[index].encode())
            index += 1
    return result.decode()


def _form(body):
    values = {}
    for field in body.split('&'):
        if '=' in field:
            key, value = field.split('=', 1)
            values[_decode(key)] = _decode(value)
    return values


def _write_config(values):
    ssid = values.get('ssid', '').strip()
    if not ssid or len(ssid.encode()) > 32:
        raise ValueError('SSID obligatorio, maximo 32 bytes')
    password = values.get('password', '')
    if password and not 8 <= len(password.encode()) <= 63:
        raise ValueError('La clave Wi-Fi debe tener entre 8 y 63 bytes')
    recover_config_file()
    source = ''
    if _exists(CONFIG_FILE):
        with open(CONFIG_FILE, 'r') as config_file:
            source = config_file.read()
    updates = {'WIFI_SSID': ssid}
    if password or values.get('open_network') == '1':
        updates['WIFI_PASSWORD'] = password
    lines = [line for line in source.splitlines() if line.split('=', 1)[0].strip() not in updates]
    lines.extend('{} = {!r}'.format(name, value) for name, value in updates.items())
    temporary = CONFIG_FILE + '.tmp'
    backup = CONFIG_FILE + '.bak'
    with open(temporary, 'w') as config_file:
        config_file.write('\n'.join(lines) + '\n')
    if _exists(backup):
        os.remove(backup)
    if _exists(CONFIG_FILE):
        os.rename(CONFIG_FILE, backup)
    try:
        os.rename(temporary, CONFIG_FILE)
    except OSError:
        recover_config_file()
        raise
    import wifi_recovery
    wifi_recovery.clear_boots()
    print('Portal: Wi-Fi guardado; identidad, encoder y calibracion conservados')


def _page():
    try:
        import config
        ssid = getattr(config, 'WIFI_SSID', '')
        device_id = getattr(config, 'DEVICE_ID', 'Sin identidad: cargar con Quemador')
    except ImportError:
        ssid = ''
        device_id = 'Sin identidad: cargar con Quemador'
    return """<!doctype html><meta name=viewport content="width=device-width">
<title>Pulsegrid Tenstar Wi-Fi</title>
<style>body{{font:16px sans-serif;max-width:520px;margin:30px auto;padding:16px}}label{{display:block;margin:16px 0}}input:not([type=checkbox]),button{{box-sizing:border-box;width:100%;padding:12px}}small{{display:block}}</style>
<h1>Pulsegrid Tenstar</h1><p>{device_id}</p><h2>Configurar Wi-Fi</h2>
<form method=post action=/save><label>Red Wi-Fi<input name=ssid required maxlength=32 value="{ssid}"></label>
<label>Clave Wi-Fi<input name=password type=password autocomplete=new-password placeholder="En blanco conserva la actual"></label>
<label><input name=open_network type=checkbox value=1> Red abierta (borrar clave)</label>
<button>Guardar y reiniciar</button></form>
<p>La identidad y la calibracion se conservan. La calibracion se realiza desde Pulsegrid Cloud.</p>""".format(device_id=_html(device_id), ssid=_html(ssid))


def _send(client, body, status='200 OK'):
    body = body.encode()
    client.sendall(('HTTP/1.1 {}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n'.format(status, len(body))).encode() + body)


class Portal:
    def __init__(self, station, force_ap=False):
        self.station = station
        self.force_ap = force_ap
        self.ap = network.WLAN(network.AP_IF)
        self.ap.active(False)
        self.host = None
        self.server = socket.socket()
        self.server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.server.bind(('0.0.0.0', 80))
        self.server.listen(2)
        self.poller = select.poll()
        self.poller.register(self.server, select.POLLIN)
        self.update_network()

    def update_network(self):
        if self.station.isconnected() and not self.force_ap:
            if self.ap.active():
                self.ap.active(False)
            host = self.station.ifconfig()[0]
        else:
            if not self.ap.active():
                self.ap.active(True)
                suffix = ''.join('{:02X}'.format(value) for value in self.ap.config('mac')[-2:])
                ssid = 'Pulsegrid-Tenstar-' + suffix
                self.ap.config(essid=ssid, authmode=network.AUTH_OPEN, max_clients=2)
                self.ap.ifconfig((AP_IP, '255.255.255.0', AP_IP, AP_IP))
                print('Portal: red {} (abierta, solo configuracion Wi-Fi)'.format(ssid))
            host = AP_IP
        if host != self.host:
            self.host = host
            print('Portal Tenstar: http://{}/'.format(host))

    def poll(self, allow_save=True):
        self.update_network()
        if not self.poller.poll(0):
            return
        client, _ = self.server.accept()
        try:
            client.settimeout(2)
            data = b''
            while b'\r\n\r\n' not in data:
                chunk = client.recv(256)
                if not chunk:
                    raise ValueError('Solicitud HTTP incompleta')
                data += chunk
                if len(data) > 2048:
                    raise ValueError('Encabezado HTTP demasiado grande')
            header, body = data.split(b'\r\n\r\n', 1)
            lines = header.decode().split('\r\n')
            length = 0
            for line in lines[1:]:
                if line.lower().startswith('content-length:'):
                    length = int(line.split(':', 1)[1].strip())
            if length < 0 or length > 1024:
                raise ValueError('Formulario demasiado grande')
            while len(body) < length:
                chunk = client.recv(min(256, length - len(body)))
                if not chunk:
                    raise ValueError('Formulario incompleto')
                body += chunk
            if lines[0].startswith('POST /save '):
                if not allow_save:
                    raise ValueError('Deten el motor antes de guardar Wi-Fi')
                _write_config(_form(body[:length].decode()))
                _send(client, '<h1>Guardado</h1><p>Reiniciando Tenstar...</p>')
                client.close()
                time.sleep_ms(250)
                machine.reset()
            else:
                _send(client, _page())
        except (OSError, ValueError) as error:
            print('Portal Tenstar:', error)
            try:
                _send(client, '<h1>Error</h1><p>{}</p>'.format(_html(error)), '400 Bad Request')
            except OSError as send_error:
                print('Portal respuesta:', send_error)
        finally:
            client.close()
