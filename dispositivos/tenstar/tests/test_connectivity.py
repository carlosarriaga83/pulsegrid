import contextlib
import importlib.util
import io
from pathlib import Path
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


class Pin:
    OUT = 1

    def __init__(self, number, mode, value=0):
        self.number = number
        self.level = value

    def value(self, value):
        self.level = value


class SSLStream:
    def __init__(self, response):
        self.response = response
        self.sent = bytearray()
        self.closed = False

    def read(self, size):
        size = min(size, 7)
        part, self.response = self.response[:size], self.response[size:]
        if not part:
            raise AssertionError('Must not wait for EOF after a complete HTTP response')
        return part

    def write(self, data):
        size = min(7, len(data))
        self.sent.extend(data[:size])
        return size

    def close(self):
        self.closed = True


class FirmwareTest(unittest.TestCase):
    def setUp(self):
        self.now = 10000
        self.time = types.SimpleNamespace(
            ticks_ms=lambda: self.now, ticks_diff=lambda a, b: a - b,
            ticks_add=lambda a, b: a + b, sleep_ms=lambda _: None)
        self.machine = types.SimpleNamespace(Pin=Pin, reset=lambda: None)
        self.station = types.SimpleNamespace(
            isconnected=lambda: True, ifconfig=lambda: ('192.168.1.20', '', '', ''),
            active=lambda _: None, connect=lambda *args: None, status=lambda *args: -55 if args else 3)
        self.config = types.ModuleType('config')
        self.config.WIFI_SSID = 'Test Wi-Fi'
        self.config.WIFI_PASSWORD = 'test-password'
        self.config.API_URL = 'https://example.test:8443/cloud'
        self.config.DEVICE_ID = 'PULSE_000000000000'
        self.config.DEVICE_CODE = 'test-code'
        self.network = types.SimpleNamespace(STA_IF=0, AP_IF=1, AUTH_OPEN=0, WLAN=lambda _: self.station)
        self.motor = types.SimpleNamespace(moving=False, snapshot=lambda: 0, target=None)
        modules = {
            'machine': self.machine, 'network': self.network, 'config': self.config,
            'time': self.time, '_thread': types.SimpleNamespace(allocate_lock=threading.Lock),
            'tenstar_motor': types.SimpleNamespace(TenstarMotor=lambda **kwargs: self.motor),
            'wifi_recovery': types.SimpleNamespace(clear_boots=lambda: None),
        }
        self.patcher = patch.dict(sys.modules, modules)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        self.addCleanup(lambda: sys.modules.pop('board_led', None))
        self.addCleanup(lambda: sys.modules.pop('captive_portal', None))
        self.led = self.load('board_led')
        self.portal = self.load('captive_portal')
        self.http = self.load('tenstar_http')
        self.calibration = self.load('tenstar_calibration')
        self.state = self.load('tenstar_state')
        sys.modules['board_led'] = self.led
        sys.modules['captive_portal'] = self.portal
        sys.modules['tenstar_http'] = self.http
        sys.modules['tenstar_calibration'] = self.calibration
        sys.modules['tenstar_state'] = self.state
        self.addCleanup(lambda: sys.modules.pop('tenstar_state', None))
        self.addCleanup(lambda: sys.modules.pop('tenstar_http', None))
        self.addCleanup(lambda: sys.modules.pop('tenstar_calibration', None))
        self.main = types.ModuleType('tenstar_test_main')
        sys.modules['tenstar_loop'] = self.load('tenstar_loop')
        self.addCleanup(lambda: sys.modules.pop('tenstar_loop', None))
        source = (ROOT / 'main.py').read_text(encoding='utf-8')
        exec(compile(source, str(ROOT / 'main.py'), 'exec'), self.main.__dict__)

    @staticmethod
    def load(name):
        spec = importlib.util.spec_from_file_location(name, ROOT / (name + '.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_ssl_response_uses_stream_read_and_content_length(self):
        stream = SSLStream(b'HTTP/1.1 200 OK\r\nContent-Length: 16\r\n\r\n{"command":null}')
        self.assertEqual(self.http._read_response(stream), {'command': None})

    def test_chunked_stream_without_recv(self):
        body = b'{"ok":true}'
        response = b'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n'
        response += b'b;test=1\r\n' + body + b'\r\n0\r\n\r\n'
        self.assertEqual(self.http._read_response(SSLStream(response)), {'ok': True})

    def test_http_authentication_error_includes_cloud_detail(self):
        body = b'{"error":"Invalid device code"}'
        stream = SSLStream(b'HTTP/1.1 401 Unauthorized\r\nContent-Length: ' + str(len(body)).encode() + b'\r\n\r\n' + body)
        with self.assertRaisesRegex(ValueError, 'HTTP 401.*Invalid device code'):
            self.http._read_response(stream)

    def test_missing_identity_is_not_silent(self):
        self.main.DEVICE_CODE = ''
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertIsNone(self.main.request('GET', '/api/device-commands'))
        self.assertIn('DEVICE_CODE', output.getvalue())

    def test_https_is_explicitly_rejected_while_motor_is_moving(self):
        self.motor.moving = True
        with self.assertRaisesRegex(RuntimeError, 'HTTPS suspendido'):
            self.main.request('POST', '/api/telemetry', {})

    def test_network_step_skips_all_network_work_during_motion_and_after_starting_it(self):
        for already_moving in (True, False):
            with self.subTest(already_moving=already_moving):
                events = []
                self.motor.moving = already_moving
                self.main.last_poll = 0
                self.main.last_telemetry = self.now
                self.main.ack_queue = []
                portal = types.SimpleNamespace(poll=lambda **_kwargs: events.append('portal'))
                self.main.connect_wifi = lambda: True
                self.main.send_telemetry = lambda: self.fail('Telemetry must not run during motion')

                def start_motion():
                    events.append('command')
                    self.motor.moving = True

                self.main.poll_command = start_motion
                self.main.network_step(portal)
                self.assertEqual(events, [] if already_moving else ['portal', 'command'])

    def test_network_step_resumes_telemetry_after_motion_stops(self):
        events = []
        self.motor.moving = True
        self.main.last_poll = self.now
        self.main.last_telemetry = 0
        portal = types.SimpleNamespace(poll=lambda **_kwargs: events.append('portal'))
        self.main.connect_wifi = lambda: True

        def telemetry():
            events.append('telemetry')
            return {'ok': True}

        self.main.send_telemetry = telemetry
        self.main.network_step(portal)
        self.assertEqual(events, [])
        self.motor.moving = False
        self.main.network_step(portal)
        self.assertEqual(events, ['portal', 'telemetry'])

    def test_ack_is_retried_without_reexecuting_command_and_after_fresh_telemetry(self):
        events = []
        portal = types.SimpleNamespace(poll=lambda **_kwargs: None)
        self.main.connect_wifi = lambda: True
        self.main.poll_command = lambda: events.append('poll')
        self.main.send_telemetry = lambda: events.append('telemetry') or {'ok': True}
        outcomes = iter([False, True])
        self.main.acknowledge = lambda *_args: events.append('ack') or next(outcomes)
        self.main.queue_ack(45, 'succeeded')
        self.main.network_step(portal)
        self.assertEqual(events, ['telemetry', 'ack'])
        self.assertEqual(self.main.ack_queue, [(45, 'succeeded', None)])
        self.main.network_step(portal)
        self.assertEqual(events, ['telemetry', 'ack', 'ack', 'poll'])
        self.assertEqual(self.main.ack_queue, [])

    def test_failed_state_publish_keeps_ack_and_does_not_fetch_next_command(self):
        portal = types.SimpleNamespace(poll=lambda **_kwargs: None)
        self.main.connect_wifi = lambda: True
        self.main.send_telemetry = lambda: None
        self.main.acknowledge = lambda *_args: self.fail('ACK before publishing state')
        self.main.poll_command = lambda: self.fail('Fetch before confirming command')
        self.main.queue_ack(45, 'succeeded')
        self.main.network_step(portal)
        self.assertEqual(self.main.last_telemetry, 0)
        self.assertEqual(len(self.main.ack_queue), 1)

    def test_https_request_handles_short_writes_port_and_url_prefix(self):
        stream = SSLStream(b'HTTP/1.1 200 OK\r\nContent-Length: 16\r\n\r\n{"command":null}')
        raw = types.SimpleNamespace(settimeout=lambda _: None, connect=lambda _: None)
        socket = types.SimpleNamespace(
            SOCK_STREAM=1, socket=lambda: raw,
            getaddrinfo=lambda host, port, *args: [(0, 0, 0, '', (host, port))])
        tls = types.SimpleNamespace(wrap_socket=lambda client, server_hostname: stream)
        self.http.socket = socket
        with patch.dict(sys.modules, {'ussl': tls}):
            result = self.main.request('GET', '/api/device-commands')
        self.assertEqual(result, {'command': None})
        self.assertTrue(stream.closed)
        self.assertIn(b'GET /cloud/api/device-commands HTTP/1.1', stream.sent)
        self.assertIn(b'Host: example.test:8443', stream.sent)
        self.assertTrue(self.main.cloud_online())
        self.now += 15001
        self.assertFalse(self.main.cloud_online())

    def test_unchanged_telemetry_preserves_cloud_deduplication(self):
        requests = []
        self.main.request = lambda method, path, payload: requests.append(payload)
        self.main.send_telemetry()
        self.now += 2000
        self.main.send_telemetry()
        self.assertEqual(requests[0], requests[1])

    def test_wifi_retry_is_nonblocking_and_no_ssid_allows_portal(self):
        self.station.isconnected = lambda: False
        attempts = []
        self.station.connect = lambda *args: attempts.append(args)
        self.station.disconnect = lambda: attempts.append('disconnect')
        self.assertFalse(self.main.connect_wifi())
        self.assertEqual(len(attempts), 1)
        self.now += 1000
        self.assertFalse(self.main.connect_wifi())
        self.assertEqual(len(attempts), 1)
        self.now += 15000
        self.assertFalse(self.main.connect_wifi())
        self.assertEqual(attempts[-1], 'disconnect')
        self.main.WIFI_SSID = ''
        self.now += 20000
        self.assertFalse(self.main.connect_wifi())
        self.assertEqual(len(attempts), 2)

    def test_http_auth_failure_marks_cloud_offline_without_leaking_code(self):
        body = b'{"error":"Invalid device code"}'
        stream = SSLStream(b'HTTP/1.1 401 Unauthorized\r\nContent-Length: ' + str(len(body)).encode() + b'\r\n\r\n' + body)
        raw = types.SimpleNamespace(settimeout=lambda _: None, connect=lambda _: None)
        self.http.socket = types.SimpleNamespace(
            SOCK_STREAM=1, socket=lambda: raw,
            getaddrinfo=lambda *args: [(0, 0, 0, '', ('example.test', 443))])
        self.main.cloud_last_success = self.now
        output = io.StringIO()
        with patch.dict(sys.modules, {'ussl': types.SimpleNamespace(wrap_socket=lambda *args, **kwargs: stream)}):
            with contextlib.redirect_stdout(output):
                self.assertIsNone(self.main.request('GET', '/api/device-commands'))
        self.assertFalse(self.main.cloud_online())
        self.assertIn('HTTP 401', output.getvalue())
        self.assertNotIn(self.config.DEVICE_CODE, output.getvalue())

    def test_portal_save_preserves_all_non_wifi_config(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'config.py'
            config.write_text("WIFI_SSID = 'old'\nWIFI_PASSWORD = 'keep-password'\nDEVICE_CODE = 'keep-code'\nPULSES_PER_REVOLUTION = 2100\nKP = 0.4\nLED_ACTIVE_LOW = False\n")
            self.portal.CONFIG_FILE = str(config)
            self.portal._write_config({'ssid': 'new Wi-Fi', 'password': ''})
            saved = {}
            exec(config.read_text(), saved)
            self.assertEqual(saved['WIFI_SSID'], 'new Wi-Fi')
            for key, expected in [('WIFI_PASSWORD', 'keep-password'), ('DEVICE_CODE', 'keep-code'),
                                  ('PULSES_PER_REVOLUTION', 2100), ('KP', 0.4), ('LED_ACTIVE_LOW', False)]:
                self.assertEqual(saved[key], expected)

    def test_portal_recovers_interrupted_config_save(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'config.py'
            self.portal.CONFIG_FILE = str(config)
            Path(str(config) + '.bak').write_text("WIFI_SSID = 'saved'\n")
            self.portal.recover_config_file()
            self.assertEqual(config.read_text(), "WIFI_SSID = 'saved'\n")

    def test_portal_rejects_bad_wifi_and_supports_open_network(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'config.py'
            config.write_text("WIFI_SSID = 'old'\nWIFI_PASSWORD = 'keep-password'\n")
            self.portal.CONFIG_FILE = str(config)
            for values in [{'ssid': ''}, {'ssid': 'new', 'password': 'short'}]:
                with self.assertRaises(ValueError):
                    self.portal._write_config(values)
            self.portal._write_config({'ssid': 'open', 'open_network': '1'})
            saved = {}
            exec(config.read_text(), saved)
            self.assertEqual(saved['WIFI_PASSWORD'], '')

    def test_portal_form_decodes_utf8_and_escapes_ssid(self):
        self.assertEqual(self.portal._form('ssid=Caf%C3%A9+Wi-Fi')['ssid'], 'Caf\u00e9 Wi-Fi')
        self.config.WIFI_SSID = '"><script>alert(1)</script>'
        html = self.portal._page()
        self.assertNotIn('<script>', html)
        self.assertNotIn(self.config.DEVICE_CODE, html)
        self.assertNotIn(self.config.WIFI_PASSWORD, html)

    def test_portal_switches_from_ap_to_lan_and_back(self):
        class AccessPoint:
            def __init__(self):
                self.enabled = False

            def active(self, value=None):
                if value is not None:
                    self.enabled = value
                return self.enabled

            def config(self, *args, **kwargs):
                return b'\x00\x01\x02\x03\xab\xcd' if args else None

            def ifconfig(self, value):
                self.address = value

        ap = AccessPoint()
        server = types.SimpleNamespace(setsockopt=lambda *args: None, bind=lambda *args: None, listen=lambda *args: None)
        poller = types.SimpleNamespace(register=lambda *args: None, poll=lambda _: [])
        self.station.isconnected = lambda: False
        self.portal.network = types.SimpleNamespace(AP_IF=1, AUTH_OPEN=0, WLAN=lambda _: ap)
        self.portal.socket = types.SimpleNamespace(
            socket=lambda: server, SOL_SOCKET=1, SO_REUSEADDR=2)
        self.portal.select = types.SimpleNamespace(poll=lambda: poller, POLLIN=1)
        portal = self.portal.Portal(self.station)
        self.assertTrue(ap.enabled)
        self.assertEqual(portal.host, '192.168.4.1')
        self.station.isconnected = lambda: True
        portal.poll()
        self.assertFalse(ap.enabled)
        self.assertEqual(portal.host, '192.168.1.20')
        portal.force_ap = True
        portal.poll()
        self.assertTrue(ap.enabled)
        self.assertEqual(portal.host, '192.168.4.1')

    def test_portal_http_saves_wifi_and_restarts_only_when_idle(self):
        class Client:
            def __init__(self, request):
                self.request = request
                self.response = bytearray()
                self.closed = False

            def settimeout(self, _):
                pass

            def recv(self, size):
                part, self.request = self.request[:size], self.request[size:]
                return part

            def sendall(self, data):
                self.response.extend(data)

            def close(self):
                self.closed = True

        resets = []
        self.machine.reset = lambda: resets.append(True)
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'config.py'
            config.write_text("WIFI_SSID = 'old'\nWIFI_PASSWORD = 'keep-password'\nDEVICE_ID = 'keep-id'\n")
            self.portal.CONFIG_FILE = str(config)
            body = b'ssid=New+Wi-Fi&password='
            request = b'POST /save HTTP/1.1\r\nContent-Length: ' + str(len(body)).encode() + b'\r\n\r\n' + body
            for allowed in (False, True):
                client = Client(request)
                portal = object.__new__(self.portal.Portal)
                portal.update_network = lambda: None
                portal.poller = types.SimpleNamespace(poll=lambda _: [True])
                portal.server = types.SimpleNamespace(accept=lambda: (client, None))
                portal.poll(allow_save=allowed)
                self.assertTrue(client.closed)
                self.assertIn(b'200 OK' if allowed else b'400 Bad Request', client.response)
                if not allowed:
                    self.assertIn("WIFI_SSID = 'old'", config.read_text())
                    self.assertFalse(resets)
            self.assertEqual(resets, [True])
            saved = {}
            exec(config.read_text(), saved)
            self.assertEqual(saved['WIFI_SSID'], 'New Wi-Fi')
            self.assertEqual(saved['DEVICE_ID'], 'keep-id')

    def test_startup_without_wifi_keeps_cooperative_control_and_portal(self):
        class EndLoop(BaseException):
            pass

        self.main.WIFI_SSID = ''
        self.main.DEVICE_CODE = ''
        self.main.load_calibration = lambda: None
        self.machine.reset_cause = lambda: 1
        self.main.wifi_recovery = types.SimpleNamespace(register_boot=lambda _: False, STABLE_BOOT_MS=30000)
        self.time.sleep_ms = lambda _: (_ for _ in ()).throw(EndLoop())
        portal_polls = []
        self.main.captive_portal.Portal = lambda *_args: types.SimpleNamespace(
            poll=lambda **_kwargs: portal_polls.append(True))
        updates = []
        self.motor.update = lambda: updates.append(True)
        output = io.StringIO()
        with patch.dict(sys.modules, {'ota_boot': types.SimpleNamespace(confirm=lambda: None, feed=lambda: None)}):
            with contextlib.redirect_stdout(output):
                with self.assertRaises(EndLoop):
                    self.main.main()
        self.assertEqual(portal_polls, [True])
        self.assertEqual(updates, [True])
        self.assertEqual(self.led._status, 'provisioning')
        self.assertIn('http://192.168.4.1/', output.getvalue())
        self.assertIn('DEVICE_CODE', output.getvalue())

    def test_gpio8_active_low_patterns(self):
        self.led.init()
        self.assertEqual(self.led._pin.number, 8)
        self.led.set_status('online')
        self.assertEqual(self.led._pin.level, 0)
        self.led.set_status('offline')
        self.now += 500
        self.led.tick()
        self.assertEqual(self.led._pin.level, 1)
        self.led.set_status('moving')
        self.assertEqual(self.led._pin.level, 0)


if __name__ == '__main__':
    unittest.main()
