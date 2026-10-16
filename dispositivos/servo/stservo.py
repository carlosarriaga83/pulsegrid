from time import sleep_ms
import _thread


class STServoError(Exception):
    pass


class STServoBus:
    MAX_SPEED = 3073
    MAX_ACCELERATION = 150
    INST_PING = 1
    INST_READ = 2
    INST_WRITE = 3
    ADDR_TORQUE_ENABLE = 40
    ADDR_ACC = 41
    ADDR_MODE = 33
    ADDR_GOAL_POSITION = 42
    ADDR_GOAL_SPEED = 46
    ADDR_PRESENT_POSITION = 56

    def __init__(self, uart, timeout_ms=100):
        self.uart = uart
        self.timeout_ms = timeout_ms
        self._uart_lock = _thread.allocate_lock()

    @staticmethod
    def _checksum(values):
        return (~sum(values)) & 255

    def _packet(self, servo_id, instruction, parameters=b''):
        length = len(parameters) + 2
        body = bytes((servo_id, length, instruction)) + parameters
        return b'\xff\xff' + body + bytes((self._checksum(body),))

    def _request(self, servo_id, instruction, parameters=b'', expect_reply=True):
        self._uart_lock.acquire()
        try:
            waiting = self.uart.any()
            if waiting:
                self.uart.read(waiting)
            self.uart.write(self._packet(servo_id, instruction, parameters))
            if not expect_reply:
                return b''
            deadline = self.timeout_ms
            header = bytearray()
            while deadline > 0:
                chunk = self.uart.read(1)
                if chunk:
                    header += chunk
                    if len(header) > 2:
                        header = header[1:]
                    if header == b'\xff\xff':
                        break
                sleep_ms(1)
                deadline -= 1
            else:
                raise STServoError('timeout esperando respuesta')
            packet_id = self.uart.read(1)
            length_data = self.uart.read(1)
            if not packet_id or not length_data or packet_id[0] != servo_id:
                raise STServoError('respuesta incompleta')
            length = length_data[0]
            payload = self.uart.read(length)
            if not payload or len(payload) != length:
                raise STServoError('respuesta incompleta')
            if self._checksum(bytes((packet_id[0], length)) + payload[:-1]) != payload[-1]:
                raise STServoError('checksum incorrecto')
            if payload[0] != 0:
                raise STServoError('error del servo: {}'.format(payload[0]))
            return payload[1:-1]
        finally:
            self._uart_lock.release()

    def ping(self, servo_id):
        try:
            self._request(servo_id, self.INST_PING)
            return True
        except (STServoError, OSError):
            return False

    def read(self, servo_id, address, size):
        return self._request(servo_id, self.INST_READ, bytes((address, size)))

    def write(self, servo_id, address, data):
        return self._request(servo_id, self.INST_WRITE, bytes((address,)) + bytes(data))

    def read_u8(self, servo_id, address):
        return self.read(servo_id, address, 1)[0]

    def read_u16(self, servo_id, address):
        data = self.read(servo_id, address, 2)
        return data[0] | (data[1] << 8)

    def write_u8(self, servo_id, address, value):
        return self.write(servo_id, address, bytes((value,)))

    def torque(self, servo_id, enabled):
        self.write(servo_id, self.ADDR_TORQUE_ENABLE, bytes((1 if enabled else 0,)))

    def set_mode(self, servo_id, mode):
        if mode not in (0, 1):
            raise ValueError('modo de servo invalido')
        self.write(servo_id, self.ADDR_MODE, bytes((mode,)))

    def move(self, servo_id, position, speed=800, acceleration=50):
        if not 0 <= position <= 4095 or not 0 <= speed <= self.MAX_SPEED or not 0 <= acceleration <= self.MAX_ACCELERATION:
            raise ValueError('parametros de movimiento invalidos')
        data = bytes((acceleration, position & 255, (position >> 8) & 255, 0, 0, speed & 255, (speed >> 8) & 255))
        self.write(servo_id, self.ADDR_ACC, data)

    def move_wheel(self, servo_id, speed, acceleration=50):
        if not -self.MAX_SPEED <= speed <= self.MAX_SPEED or not 0 <= acceleration <= self.MAX_ACCELERATION:
            raise ValueError('parametros de rueda invalidos')
        self.write_u8(servo_id, self.ADDR_ACC, acceleration)
        goal = abs(speed) | ((1 << 15) if speed < 0 else 0)
        return self.write(servo_id, self.ADDR_GOAL_SPEED, bytes((goal & 255, (goal >> 8) & 255)))

    def position(self, servo_id):
        data = self.read(servo_id, self.ADDR_PRESENT_POSITION, 2)
        return data[0] | (data[1] << 8)
