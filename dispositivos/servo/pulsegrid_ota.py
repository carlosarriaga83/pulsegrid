import gc
import os
import socket
import ujson
import uhashlib

def _connection(api_url, timeout):
    gc.collect()
    secure = api_url.startswith('https://')
    if not secure:
        raise ValueError('HTTPS es obligatorio para Pulsegrid')
    address = api_url.split('://', 1)[-1].split('/', 1)[0]
    parts = address.split(':', 1)
    host = parts[0]
    port = int(parts[1]) if len(parts) > 1 else (443 if secure else 80)
    client = socket.socket()
    client.settimeout(timeout)
    phase = 'TCP connect'
    try:
        client.connect((host, port))
        if secure:
            gc.collect()
            phase = 'TLS module import'
            try:
                import ussl as tls
            except ImportError:
                try:
                    import ssl as tls
                except ImportError:
                    raise RuntimeError('TLS no disponible en este firmware')
            gc.collect()
            phase = 'TLS handshake'
            client = tls.wrap_socket(client, server_hostname=host)
        return client, host
    except Exception as error:
        print('OTA transporte fallo en {}: {}'.format(phase, error))
        try:
            client.close()
        except Exception:
            pass
        gc.collect()
        raise


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


def _write_chunked(client, buffer, target, digest, expected_length, name):
    received = 0
    trailer_bytes = 0
    while True:
        while b'\r\n' not in buffer:
            if len(buffer) > 64:
                raise ValueError('Tamano de bloque HTTP invalido para ' + name)
            chunk = client.recv(128)
            if not chunk:
                raise ValueError('Respuesta OTA chunked incompleta para ' + name)
            buffer += chunk
        end = buffer.find(b'\r\n')
        line = buffer[:end]
        buffer = buffer[end + 2:]
        try:
            size = int(line.split(b';', 1)[0].strip(), 16)
        except Exception:
            raise ValueError('Tamano de bloque HTTP invalido para ' + name)
        if size == 0:
            while True:
                while b'\r\n' not in buffer:
                    if len(buffer) > 512:
                        raise ValueError('Trailer HTTP demasiado grande para ' + name)
                    chunk = client.recv(128)
                    if not chunk:
                        raise ValueError('Fin chunked incompleto para ' + name)
                    buffer += chunk
                end = buffer.find(b'\r\n')
                trailer_bytes += end + 2
                if trailer_bytes > 1024:
                    raise ValueError('Trailer HTTP demasiado grande para ' + name)
                if end == 0:
                    return received
                buffer = buffer[end + 2:]
        if received + size > expected_length:
            raise ValueError('Respuesta OTA excede el tamano declarado para ' + name)
        remaining = size
        while remaining:
            if not buffer:
                buffer = client.recv(512)
                if not buffer:
                    raise ValueError('Descarga OTA incompleta para ' + name)
            count = min(remaining, len(buffer))
            part = buffer[:count]
            target.write(part)
            digest.update(part)
            received += count
            remaining -= count
            buffer = buffer[count:]
        while len(buffer) < 2:
            chunk = client.recv(128)
            if not chunk:
                raise ValueError('Separador chunked incompleto para ' + name)
            buffer += chunk
        if buffer[:2] != b'\r\n':
            raise ValueError('Separador chunked invalido para ' + name)
        buffer = buffer[2:]


def _write_sized(client, buffer, target, digest, expected_length, name):
    received = 0
    while received < expected_length:
        if not buffer:
            buffer = client.recv(512)
            if not buffer:
                break
        count = min(expected_length - received, len(buffer))
        part = buffer[:count]
        target.write(part)
        digest.update(part)
        received += count
        buffer = buffer[count:]
        if buffer and received == expected_length:
            raise ValueError('Respuesta OTA excede el tamano declarado para ' + name)
    if received != expected_length:
        raise ValueError('Descarga OTA incompleta para ' + name)
    return received


def _request(api_url, device_code, path):
    client, host = _connection(api_url, 30)
    try:
        client.send('GET {} HTTP/1.1\r\nHost: {}\r\nX-Device-Code: {}\r\nConnection: close\r\n\r\n'.format(path, host, device_code).encode())
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


def _is_timeout(error):
    code = getattr(error, 'errno', None)
    message = str(error).upper()
    return code in (110, 116) or 'ETIMEDOUT' in message or 'TIMED OUT' in message


def _download(api_url, device_code, device_id, version, info, target_model, allowed_files, ota_boot):
    name = str(info.get('name', ''))
    if name not in allowed_files:
        raise ValueError('Archivo de firmware invalido: ' + name)
    stage_name = ota_boot.stage_path(name)
    client = None
    try:
        client, host = _connection(api_url, 30)
        path = '/api/firmware/files/{}/{}?targetModel={}&deviceId={}'.format(version, name, target_model, device_id)
        client.send('GET {} HTTP/1.1\r\nHost: {}\r\nX-Device-Code: {}\r\nConnection: close\r\n\r\n'.format(path, host, device_code).encode())
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
        response_headers = header[:separator].lower()
        chunked = b'transfer-encoding: chunked' in response_headers
        content_length = None
        for line in response_headers.split(b'\r\n'):
            if line.startswith(b'content-length:'):
                content_length = int(line.split(b':', 1)[1].strip())
        expected_length = int(info.get('size', 0))
        if expected_length < 0 or (content_length is not None and content_length != expected_length):
            raise ValueError('Tamano OTA no coincide para ' + name)
        digest = uhashlib.sha256()
        with open(stage_name, 'wb') as target:
            body = header[separator + 4:]
            if chunked:
                received = _write_chunked(client, body, target, digest, expected_length, name)
            else:
                received = _write_sized(client, body, target, digest, expected_length, name)
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
        gc.collect()


def update(api_url, device_code, device_id, version, target_model, allowed_files):
    import ota_boot
    print('OTA servo: consultando manifiesto')
    manifest_path = '/api/firmware/manifest?version={}&targetModel={}&deviceId={}'.format(version, target_model, device_id)
    for attempt in range(2):
        try:
            manifest = _request(api_url, device_code, manifest_path)
            break
        except Exception as error:
            if attempt or not _is_timeout(error):
                raise OSError('OTA fallo al consultar manifiesto: {}'.format(error))
            print('OTA servo: timeout del manifiesto; reintentando una vez')
    if manifest.get('version') != version or manifest.get('targetModel') not in (target_model, 'Todos los dispositivos'):
        raise ValueError('Version de firmware no coincide con servo')
    files = manifest.get('files', [])
    if not files:
        raise ValueError('Manifest OTA vacio')
    total_bytes = sum(int(info.get('size', 0)) for info in files)
    ota_boot.begin(version, total_bytes)
    staged = []
    for info in files:
        name = str(info.get('name', ''))
        print('OTA servo: descargando', name)
        for attempt in range(2):
            try:
                _download(api_url, device_code, device_id, version, info, target_model, allowed_files, ota_boot)
                break
            except Exception as error:
                if attempt or not _is_timeout(error):
                    raise OSError('OTA fallo en {}: {}'.format(name, error))
                print('OTA servo: timeout en {}; reintentando una vez'.format(name))
        staged.append(str(info.get('name', '')))
        gc.collect()
    version_stage = ota_boot.stage_path('pulsegrid_firmware.py')
    with open(version_stage, 'w') as version_file:
        version_file.write('VERSION = {!r}\n'.format(version))
    staged.append('pulsegrid_firmware.py')
    ota_boot.ready(version, staged)
    print('OTA servo: archivos verificados; activando', version)
