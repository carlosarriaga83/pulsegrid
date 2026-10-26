from machine import Pin
import time

_pin = None
_active_low = True
_status = None
_started_at = 0
_patterns = {
    'online': (1, 1),
    'offline': (120, 2000),
    'connecting': (250, 500),
    'provisioning': (500, 1000),
    'recovery': (150, 300),
    'moving': (80, 160),
}


def init(pin=8, active_low=True):
    global _pin, _active_low
    _active_low = bool(active_low)
    _pin = Pin(pin, Pin.OUT, value=1 if _active_low else 0)
    set_status('offline')


def set_status(status):
    global _status, _started_at
    if status not in _patterns:
        raise ValueError('Estado LED desconocido: ' + str(status))
    if status != _status:
        _status = status
        _started_at = time.ticks_ms()
    tick()


def tick():
    if _pin is None or _status is None:
        return
    on_ms, period_ms = _patterns[_status]
    on = time.ticks_diff(time.ticks_ms(), _started_at) % period_ms < on_ms
    _pin.value(int(not on) if _active_low else int(on))
