import importlib.util
import json
import pathlib
import sys
import types
import unittest


SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'cloud_client.py'


class FakeTime:
    now = 100000

    @classmethod
    def ticks_ms(cls):
        return cls.now

    @staticmethod
    def ticks_diff(first, second):
        return first - second

    @staticmethod
    def ticks_add(first, delta):
        return first + delta


class FakeSocket:
    instances = []
    responses = []

    def __init__(self):
        self.requests = []
        self.response = b''
        self.closed = False
        self.timeout = None
        self.__class__.instances.append(self)

    def setsockopt(self, *_args):
        pass

    def settimeout(self, timeout):
        self.timeout = timeout

    def connect(self, _address):
        pass

    def write(self, data):
        self.requests.append(data)
        self.response += self.__class__.responses.pop(0)
        return len(data)

    def read(self, size):
        chunk = self.response[:size]
        self.response = self.response[size:]
        return chunk

    def close(self):
        self.closed = True


class FakeSocketModule(types.ModuleType):
    SOL_SOCKET = 1
    SO_RCVBUF = 2
    SO_SNDBUF = 3

    def __init__(self):
        super().__init__('socket')
        self.created = 0

    def socket(self):
        self.created += 1
        return FakeSocket()


class CloudClientConnectionTests(unittest.TestCase):
    def setUp(self):
        self.previous_modules = {name: sys.modules.get(name) for name in ('socket', 'time', 'ujson', 'ussl')}
        FakeSocket.instances = []
        FakeSocket.responses = []
        FakeTime.now = 100000
        self.socket_module = FakeSocketModule()
        self.tls_module = types.ModuleType('ussl')
        self.tls_module.handshakes = 0

        def wrap_socket(sock, server_hostname=None):
            self.tls_module.handshakes += 1
            return sock

        self.tls_module.wrap_socket = wrap_socket
        json_module = types.ModuleType('ujson')
        json_module.dumps = json.dumps
        json_module.loads = json.loads
        sys.modules.update({
            'socket': self.socket_module,
            'time': FakeTime,
            'ujson': json_module,
            'ussl': self.tls_module,
        })
        spec = importlib.util.spec_from_file_location('cloud_client_test_subject', SOURCE)
        self.client_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.client_module)
        self.client = self.client_module.CloudClient('https://pulse.example', 'device-code', 'device-id')

    def tearDown(self):
        self.client.close()
        for name, previous in self.previous_modules.items():
            if previous is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = previous
        sys.modules.pop('cloud_client_test_subject', None)

    @staticmethod
    def response(connection='keep-alive', chunked=False):
        if chunked:
            body = b'B\r\n{"ok":true}\r\n0\r\n\r\n'
            framing = b'Transfer-Encoding: chunked\r\n'
        else:
            body = b'{"ok":true}'
            framing = b'Content-Length: 11\r\n'
        return (b'HTTP/1.1 200 OK\r\n' + framing +
                b'Connection: ' + connection.encode() + b'\r\n\r\n' + body)

    def test_successive_http_requests_reuse_the_tls_handshake(self):
        FakeSocket.responses = [self.response(), self.response()]

        self.assertEqual(self.client.request('GET', '/api/device-commands'), {'ok': True})
        self.assertEqual(self.client.request('POST', '/api/telemetry', {'v': 1}), {'ok': True})

        self.assertEqual(self.socket_module.created, 1)
        self.assertEqual(self.tls_module.handshakes, 1)
        self.assertEqual(len(FakeSocket.instances[0].requests), 2)
        self.assertIn(b'Connection: keep-alive', FakeSocket.instances[0].requests[0])
        self.assertFalse(FakeSocket.instances[0].closed)

    def test_connection_close_response_renews_tls_on_next_request(self):
        FakeSocket.responses = [self.response('close'), self.response()]

        self.assertEqual(self.client.request('GET', '/api/version'), {'ok': True})
        self.assertEqual(self.client._connection, None)
        self.assertEqual(self.client.request('GET', '/api/version'), {'ok': True})

        self.assertEqual(self.socket_module.created, 2)
        self.assertEqual(self.tls_module.handshakes, 2)
        self.assertTrue(FakeSocket.instances[0].closed)

    def test_chunked_response_is_fully_consumed_before_reuse(self):
        FakeSocket.responses = [self.response(chunked=True), self.response()]

        self.assertEqual(self.client.request('GET', '/api/version'), {'ok': True})
        self.assertEqual(self.client.request('GET', '/api/version'), {'ok': True})

        self.assertEqual(self.socket_module.created, 1)
        self.assertEqual(self.tls_module.handshakes, 1)

    def test_connection_is_renewed_after_its_maximum_lifetime(self):
        FakeSocket.responses = [self.response(), self.response()]
        self.assertEqual(self.client.request('GET', '/api/version'), {'ok': True})

        FakeTime.now += self.client_module.TLS_MAX_CONNECTION_AGE_MS
        self.assertEqual(self.client.request('GET', '/api/version'), {'ok': True})

        self.assertEqual(self.socket_module.created, 2)
        self.assertEqual(self.tls_module.handshakes, 2)
        self.assertTrue(FakeSocket.instances[0].closed)


if __name__ == '__main__':
    unittest.main()