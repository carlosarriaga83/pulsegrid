from machine import Pin
import neopixel

_PIN = 23
_COUNT = 10
_ACTIVE_PIXELS = (0, 1)
_pixels = neopixel.NeoPixel(Pin(_PIN), _COUNT)


def set_enabled(enabled):
    color = (0, 24, 0) if enabled else (0, 0, 0)
    for index in _ACTIVE_PIXELS:
        _pixels[index] = color
    _pixels.write()


def set_provisioning():
    for index in _ACTIVE_PIXELS:
        _pixels[index] = (24, 16, 0)
    _pixels.write()


def off():
    for index in _ACTIVE_PIXELS:
        _pixels[index] = (0, 0, 0)
    _pixels.write()
