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
    connect_failures = set()

    def __init__(self):
        self.requests = []
        self.response = b''
        self.closed = False
        self.timeout = None
        self.options = []
        self.__class__.instances.append(self)

    def setsockopt(self, *args):
        self.options.append(args)

    def settimeout(self, timeout):
        self.timeout = timeout

    def connect(self, address):
        if address[0] in self.__class__.connect_failures:
            raise OSError(116, 'ETIMEDOUT')

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
    SOCK_STREAM = 1

    def __init__(self):
        super().__init__('socket')
        self.created = 0
        self.addresses = [('192.0.2.10', 443)]

    def getaddrinfo(self, _host, port, *_args):
        return [(2, self.SOCK_STREAM, 6, '', (address, port)) for address, _ in self.addresses]

    def socket(self):
        self.created += 1
        return FakeSocket()


class CloudClientConnectionTests(unittest.TestCase):
    def setUp(self):
        self.previous_modules = {name: sys.modules.get(name) for name in ('socket', 'time', 'ujson', 'ussl')}
        FakeSocket.instances = []
        FakeSocket.responses = []
        FakeSocket.connect_failures = set()
        FakeTime.now = 100000
        self.socket_module = FakeSocketModule()
        self.tls_module = types.ModuleType('ussl')
        self.tls_module.handshakes = 0
        self.tls_module.server_names = []

        def wrap_socket(sock, server_hostname=None):
            self.tls_module.handshakes += 1
            self.tls_module.server_names.append(server_hostname)
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

    def test_curtain_move_can_target_all_detected_servos_or_one_legacy_servo(self):
        class FakeCurtain:
            servo_ids = (1, 2)
            blind_config = {1: {'calibration_in_progress': False}, 2: {'calibration_in_progress': False}}

            def __init__(self):
                self.moves = []

            def move_blind(self, servo_id, percent, speed, acceleration):
                self.moves.append((servo_id, percent, speed, acceleration))

        curtain = FakeCurtain()
        self.client._execute_command(curtain, None, {'name': 'curtain.move', 'payload': {'allServos': True, 'percent': 62, 'speed': 700, 'acceleration': 40}})
        self.assertEqual(curtain.moves, [(1, 62.0, 700, 40), (2, 62.0, 700, 40)])

        curtain.moves.clear()
        self.client._execute_command(curtain, None, {'name': 'curtain.move', 'payload': {'servoId': 2, 'percent': 35}})
        self.assertEqual(curtain.moves, [(2, 35.0, 800, 50)])

    def test_motion_ack_reports_encoder_timeout_as_failed_instead_of_succeeded(self):
        class FakeCurtain:
            servo_ids = (1,)
            blind_config = {1: {'calibration_in_progress': False}}

            def __init__(self):
                self.multiturn_tasks = {1: None}
                self.multiturn_active = {1: False}

            def move_blind(self, _servo_id, _percent, _speed, _acceleration):
                self.multiturn_tasks[1] = {'target_counts': 700}
                self.multiturn_active[1] = True

        def http_response(payload):
            body = json.dumps(payload).encode()
            return b'HTTP/1.1 200 OK\r\nContent-Length: ' + str(len(body)).encode() + b'\r\nConnection: close\r\n\r\n' + body

        curtain = FakeCurtain()
        FakeSocket.responses = [http_response({'command': {
            'id': 'move-1', 'name': 'curtain.move', 'payload': {'percent': 53},
        }})]
        self.client.commands(curtain, None)
        self.assertIsNotNone(self.client._pending_ack)
        self.assertEqual(len(self.client._pending_ack[3]), 1)

        self.client.flush_ack(curtain)
        self.assertEqual(len(FakeSocket.instances), 1, 'ACK must wait for the movement result')

        task = curtain.multiturn_tasks[1]
        task.update({'completed': False, 'timed_out': True, 'fault_reason': 'movement_timeout'})
        curtain.multiturn_tasks[1] = None
        curtain.multiturn_active[1] = False
        FakeSocket.responses = [http_response({'ok': True})]
        self.client.flush_ack(curtain)

        ack_request = b''.join(FakeSocket.instances[-1].requests)
        self.assertIn(b'"status": "failed"', ack_request)
        self.assertIn(b'"error": "se excedio el tiempo maximo de movimiento"', ack_request)

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

    def test_successive_http_requests_open_fresh_tls_connections(self):
        FakeSocket.responses = [self.response(), self.response()]

        self.assertEqual(self.client.request('GET', '/api/device-commands'), {'ok': True})
        self.assertEqual(self.client.request('POST', '/api/telemetry', {'v': 1}), {'ok': True})

        self.assertEqual(self.socket_module.created, 2)
        self.assertEqual(self.tls_module.handshakes, 2)
        self.assertEqual(len(FakeSocket.instances[0].requests), 1)
        self.assertEqual(len(FakeSocket.instances[1].requests), 1)
        self.assertIn(b'Connection: close', FakeSocket.instances[0].requests[0])
        self.assertEqual(FakeSocket.instances[0].options, [])
        self.assertTrue(FakeSocket.instances[0].closed)
        self.assertTrue(FakeSocket.instances[1].closed)

    def test_connection_close_response_renews_tls_on_next_request(self):
        FakeSocket.responses = [self.response('close'), self.response()]

        self.assertEqual(self.client.request('GET', '/api/version'), {'ok': True})
        self.assertEqual(self.client._connection, None)
        self.assertEqual(self.client.request('GET', '/api/version'), {'ok': True})

        self.assertEqual(self.socket_module.created, 2)
        self.assertEqual(self.tls_module.handshakes, 2)
        self.assertTrue(FakeSocket.instances[0].closed)

    def test_chunked_response_is_fully_consumed_before_connection_close(self):
        FakeSocket.responses = [self.response(chunked=True), self.response()]

        self.assertEqual(self.client.request('GET', '/api/version'), {'ok': True})
        self.assertEqual(self.client.request('GET', '/api/version'), {'ok': True})

        self.assertEqual(self.socket_module.created, 2)
        self.assertEqual(self.tls_module.handshakes, 2)

    def test_each_request_renews_the_tls_connection(self):
        FakeSocket.responses = [self.response(), self.response()]
        self.assertEqual(self.client.request('GET', '/api/version'), {'ok': True})
        self.assertEqual(self.client.request('GET', '/api/version'), {'ok': True})

        self.assertEqual(self.socket_module.created, 2)
        self.assertEqual(self.tls_module.handshakes, 2)
        self.assertTrue(FakeSocket.instances[0].closed)

    def test_unreachable_dns_address_falls_through_to_next_address(self):
        self.socket_module.addresses = [('192.0.2.10', 443), ('198.51.100.20', 443)]
        FakeSocket.connect_failures = {'192.0.2.10'}
        FakeSocket.responses = [self.response()]

        self.assertEqual(self.client.request('GET', '/api/version'), {'ok': True})

        self.assertEqual(self.socket_module.created, 2)
        self.assertTrue(FakeSocket.instances[0].closed)
        self.assertEqual(self.tls_module.handshakes, 1)
        self.assertEqual(self.tls_module.server_names, ['pulse.example'])


if __name__ == '__main__':
    unittest.main()