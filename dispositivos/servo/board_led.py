from machine import Pin
import neopixel
import time

_PIN = 23
_COUNT = 10
_ACTIVE_PIXELS = (0, 1)
_pixels = neopixel.NeoPixel(Pin(_PIN), _COUNT)
_enabled = True
_status = 'offline'
_colors = {
    'online': (0, 24, 0),
    'provisioning': (24, 16, 0),
    'recovery': (32, 14, 0),
    'offline': (24, 0, 0),
}
_last_rendered = None
_recovery_visible = True
_recovery_tick = 0


def _render():
    global _last_rendered
    color = _colors.get(_status, _colors['offline']) if _enabled else (0, 0, 0)
    if _status == 'recovery' and not _recovery_visible:
        color = (0, 0, 0)
    if color == _last_rendered:
        return
    for index in _ACTIVE_PIXELS:
        _pixels[index] = color
    _pixels.write()
    _last_rendered = color


def set_enabled(enabled):
    global _enabled
    _enabled = bool(enabled)
    _render()


def set_status(status):
    global _status, _recovery_visible, _recovery_tick
    if status == 'recovery':
        if _status == 'recovery':
            return
        _status = status
        _recovery_visible = True
        _recovery_tick = time.ticks_ms()
        _render()
        return
    if status not in _colors:
        status = 'offline'
    _status = status
    _render()


def tick():
    global _recovery_visible, _recovery_tick
    if _status != 'recovery':
        return
    now = time.ticks_ms()
    if time.ticks_diff(now, _recovery_tick) >= 350:
        _recovery_tick = now
        _recovery_visible = not _recovery_visible
        _render()


def is_enabled():
    return _enabled


def set_provisioning():
    set_status('provisioning')


def off():
    set_enabled(False)
