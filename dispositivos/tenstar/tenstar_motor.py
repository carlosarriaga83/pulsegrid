from machine import Pin, PWM
import micropython
import time

micropython.alloc_emergency_exception_buf(100)

# Quadrature transitions: index = previous_state * 4 + current_state.
_QUADRATURE = (0, 1, -1, 0,
              -1, 0, 0, 1,
              1, 0, 0, -1,
              0, -1, 1, 0)


class TenstarMotor:
    def __init__(self, in1_pin=0, in2_pin=1, encoder_a_pin=3, encoder_b_pin=4,
                 pulses_per_revolution=1980, kp=0.3, minimum_speed=20):
        self.in1 = PWM(Pin(in1_pin), freq=1000, duty_u16=0)
        self.in2 = PWM(Pin(in2_pin), freq=1000, duty_u16=0)
        self.pin_a = Pin(encoder_a_pin, Pin.IN, Pin.PULL_UP)
        self.pin_b = Pin(encoder_b_pin, Pin.IN, Pin.PULL_UP)
        self.pulses_per_revolution = max(1, int(pulses_per_revolution))
        self.kp = max(0.01, float(kp))
        self.minimum_speed = max(1, min(100, int(minimum_speed)))
        self.position = 0
        self.previous_state = (self.pin_a.value() << 1) | self.pin_b.value()
        self.target = None
        self.jogging = False
        self.maximum_speed = 100
        self.stable_cycles = 0
        self.started_at = 0
        self.motion_timeout_ms = 60000
        self.last_error = 0
        self.pin_a.irq(trigger=Pin.IRQ_RISING | Pin.IRQ_FALLING, handler=self._encoder_irq)
        self.pin_b.irq(trigger=Pin.IRQ_RISING | Pin.IRQ_FALLING, handler=self._encoder_irq)
        self.coast()

    def _encoder_irq(self, _pin):
        state = (self.pin_a.value() << 1) | self.pin_b.value()
        self.position += _QUADRATURE[(self.previous_state << 2) | state]
        self.previous_state = state

    def snapshot(self):
        irq_state = machine_disable_irq()
        value = self.position
        machine_enable_irq(irq_state)
        return value

    def zero(self):
        return self.set_position(0)

    def set_position(self, pulses):
        irq_state = machine_disable_irq()
        self.position = int(pulses)
        self.previous_state = (self.pin_a.value() << 1) | self.pin_b.value()
        machine_enable_irq(irq_state)
        return self.position

    def brake(self):
        self.in1.duty_u16(65535)
        self.in2.duty_u16(65535)

    def coast(self):
        self.in1.duty_u16(0)
        self.in2.duty_u16(0)

    def apply(self, speed_percent, direction):
        speed = max(0, min(100, float(speed_percent)))
        if speed <= 0:
            self.coast()
            return
        duty = int(speed * 65535 / 100)
        if direction > 0:
            self.in1.duty_u16(duty)
            self.in2.duty_u16(0)
        else:
            self.in1.duty_u16(0)
            self.in2.duty_u16(duty)

    def move_turns(self, turns, direction, maximum_speed):
        if self.moving:
            raise ValueError('Ya hay un movimiento activo')
        sign = 1 if int(direction) > 0 else -1
        delta = int(abs(float(turns)) * self.pulses_per_revolution) * sign
        if not delta:
            raise ValueError('El movimiento debe ser mayor que cero')
        self.target = self.snapshot() + delta
        self.motion_timeout_ms = 60000
        self.maximum_speed = max(self.minimum_speed, min(100, int(maximum_speed)))
        self.stable_cycles = 0
        self.started_at = time.ticks_ms()
        self.last_error = 0
        return self.target

    def jog(self, direction, speed, duration_ms=2000):
        if self.moving:
            raise ValueError('Ya hay un movimiento activo')
        self.target = None
        self.jogging = True
        self.motion_timeout_ms = max(100, min(5000, int(duration_ms)))
        self.apply(max(self.minimum_speed, min(100, int(speed))), 1 if int(direction) > 0 else -1)
        self.started_at = time.ticks_ms()

    def stop(self):
        self.target = None
        self.jogging = False
        self.stable_cycles = 0
        self.coast()

    def update(self):
        if self.jogging:
            if time.ticks_diff(time.ticks_ms(), self.started_at) >= self.motion_timeout_ms:
                self.stop()
                return True
            return False
        if self.target is None:
            return None
        if time.ticks_diff(time.ticks_ms(), self.started_at) > self.motion_timeout_ms:
            self.stop()
            raise RuntimeError('Movimiento detenido por limite local de tiempo; verifica el encoder y el mecanismo')
        error = self.target - self.snapshot()
        distance = abs(error)
        self.last_error = error
        if distance <= 3:
            self.brake()
            self.stable_cycles += 1
            if self.stable_cycles >= 10:
                self.coast()
                self.target = None
                return True
        else:
            self.stable_cycles = 0
            speed = min(self.maximum_speed, distance * self.kp + self.minimum_speed)
            self.apply(speed, 1 if error > 0 else -1)
        return False

    @property
    def moving(self):
        return self.target is not None or self.jogging


def machine_disable_irq():
    import machine
    return machine.disable_irq()


def machine_enable_irq(state):
    import machine
    machine.enable_irq(state)
