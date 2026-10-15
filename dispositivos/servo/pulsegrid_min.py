import os, socket, time, ujson
try:
    import ota_boot
except ImportError:
    ota_boot = None
try:
    import ussl as tls
except ImportError:
    try: import ssl as tls
    except ImportError: tls = None
try:
    from pulsegrid_config import API_URL, API_KEY, DEVICE_ID, COMMANDS_ENABLED
except ImportError:
    API_URL, API_KEY, DEVICE_ID, COMMANDS_ENABLED = '', '', '', False
TELEMETRY_PATH = '/api/telemetry'
COMMANDS_PATH = '/api/device-commands'
FIRMWARE_TARGET = 'servo'
FIRMWARE_FILES = ('main.py', 'pulsegrid_min.py', 'webserver_min.py', 'cortina.py', 'stservo.py', 'ssd1306.py', 'boot.py', 'ota_boot.py')
_last_report = _last_poll = _retry_at = 0
_pending_configuration = _restart_requested = None
_retry_ms = 30000

def _configured(): return bool(API_URL and API_KEY and DEVICE_ID)

def _unchunk(value):
    output, offset = b'', 0
    while offset < len(value):
        end = value.find(b'\r\n', offset)
        if end < 0: break
        size = int(value[offset:end], 16)
        if not size: break
        start = end + 2
        output += value[start:start + size]
        offset = start + size + 2
    return output

def _connection(timeout):
    secure = API_URL.startswith('https://')
    address = API_URL.split('://', 1)[-1].split('/', 1)[0]
    parts = address.split(':', 1)
    host = parts[0]
    port = int(parts[1]) if len(parts) > 1 else (443 if secure else 80)
    client = socket.socket()
    client.settimeout(timeout)
    client.connect((host, port))
    if secure:
        if tls is None: raise RuntimeError('TLS no disponible en este firmware')
        client = tls.wrap_socket(client, server_hostname=host)
    return client, host

def _request(path, payload=None):
    client, host = _connection(5)
    try:
        body = ujson.dumps(payload) if payload is not None else ''
        method = 'POST' if payload is not None else 'GET'
        request = '{} {} HTTP/1.1\r\nHost: {}\r\nX-API-Key: {}\r\nConnection: close\r\n'.format(method, path, host, API_KEY)
        if body: request += 'Content-Type: application/json\r\nContent-Length: {}\r\n'.format(len(body))
        client.send((request + '\r\n' + body).encode())
        result = b''
        while True:
            chunk = client.recv(512)
            if not chunk: break
            result += chunk
        separator = result.find(b'\r\n\r\n')
        status = int(result[9:12]) if len(result) >= 12 else 0
        if status < 200 or status >= 300: raise ValueError('HTTP {}'.format(status))
        body = result[separator + 4:] if separator >= 0 else b''
        if b'transfer-encoding: chunked' in result[:separator].lower(): body = _unchunk(body)
        return ujson.loads(body) if body else {}
    finally:
        client.close()

def _post(path, payload): return _request(path, payload)
def _get(path): return _request(path)

def configure(api_url, api_key, device_id, commands_enabled=False):
    global API_URL, API_KEY, DEVICE_ID, COMMANDS_ENABLED
    api_url, api_key, device_id = str(api_url or '').strip().rstrip('/'), str(api_key or '').strip(), str(device_id or '').strip()
    if not api_url or not api_key or not device_id: raise ValueError('URL, API key y device ID son obligatorios')
    content = "API_URL={!r}\nAPI_KEY={!r}\nDEVICE_ID={!r}\nCOMMANDS_ENABLED={!r}\n".format(api_url, api_key, device_id, bool(commands_enabled))
    with open('pulsegrid_config.py.tmp', 'w') as target: target.write(content)
    try: os.remove('pulsegrid_config.py')
    except OSError: pass
    os.rename('pulsegrid_config.py.tmp', 'pulsegrid_config.py')
    API_URL, API_KEY, DEVICE_ID, COMMANDS_ENABLED = api_url, api_key, device_id, bool(commands_enabled)
    return {'apiUrl': API_URL, 'deviceId': DEVICE_ID, 'commandsEnabled': COMMANDS_ENABLED}

def _download(version, info):
    import uhashlib
    name = str(info.get('name', ''))
    if name not in FIRMWARE_FILES: raise ValueError('Archivo de firmware invalido: ' + name)
    stage_name = ota_boot.stage_path(name)
    client = None
    try:
        client, host = _connection(10)
        path = '/api/firmware/files/{}/{}?targetModel={}'.format(version, name, FIRMWARE_TARGET)
        client.send('GET {} HTTP/1.1\r\nHost: {}\r\nX-API-Key: {}\r\nConnection: close\r\n\r\n'.format(path, host, API_KEY).encode())
        header = b''
        while b'\r\n\r\n' not in header:
            chunk = client.recv(256)
            if not chunk: break
            header += chunk
            if len(header) > 2048: raise ValueError('Encabezado HTTP demasiado grande')
        separator = header.find(b'\r\n\r\n')
        if separator < 0 or header[9:12] != b'200': raise ValueError('Descarga HTTP para ' + name)
        if b'transfer-encoding: chunked' in header[:separator].lower(): raise ValueError('OTA requiere Content-Length')
        content_length = None
        for line in header[:separator].lower().split(b'\r\n'):
            if line.startswith(b'content-length:'):
                content_length = int(line.split(b':', 1)[1].strip())
        expected_length = int(info.get('size', content_length or 0))
        if content_length is None or content_length != expected_length:
            raise ValueError('Tamano OTA no coincide para ' + name)
        digest = uhashlib.sha256()
        received = 0
        with open(stage_name, 'wb') as target:
            chunk = header[separator + 4:]
            while chunk:
                if received + len(chunk) > expected_length:
                    raise ValueError('Respuesta OTA excede el tamano declarado para ' + name)
                target.write(chunk)
                digest.update(chunk)
                received += len(chunk)
                chunk = client.recv(512)
        if received != expected_length:
            raise ValueError('Descarga OTA incompleta para ' + name)
        actual_hash = ''.join('{:02x}'.format(value) for value in digest.digest())
        if actual_hash != info.get('sha256'): raise ValueError('Hash invalido para ' + name)
        return stage_name
    except Exception:
        try: os.remove(stage_name)
        except OSError: pass
        raise
    finally:
        if client: client.close()

