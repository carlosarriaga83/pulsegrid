from time import sleep_ms
import _thread


class STServoError(Exception):
    pass


class STServoBus:
    """Driver minimo para servos ST/STS a 1 Mbps."""

    MAX_SPEED = 3073
    MAX_ACCELERATION = 150
    MAX_MULTITURN_TURNS = 7.99

    INST_PING = 0x01
    INST_READ = 0x02
    INST_WRITE = 0x03

    ADDR_TORQUE_ENABLE = 40
    ADDR_ACC = 41
    ADDR_MODE = 33
    ADDR_ID = 5
    ADDR_LOCK = 55
    ADDR_MIN_ANGLE = 9
    ADDR_MAX_ANGLE = 11
    ADDR_TORQUE_LIMIT = 16
    ADDR_GOAL_POSITION = 42
    ADDR_GOAL_SPEED = 46
    ADDR_PRESENT_POSITION = 56

    def __init__(self, uart, timeout_ms=100):
        self.uart = uart
        self.timeout_ms = timeout_ms
        self._uart_lock = _thread.allocate_lock()

    @staticmethod
    def _checksum(values):
        return (~sum(values)) & 0xFF

    def _packet(self, servo_id, instruction, parameters=b""):
        length = len(parameters) + 2
        body = bytes((servo_id, length, instruction)) + parameters
        return b"\xff\xff" + body + bytes((self._checksum(body),))

    def _flush_input(self):
        waiting = self.uart.any()
        if waiting:
            self.uart.read(waiting)

    def _read_status(self, servo_id):
        deadline = self.timeout_ms
        header = bytearray()

        while deadline > 0:
            chunk = self.uart.read(1)
            if chunk:
                header += chunk
                if len(header) > 2:
                    header = header[1:]
                if header == b"\xff\xff":
                    break
            sleep_ms(1)
            deadline -= 1
        else:
            raise STServoError("timeout esperando respuesta")

        packet_id = self.uart.read(1)
        length_data = self.uart.read(1)
        if not packet_id or not length_data:
            raise STServoError("respuesta incompleta")
        if packet_id[0] != servo_id and servo_id != 0xFE:
            raise STServoError("ID inesperado: {}".format(packet_id[0]))

        length = length_data[0]
        if length < 2:
            raise STServoError("longitud de respuesta invalida")
        payload = self.uart.read(length)
        if payload is None or len(payload) != length:
            raise STServoError("respuesta incompleta")

        checksum_values = bytes((packet_id[0], length)) + payload[:-1]
        if self._checksum(checksum_values) != payload[-1]:
            raise STServoError("checksum incorrecto")
        if payload[0] != 0:
            raise STServoError("error del servo: {}".format(payload[0]))
        return payload[1:-1]

    def _request(self, servo_id, instruction, parameters=b"", expect_reply=True):
        self._uart_lock.acquire()
        try:
            self._flush_input()
            self.uart.write(self._packet(servo_id, instruction, parameters))
            if not expect_reply:
                return b""
            return self._read_status(servo_id)
        finally:
            self._uart_lock.release()

    def ping(self, servo_id):
        try:
            self._request(servo_id, self.INST_PING)
            return True
        except (STServoError, OSError):
            return False

    def write(self, servo_id, address, data, expect_reply=True):
        return self._request(
            servo_id,
            self.INST_WRITE,
            bytes((address,)) + bytes(data),
            expect_reply,
        )

    def read(self, servo_id, address, size):
        return self._request(
            servo_id,
            self.INST_READ,
            bytes((address, size)),
        )

    def torque(self, servo_id, enabled):
        self.write(servo_id, self.ADDR_TORQUE_ENABLE, bytes((1 if enabled else 0,)))

    def read_u8(self, servo_id, address):
        return self.read(servo_id, address, 1)[0]

    def read_u16(self, servo_id, address):
        data = self.read(servo_id, address, 2)
        return data[0] | (data[1] << 8)

    def write_u8(self, servo_id, address, value):
        if not 0 <= value <= 255:
            raise ValueError("valor de 8 bits fuera de rango")
        return self.write(servo_id, address, bytes((value,)))

    def write_u16(self, servo_id, address, value):
        if not 0 <= value <= 65535:
            raise ValueError("valor de 16 bits fuera de rango")
        return self.write(servo_id, address, bytes((value & 0xFF, (value >> 8) & 0xFF)))

    def configuration(self, servo_id):
        return {
            "id": servo_id,
            "mode": self.read_u8(servo_id, self.ADDR_MODE),
            "torque_enabled": self.read_u8(servo_id, self.ADDR_TORQUE_ENABLE),
            "min_angle": self.read_u16(servo_id, self.ADDR_MIN_ANGLE),
            "max_angle": self.read_u16(servo_id, self.ADDR_MAX_ANGLE),
            "torque_limit": self.read_u16(servo_id, self.ADDR_TORQUE_LIMIT),
        }

    def set_limits(self, servo_id, min_angle, max_angle):
        if not 0 <= min_angle < max_angle <= 4095:
            raise ValueError("limites de angulo invalidos")
        self.write(servo_id, self.ADDR_LOCK, b"\x00")
        try:
            self.write_u16(servo_id, self.ADDR_MIN_ANGLE, min_angle)
            self.write_u16(servo_id, self.ADDR_MAX_ANGLE, max_angle)
        finally:
            self.write(servo_id, self.ADDR_LOCK, b"\x01")

    def set_mode(self, servo_id, mode):
        if mode not in (0, 1, 3):
            raise ValueError("modo debe ser 0=servo, 1=rueda o 3=multivuelta")
        self.write(servo_id, self.ADDR_LOCK, b"\x00")
        try:
            self.write_u8(servo_id, self.ADDR_MODE, mode)
            if mode == 0:
                self.write_u16(servo_id, self.ADDR_MAX_ANGLE, 4095)
            elif mode == 3:
                self.write_u16(servo_id, self.ADDR_MIN_ANGLE, 0)
                self.write_u16(servo_id, self.ADDR_MAX_ANGLE, 0)
        finally:
            self.write(servo_id, self.ADDR_LOCK, b"\x01")

    def set_torque_limit(self, servo_id, limit):
        if not 0 <= limit <= 1000:
            raise ValueError("limite de torque fuera de rango")
        self.write_u16(servo_id, self.ADDR_TORQUE_LIMIT, limit)

    def set_id(self, current_id, new_id):
        if not 0 <= new_id <= 253:
            raise ValueError("new_id debe estar entre 0 y 253")
        self.write(current_id, self.ADDR_LOCK, b"\x00")
        self.write(current_id, self.ADDR_ID, bytes((new_id,)))
        self.write(new_id, self.ADDR_LOCK, b"\x01")

    def move(self, servo_id, position, speed=2000, acceleration=100):
        if not 0 <= position <= 4095:
            raise ValueError("position debe estar entre 0 y 4095")
        if not 0 <= speed <= self.MAX_SPEED:
            raise ValueError("speed debe estar entre 0 y 3073")
        if not 0 <= acceleration <= self.MAX_ACCELERATION:
            raise ValueError("acceleration debe estar entre 0 y 150")

        data = bytes((
            acceleration,
            position & 0xFF,
            (position >> 8) & 0xFF,
            0,
            0,
            speed & 0xFF,
            (speed >> 8) & 0xFF,
        ))
        self.write(servo_id, self.ADDR_ACC, data)

    def move_multiturn(self, servo_id, turns, current_position=0, speed=2000, acceleration=100):
        if isinstance(turns, bool) or not isinstance(turns, (int, float)):
            raise ValueError("vueltas debe ser un numero")
        if not -self.MAX_MULTITURN_TURNS <= turns <= self.MAX_MULTITURN_TURNS:
            raise ValueError("vueltas debe estar entre -7.99 y 7.99")
        position = int(round(current_position + turns * 4096))
        if not -32767 <= position <= 32767:
            raise ValueError("objetivo multivuelta fuera de rango")
        encoded_position = abs(position)
        if position < 0:
            encoded_position |= 1 << 15
        if not 0 <= speed <= self.MAX_SPEED or not 0 <= acceleration <= self.MAX_ACCELERATION:
            raise ValueError("velocidad debe estar entre 0 y 3073, aceleracion entre 0 y 150")
        data = bytes((
            acceleration,
            encoded_position & 0xFF,
            (encoded_position >> 8) & 0xFF,
            0,
            0,
            speed & 0xFF,
            (speed >> 8) & 0xFF,
        ))
        self.write(servo_id, self.ADDR_ACC, data)

    def move_wheel(self, servo_id, speed, acceleration=100):
        if not -self.MAX_SPEED <= speed <= self.MAX_SPEED:
            raise ValueError("velocidad rueda debe estar entre -3073 y 3073")
        if not 0 <= acceleration <= self.MAX_ACCELERATION:
            raise ValueError("aceleracion debe estar entre 0 y 150")
        self.write_u8(servo_id, self.ADDR_ACC, acceleration)
        goal = abs(speed)
        if speed < 0:
            goal |= 1 << 15
        return self.write(servo_id, self.ADDR_GOAL_SPEED, bytes((goal & 0xFF, (goal >> 8) & 0xFF)))

    def position(self, servo_id):
        data = self.read(servo_id, self.ADDR_PRESENT_POSITION, 2)
        return data[0] | (data[1] << 8)

    def position_signed(self, servo_id):
        value = self.position(servo_id)
        if value & (1 << 15):
            return -(value & 0x7FFF)
        return value

    def scan(self, first_id=0, last_id=20):
        return [servo_id for servo_id in range(first_id, last_id + 1) if self.ping(servo_id)]
