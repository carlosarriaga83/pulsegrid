import gc
import socket
import time
import ujson


class CloudClient:
    def __init__(self, api_url, device_code, device_id, commands_enabled=True):
        self.api_url = api_url
        self.device_code = device_code
        self.device_id = device_id
        self.commands_enabled = commands_enabled
        self.next_request_at = 0
        self.last_poll = 0
        self.last_telemetry = 0
        self.retry_ms = 5000
        self.firmware_update_requested = False
        self.last_success_at = None

    def _socket(self):
        gc.collect()
        host = self.api_url.split('://', 1)[-1].split('/', 1)[0]
        parts = host.split(':', 1)
        port = int(parts[1]) if len(parts) > 1 else 443
        client = socket.socket()
        try:
            client.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
            client.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 4096)
        except (AttributeError, OSError):
            pass
        client.settimeout(8)
        phase = 'TCP connect'
        try:
            client.connect((parts[0], port))
            gc.collect()
            phase = 'TLS module import'
            try:
                import ussl as tls
            except ImportError:
                import ssl as tls
            gc.collect()
            phase = 'TLS handshake'
            secure_client = tls.wrap_socket(client, server_hostname=parts[0])
            return secure_client, parts[0]
        except Exception as error:
            print('Pulsegrid transporte fallo en {}: {}'.format(phase, error))
            client.close()
            gc.collect()
            raise

    def request(self, method, path, payload=None):
        if time.ticks_diff(time.ticks_ms(), self.next_request_at) < 0:
            return None
        if not self.api_url.startswith('https://'):
            print('Pulsegrid: HTTPS es obligatorio')
            return None
        client = None
        try:
            client, host = self._socket()
            body = ujson.dumps(payload) if payload is not None else ''
            request = '{} {} HTTP/1.1\r\nHost: {}\r\nX-Device-Code: {}\r\nConnection: close\r\n'.format(method, path, host, self.device_code)
            if body:
                request += 'Content-Type: application/json\r\nContent-Length: {}\r\n'.format(len(body))
            client.send((request + '\r\n' + body).encode())
            header = b''
            while b'\r\n\r\n' not in header:
                chunk = client.recv(256)
                if not chunk:
                    break
                header += chunk
                if len(header) > 4096:
                    raise ValueError('Encabezado HTTP demasiado grande')
            separator = header.find(b'\r\n\r\n')
            status = int(header[9:12]) if len(header) >= 12 else 0
            if status < 200 or status >= 300:
                raise ValueError('HTTP {}'.format(status))
            body = header[separator + 4:] if separator >= 0 else b''
            content_length = None
            for line in header[:separator].lower().split(b'\r\n'):
                if line.startswith(b'content-length:'):
                    content_length = int(line.split(b':', 1)[1].strip())
            if content_length is not None:
                while len(body) < content_length:
                    chunk = client.recv(256)
                    if not chunk:
                        break
                    body += chunk
                body = body[:content_length]
            result = ujson.loads(body) if body else {}
            self.last_success_at = time.ticks_ms()
            self.retry_ms = 5000
            return result
        except Exception as error:
            print('Pulsegrid (TLS/HTTP):', error)
            if getattr(error, 'errno', None) == 12:
                gc.collect()
                try:
                    free_heap = gc.mem_free()
                    print('Heap libre tras recuperar:', free_heap)
                except AttributeError:
                    free_heap = None
                try:
                    import esp32
                    heap_info = esp32.idf_heap_info(esp32.HEAP_DATA)
                    print('Heap ESP32 (bloque mayor, libre total, minimo):', heap_info)
                except (ImportError, AttributeError, OSError, TypeError):
                    if free_heap is not None:
                        print('La falta de memoria TLS puede deberse a fragmentacion del heap.')
            self.next_request_at = time.ticks_add(time.ticks_ms(), self.retry_ms)
            self.retry_ms = min(self.retry_ms * 2, 60000)
            return None
        finally:
            if client:
                client.close()
            gc.collect()

    def is_online(self, max_age_ms=30000):
        return (self.last_success_at is not None
                and time.ticks_diff(time.ticks_ms(), self.last_success_at) <= max_age_ms)

    def telemetry(self, cortina, firmware_version, led_enabled, reversed_value):
        servos = {}
        for servo_id in cortina.servo_ids:
            try:
                values = cortina.multiturn_status(servo_id)
                values['position'] = cortina.position(servo_id)
                servos[str(servo_id)] = values
            except Exception as error:
                print('Servo {}: {}'.format(servo_id, error))
        return self.request('POST', '/api/telemetry', {
            'deviceId': self.device_id, 'kind': 'curtain', 'firmwareTarget': 'servo',
            'firmwareVersion': firmware_version, 'ledEnabled': led_enabled,
            'directionReversed': reversed_value, 'online': True, 'servos': servos,
        })

    def commands(self, cortina, led_setter):
        if not self.commands_enabled:
            return
        result = self.request('GET', '/api/device-commands?deviceId=' + self.device_id)
        command = result.get('command') if result else None
        if not command:
            return
        name = command.get('name')
        payload = command.get('payload') or {}
        error = None
        try:
            if name == 'led.configure':
                led_setter(bool(payload['enabled']))
            elif name == 'direction.configure':
                cortina.set_direction_reversed(bool(payload['reversed']))
            elif name == 'curtain.open':
                cortina.abrir(int(payload.get('speed', 800)), int(payload.get('acceleration', 50)))
            elif name == 'curtain.close':
                cortina.cerrar(int(payload.get('speed', 800)), int(payload.get('acceleration', 50)))
            elif name == 'curtain.stop':
                cortina.parar()
            elif name == 'curtain.move':
                cortina.move_blind(int(payload.get('servoId', 1)), float(payload.get('percent', payload.get('position'))), int(payload.get('speed', 800)), int(payload.get('acceleration', 50)))
            elif name == 'firmware.update':
                import pulsegrid_ota
                files = ('main.py', 'cloud_client.py', 'board_led.py', 'captive_portal.py', 'cortina.py', 'servo_calibration.py', 'stservo.py', 'boot.py', 'ota_boot.py', 'pulsegrid_ota.py', 'wifi_recovery.py')
                pulsegrid_ota.update(self.api_url, self.device_code, self.device_id, str(payload.get('version', '')), 'servo', files)
                del pulsegrid_ota
                import sys
                sys.modules.pop('pulsegrid_ota', None)
                sys.modules.pop('ota_boot', None)
                gc.collect()
                self.firmware_update_requested = True
            elif name.startswith('blind.'):
                import servo_calibration
                servo_id = int(payload.get('servoId', 1))
                if name == 'blind.setMotorSide': servo_calibration.set_motor_side(cortina, servo_id, payload.get('side', ''))
                elif name == 'blind.beginCalibration': servo_calibration.begin(cortina, servo_id)
                elif name == 'blind.markDeployed': servo_calibration.mark(cortina, servo_id, 'deployed')
                elif name == 'blind.markRolled': servo_calibration.mark(cortina, servo_id, 'rolled')
                elif name == 'blind.jog': servo_calibration.jog(cortina, servo_id, payload.get('direction', ''), int(payload.get('speed', 800)), int(payload.get('acceleration', 50)))
                elif name == 'blind.configure':
                    config = cortina.blind_config[servo_id]
                    config['rolled_turns'] = float(payload['rolledTurns'])
                    config['unrolled_turns'] = float(payload['unrolledTurns'])
                    config['calibrated'] = True
                    cortina.position_recovery_required[servo_id] = False
                    cortina._save_persistent_state()
            else:
                raise ValueError('Comando no soportado: ' + str(name))
        except Exception as caught:
            error = caught
        status = 'failed' if error else 'succeeded'
        body = {'deviceId': self.device_id, 'status': status}
        if error: body['error'] = str(error)[:500]
        self.request('POST', '/api/device-commands/{}/ack'.format(command.get('id')), body)
        if error: print('Comando rechazado:', error)
        else:
            print('Comando ejecutado:', name)
            if self.firmware_update_requested:
                import machine
                time.sleep_ms(250)
                machine.reset()
