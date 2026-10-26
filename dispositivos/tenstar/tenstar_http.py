import gc
import json
import socket


def _recv(client, size):
    reader = getattr(client, 'read', None)
    return reader(size) if reader else client.recv(size)


def _send_all(client, data):
    sent = 0
    while sent < len(data):
        writer = getattr(client, 'write', None)
        count = writer(data[sent:]) if writer else client.send(data[sent:])
        if count is None or count <= 0:
            raise OSError('Envio HTTP incompleto')
        sent += count


def _read_until(client, buffer, marker, limit):
    while marker not in buffer:
        chunk = _recv(client, 256)
        if not chunk:
            raise ValueError('Respuesta HTTP incompleta')
        buffer += chunk
        if marker not in buffer and len(buffer) > limit:
            raise ValueError('Respuesta HTTP demasiado grande')
    index = buffer.find(marker)
    if index > limit:
        raise ValueError('Encabezado HTTP demasiado grande')
    return buffer[:index], buffer[index + len(marker):]


def _read_response(client):
    header, body = _read_until(client, b'', b'\r\n\r\n', 4096)
    lines = header.split(b'\r\n')
    status = int(lines[0].split(b' ', 2)[1])
    headers = {}
    for line in lines[1:]:
        if b':' in line:
            key, value = line.split(b':', 1)
            headers[key.strip().lower()] = value.strip().lower()
    if b'chunked' in headers.get(b'transfer-encoding', b''):
        decoded = bytearray()
        while True:
            line, body = _read_until(client, body, b'\r\n', 128)
            size = int(line.split(b';', 1)[0].strip(), 16)
            if size < 0 or len(decoded) + size > 20000:
                raise ValueError('Respuesta HTTP demasiado grande')
            if size == 0:
                while True:
                    trailer, body = _read_until(client, body, b'\r\n', 1024)
                    if not trailer:
                        break
                break
            while len(body) < size + 2:
                part = _recv(client, min(512, size + 2 - len(body)))
                if not part:
                    raise ValueError('Respuesta chunked incompleta')
                body += part
            if body[size:size + 2] != b'\r\n':
                raise ValueError('Separador chunked invalido')
            decoded.extend(body[:size])
            body = body[size + 2:]
        body = bytes(decoded)
    elif b'content-length' in headers:
        length = int(headers[b'content-length'])
        if length < 0 or length > 20000:
            raise ValueError('Longitud HTTP fuera de rango')
        while len(body) < length:
            part = _recv(client, min(512, length - len(body)))
            if not part:
                raise ValueError('Respuesta HTTP incompleta')
            body += part
        body = body[:length]
    elif status != 204:
        while True:
            part = _recv(client, 512)
            if not part:
                break
            body += part
            if len(body) > 20000:
                raise ValueError('Respuesta HTTP demasiado grande')
    if status < 200 or status >= 300:
        detail = body[:200].decode()
        raise ValueError('HTTP {}: {}'.format(status, detail))
    return json.loads(body.decode()) if body else {}


def request(api_url, device_code, method, path, payload=None, timeout=5):
    client = None
    phase = 'configuracion'
    try:
        if not api_url.startswith('https://'):
            raise ValueError('API_URL debe usar HTTPS; revisar config.py con Quemador')
        authority, _, prefix = api_url.split('://', 1)[1].partition('/')
        parts = authority.split(':', 1)
        host = parts[0]
        port = int(parts[1]) if len(parts) > 1 else 443
        path = ('/' + prefix.rstrip('/') if prefix else '') + path
        phase = 'DNS'
        address = socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM)[0][-1]
        client = socket.socket()
        client.settimeout(timeout)
        phase = 'TCP'
        client.connect(address)
        phase = 'TLS'
        try:
            import ussl as tls
        except ImportError:
            import ssl as tls
        gc.collect()
        client = tls.wrap_socket(client, server_hostname=host)
        body = json.dumps(payload) if payload is not None else ''
        headers = 'Connection: close\r\nX-Device-Code: {}\r\n'.format(device_code)
        if body:
            headers += 'Content-Type: application/json\r\nContent-Length: {}\r\n'.format(len(body.encode()))
        phase = 'HTTP'
        message = '{} {} HTTP/1.1\r\nHost: {}\r\n{}\r\n{}'.format(method, path, authority, headers, body)
        _send_all(client, message.encode())
        return _read_response(client)
    except Exception as error:
        raise OSError('{}: {}'.format(phase, error))
    finally:
        if client:
            try:
                client.close()
            except OSError as error:
                print('Cloud cierre de conexion:', error)
        gc.collect()