def _update_firmware(version):
    import ota_boot
    manifest = _get('/api/firmware/manifest?version={}&targetModel={}'.format(version, FIRMWARE_TARGET))
    if manifest.get('version') != version or manifest.get('targetModel') not in (FIRMWARE_TARGET, 'Todos los dispositivos'): raise ValueError('Version de firmware no coincide con servo')
    files = manifest.get('files', [])
    if not files: raise ValueError('Manifest OTA vacio')
    total_bytes = sum(int(info.get('size', 0)) for info in files)
    ota_boot.begin(version, total_bytes)
    staged = []
    for info in files:
        name = str(info.get('name', ''))
        _download(version, info)
        staged.append(name)
    version_stage = ota_boot.stage_path('pulsegrid_firmware.py')
    with open(version_stage, 'w') as version_file: version_file.write('VERSION = {!r}\n'.format(version))
    staged.append('pulsegrid_firmware.py')
    ota_boot.ready(version, staged)


def _status(cortina):
    servos = {}
    for servo_id in cortina.servo_ids:
        values = cortina.multiturn_status(servo_id)
        values['position'] = cortina.position(servo_id)
        servos[str(servo_id)] = values
    try:
        from pulsegrid_firmware import VERSION
        firmware_version = VERSION
    except (ImportError, AttributeError):
        firmware_version = 'unversioned'
    return {'deviceId': DEVICE_ID, 'kind': 'curtain', 'firmwareTarget': FIRMWARE_TARGET, 'firmwareVersion': firmware_version, 'directionReversed': bool(cortina.direction_reversed), 'online': True, 'servos': servos}


def _ack(command_id, status, error=None):
    payload = {'deviceId': DEVICE_ID, 'status': status}
    if error:
        payload['error'] = str(error)[:500]
    _post(COMMANDS_PATH + '/' + str(command_id) + '/ack', payload)


def _execute(cortina, command):
    global _pending_configuration, _restart_requested
    name = command.get('name')
    payload = command.get('payload') or {}
    if name == 'device.configure':
        _pending_configuration = (str(payload.get('apiUrl', '')).strip(), str(payload.get('apiKey', '')).strip() or API_KEY, str(payload.get('deviceId', '')).strip())
        if not all(_pending_configuration): raise ValueError('Configuracion incompleta')
        if 'reversed' in payload: cortina.set_direction_reversed(bool(payload['reversed']))
    elif name == 'direction.configure':
        if not isinstance(payload.get('reversed'), bool): raise ValueError('reversed debe ser booleano')
        cortina.set_direction_reversed(payload['reversed'])
    elif name == 'curtain.open':
        cortina.abrir(int(payload.get('speed', 800)), int(payload.get('acceleration', 50)))
    elif name == 'curtain.close':
        cortina.cerrar(int(payload.get('speed', 800)), int(payload.get('acceleration', 50)))
    elif name == 'curtain.stop':
        cortina.parar()
    elif name == 'curtain.move':
        cortina.move_blind(int(payload.get('servoId', 1)), float(payload['percent']), int(payload.get('speed', 800)), int(payload.get('acceleration', 50)))
    elif name == 'firmware.update':
        _update_firmware(str(payload.get('version', '')))
        _restart_requested = True
    else:
        raise ValueError('Comando no permitido: ' + str(name))

def _apply_pending():
    global _pending_configuration, API_URL, API_KEY, DEVICE_ID
    if _pending_configuration:
        API_URL, API_KEY, DEVICE_ID = _pending_configuration
        _pending_configuration = None


def sync(cortina):
    global _last_report, _last_poll, _retry_at, _restart_requested
    if not _configured() or time.ticks_diff(time.ticks_ms(), _retry_at) < 0:
        return
    now = time.ticks_ms()
    try:
        if time.ticks_diff(now, _last_report) >= 5000:
            _post(TELEMETRY_PATH, _status(cortina))
            _last_report = now
        if COMMANDS_ENABLED and time.ticks_diff(now, _last_poll) >= 3000:
            _last_poll = now
            result = _get(COMMANDS_PATH + '?deviceId=' + DEVICE_ID)
            command = result.get('command') if result else None
            if command:
                try:
                    _execute(cortina, command)
                    _ack(command['id'], 'succeeded')
                    if command.get('name') == 'firmware.update':
                        print('OTA completada; reiniciando')
                        time.sleep_ms(250)
                        import machine
                        machine.reset()
                        return
                    _apply_pending()
                    if _restart_requested:
                        _restart_requested = False
                        import machine
                        machine.reset()
                except Exception as error:
                    _ack(command['id'], 'failed', error)
    except Exception as error:
        error_text = str(error)
        if 'MBEDTLS_ERR_SSL' in error_text or 'SSL' in error_text:
            print('Pulsegrid TLS incompatible con el servidor: ' + error_text)
        else:
            print('Pulsegrid:', error_text)
        _retry_at = time.ticks_add(time.ticks_ms(), _retry_ms)
