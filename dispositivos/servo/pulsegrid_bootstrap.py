import gc
import socket

try:
    import ujson as json
except ImportError:
    import json

try:
    import ussl as tls
except ImportError:
    try:
        import ssl as tls
    except ImportError:
        tls = None

BOOTSTRAP_API_KEY = 'pg_bootstrap_v1'


def fetch(api_url, device_id, timeout=8):
    gc.collect()
    secure = api_url.startswith('https://')
    address = api_url.split('://', 1)[-1].split('/', 1)[0]
    parts = address.split(':', 1)
    host = parts[0]
    port = int(parts[1]) if len(parts) > 1 else (443 if secure else 80)
    client = None
    try:
        client = socket.socket()
        client.settimeout(timeout)
        client.connect((host, port))
        if secure:
            if tls is None:
                raise RuntimeError('TLS no disponible en este firmware')
            client = tls.wrap_socket(client, server_hostname=host)
        path = '/api/device-bootstrap?deviceId=' + str(device_id)
        request = 'GET {} HTTP/1.1\r\nHost: {}\r\nX-API-Key: {}\r\nConnection: close\r\n\r\n'.format(path, host, BOOTSTRAP_API_KEY)
        client.send(request.encode())
        header = b''
        while b'\r\n\r\n' not in header:
            chunk = client.recv(256)
            if not chunk:
                break
            header += chunk
            if len(header) > 2048:
                raise ValueError('Encabezado bootstrap demasiado grande')
        separator = header.find(b'\r\n\r\n')
        if separator < 0:
            raise ValueError('Respuesta bootstrap incompleta')
        status = int(header[9:12]) if len(header) >= 12 else 0
        if status < 200 or status >= 300:
            raise ValueError('Bootstrap HTTP {}'.format(status))
        body = header[separator + 4:]
        while len(body) < 4096:
            content_length = None
            for line in header[:separator].lower().split(b'\r\n'):
                if line.startswith(b'content-length:'):
                    content_length = int(line.split(b':', 1)[1].strip())
                    break
            if content_length is not None and len(body) >= content_length:
                break
            chunk = client.recv(256)
            if not chunk:
                break
            body += chunk
            if content_length is None and len(body) >= 4096:
                break
        return json.loads(body) if body else {}
    finally:
        if client:
            client.close()
        gc.collect()
