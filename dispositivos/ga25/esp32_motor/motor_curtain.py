from machine import Pin, PWM
import time


class CurtainMotor:
    def __init__(self, enable_pin=16, direction_a_pin=18, direction_b_pin=33,
                 full_travel_ms=15000, open_a_level=1, direction_reversed=False, pwm_frequency=20000):
        self.enable = PWM(Pin(enable_pin), freq=pwm_frequency, duty=0)
        self.direction_a = Pin(direction_a_pin, Pin.OUT, value=0)
        self.direction_b = Pin(direction_b_pin, Pin.OUT, value=0)
        self.full_travel_ms = max(1000, int(full_travel_ms))
        self.open_a_level = 1 if open_a_level else 0
        self.direction_reversed = bool(direction_reversed)
        self.position = 0.0
        self.target = None
        self.started_at = 0
        self.started_position = 0.0
        self.direction = 0
        self.speed = 70
        self.stop()

    def _set_direction(self, direction):
        if self.direction_reversed:
            direction = -direction
        if direction > 0:
            a = 1
            b = 0
        elif direction < 0:
            a = 0
            b = 1
        else:
            a = b = 0
        self.direction_a.value(a)
        self.direction_b.value(b)

    def _duty(self, speed):
        return max(0, min(1023, int(int(speed) * 1023 / 100)))

    def _update_position(self):
        if not self.direction:
            return
        elapsed = time.ticks_diff(time.ticks_ms(), self.started_at)
        delta = elapsed * 100.0 / self.full_travel_ms
        self.position = max(0.0, min(100.0, self.started_position + self.direction * delta))
        if self.target is not None:
            reached = self.position >= self.target if self.direction > 0 else self.position <= self.target
            if reached or self.position <= 0 or self.position >= 100:
                self.position = self.target if reached else self.position
                self.stop()

    def start(self, direction, speed=70, target=None):
        self._update_position()
        direction = 1 if direction > 0 else -1 if direction < 0 else 0
        if not direction:
            return self.stop()
        self.target = None if target is None else max(0.0, min(100.0, float(target)))
        self.direction = direction
        self.speed = max(10, min(100, int(speed)))
        self.started_position = self.position
        self.started_at = time.ticks_ms()
        self._set_direction(direction)
        self.enable.duty(self._duty(self.speed))

    def move_to(self, percent, speed=70):
        self._update_position()
        target = max(0.0, min(100.0, float(percent)))
        if abs(target - self.position) < 0.5:
            return self.stop()
        self.start(1 if target > self.position else -1, speed, target)

    def stop(self):
        self.enable.duty(0)
        self._set_direction(0)
        self.direction = 0
        self.target = None

    def tick(self):
        self._update_position()

    def status(self):
        self._update_position()
        return {
            "position": round(self.position, 1),
            "target": None if self.target is None else round(self.target, 1),
            "moving": bool(self.direction),
            "direction": self.direction,
            "speed": self.speed,
            "positionSource": "timed-estimate"
        }
