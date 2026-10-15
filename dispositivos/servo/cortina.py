from stservo import STServoBus, STServoError


class Cortina:
    def __init__(self, uart, i2c=None, min_position=300, max_position=3700, servo_ids=(1, 2)):
        if not 0 <= min_position < max_position <= 4095:
            raise ValueError('limites de posicion invalidos')
        self.bus = STServoBus(uart)
        self.min_position = min_position
        self.max_position = max_position
        self.direction_reversed = False
        self.known_servo_ids = tuple(servo_ids)
        self.servo_ids = tuple(servo_id for servo_id in self.known_servo_ids if self.bus.ping(servo_id))
        self.multiturn_active = {servo_id: False for servo_id in self.servo_ids}
        self.targets = {servo_id: 50.0 for servo_id in self.servo_ids}

    def update_multiturn(self):
        return None

    def set_direction_reversed(self, reversed_value):
        self.direction_reversed = bool(reversed_value)

    def position(self, servo_id):
        return self.bus.position(servo_id)

    def _target(self, percent):
        percent = float(percent)
        if not 0 <= percent <= 100:
            raise ValueError('posicion debe estar entre 0 y 100')
        if self.direction_reversed:
            percent = 100 - percent
        return int(round(self.min_position + (self.max_position - self.min_position) * percent / 100))

    def move_blind(self, servo_id, percent, speed=800, acceleration=50):
        if servo_id not in self.servo_ids:
            raise ValueError('ID de servo no detectado')
        if not 0 <= speed <= self.bus.MAX_SPEED or not 0 <= acceleration <= self.bus.MAX_ACCELERATION:
            raise ValueError('velocidad o aceleracion fuera de rango')
        self.bus.torque(servo_id, True)
        self.bus.move(servo_id, self._target(percent), speed=speed, acceleration=acceleration)
        self.targets[servo_id] = float(percent)

    def abrir(self, speed=800, acceleration=50):
        for servo_id in self.servo_ids:
            self.move_blind(servo_id, 100, speed, acceleration)

    def cerrar(self, speed=800, acceleration=50):
        for servo_id in self.servo_ids:
            self.move_blind(servo_id, 0, speed, acceleration)

    def parar(self):
        for servo_id in self.servo_ids:
            try:
                self.bus.torque(servo_id, False)
            except (STServoError, OSError):
                pass

    def multiturn_status(self, servo_id):
        if servo_id not in self.servo_ids:
            raise ValueError('ID de servo no detectado')
        position = self.position(servo_id)
        span = self.max_position - self.min_position
        percent = max(0.0, min(100.0, (position - self.min_position) * 100 / span))
        return {
            'position': position,
            'blind_percent': percent,
            'blind_target_percent': self.targets[servo_id],
            'multiturn_active': False,
            'position_recovery_required': False,
        }
