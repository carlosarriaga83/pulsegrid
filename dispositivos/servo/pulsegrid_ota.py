import gc
import os
import socket
import ujson
import uhashlib

try:
    import ussl as tls
except ImportError:
    try:
        import ssl as tls
    except ImportError:
        tls = None


def _connection(api_url, timeout):
    gc.collect()
    secure = api_url.startswith('https://')
    address = api_url.split('://', 1)[-1].split('/', 1)[0]
    parts = address.split(':', 1)
    host = parts[0]
    port = int(parts[1]) if len(parts) > 1 else (443 if secure else 80)
    client = socket.socket()
    client.settimeout(timeout)
    client.connect((host, port))
    if secure:
        if tls is None:
            raise RuntimeError('TLS no disponible en este firmware')
        client = tls.wrap_socket(client, server_hostname=host)
    return client, host


def _unchunk(value):
    output, offset = b'', 0
    while offset < len(value):
        end = value.find(b'\r\n', offset)
        if end < 0:
            break
        size = int(value[offset:end], 16)
        if not size:
            break
        start = end + 2
        output += value[start:start + size]
        offset = start + size + 2
    return output


def _request(api_url, api_key, path):
    client, host = _connection(api_url, 10)
    try:
        client.send('GET {} HTTP/1.1\r\nHost: {}\r\nX-API-Key: {}\r\nConnection: close\r\n\r\n'.format(path, host, api_key).encode())
        result = b''
        while True:
            chunk = client.recv(512)
            if not chunk:
                break
            result += chunk
        separator = result.find(b'\r\n\r\n')
        status = int(result[9:12]) if len(result) >= 12 else 0
        if status < 200 or status >= 300:
            raise ValueError('HTTP {}'.format(status))
        body = result[separator + 4:] if separator >= 0 else b''
        if separator >= 0 and b'transfer-encoding: chunked' in result[:separator].lower():
            body = _unchunk(body)
        return ujson.loads(body) if body else {}
    finally:
        client.close()
        gc.collect()


def _download(api_url, api_key, version, info, target_model, allowed_files, ota_boot):
    name = str(info.get('name', ''))
    if name not in allowed_files:
        raise ValueError('Archivo de firmware invalido: ' + name)
    stage_name = ota_boot.stage_path(name)
    client = None
    try:
        client, host = _connection(api_url, 10)
        path = '/api/firmware/files/{}/{}?targetModel={}'.format(version, name, target_model)
        client.send('GET {} HTTP/1.1\r\nHost: {}\r\nX-API-Key: {}\r\nConnection: close\r\n\r\n'.format(path, host, api_key).encode())
        header = b''
        while b'\r\n\r\n' not in header:
            chunk = client.recv(256)
            if not chunk:
                break
            header += chunk
            if len(header) > 2048:
                raise ValueError('Encabezado HTTP demasiado grande')
        separator = header.find(b'\r\n\r\n')
        if separator < 0 or header[9:12] != b'200':
            raise ValueError('Descarga HTTP para ' + name)
        if b'transfer-encoding: chunked' in header[:separator].lower():
            raise ValueError('OTA requiere Content-Length')
        content_length = None
        for line in header[:separator].lower().split(b'\r\n'):
            if line.startswith(b'content-length:'):
                content_length = int(line.split(b':', 1)[1].strip())
                break
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
        if actual_hash != info.get('sha256'):
            raise ValueError('Hash invalido para ' + name)
        return stage_name
    except Exception:
        try:
            os.remove(stage_name)
        except OSError:
            pass
        raise
    finally:
        if client:
            client.close()


def update(api_url, api_key, version, target_model, allowed_files):
    import ota_boot
    manifest = _request(api_url, api_key, '/api/firmware/manifest?version={}&targetModel={}'.format(version, target_model))
    if manifest.get('version') != version or manifest.get('targetModel') not in (target_model, 'Todos los dispositivos'):
        raise ValueError('Version de firmware no coincide con servo')
    files = manifest.get('files', [])
    if not files:
        raise ValueError('Manifest OTA vacio')
    total_bytes = sum(int(info.get('size', 0)) for info in files)
    ota_boot.begin(version, total_bytes)
    staged = []
    for info in files:
        _download(api_url, api_key, version, info, target_model, allowed_files, ota_boot)
        staged.append(str(info.get('name', '')))
    version_stage = ota_boot.stage_path('pulsegrid_firmware.py')
    with open(version_stage, 'w') as version_file:
        version_file.write('VERSION = {!r}\n'.format(version))
    staged.append('pulsegrid_firmware.py')
    ota_boot.ready(version, staged)
