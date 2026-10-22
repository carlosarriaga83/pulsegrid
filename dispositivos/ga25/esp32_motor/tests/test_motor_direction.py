import importlib.util
import pathlib
import sys
import types
import unittest


SOURCE = pathlib.Path(__file__).resolve().parents[1] / "motor_curtain.py"


class FakePin:
    OUT = 1

    def __init__(self, pin, _mode=None, value=0):
        self.pin = pin
        self.current = value

    def value(self, value=None):
        if value is not None:
            self.current = value
        return self.current


class FakePWM:
    def __init__(self, _pin, freq, duty):
        self.freq = freq
        self.current_duty = duty

    def duty(self, value):
        self.current_duty = value


class FakeTime:
    @staticmethod
    def ticks_ms():
        return 0

    @staticmethod
    def ticks_diff(first, second):
        return first - second


class FakeTime:
    @staticmethod
    def ticks_ms():
        return 0

    @staticmethod
    def ticks_diff(first, second):
        return first - second


def load_motor_module():
    previous_machine = sys.modules.get("machine")
    previous_time = sys.modules.get("time")
    machine = types.ModuleType("machine")
    machine.Pin = FakePin
    machine.PWM = FakePWM
    sys.modules["machine"] = machine
    time_module = types.ModuleType("time")
    time_module.ticks_ms = FakeTime.ticks_ms
    time_module.ticks_diff = FakeTime.ticks_diff
    sys.modules["time"] = time_module
    try:
        spec = importlib.util.spec_from_file_location("ga25_motor_direction_test_subject", SOURCE)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        if previous_machine is None:
            sys.modules.pop("machine", None)
        else:
            sys.modules["machine"] = previous_machine
        if previous_time is None:
            sys.modules.pop("time", None)
        else:
            sys.modules["time"] = previous_time


class Ga25MotorDirectionTests(unittest.TestCase):
    def make_motor(self, open_a_level=1, reversed_value=False):
        module = load_motor_module()
        motor = module.CurtainMotor(open_a_level=open_a_level, direction_reversed=reversed_value)
        return motor

    def test_open_a_level_maps_the_logical_open_direction_to_either_bridge_polarity(self):
        for open_a_level, expected_open in ((1, (1, 0)), (0, (0, 1))):
            with self.subTest(open_a_level=open_a_level):
                motor = self.make_motor(open_a_level=open_a_level)
                motor.start(1)
                self.assertEqual((motor.direction_a.current, motor.direction_b.current), expected_open)
                motor.start(-1)
                self.assertEqual((motor.direction_a.current, motor.direction_b.current), expected_open[::-1])

    def test_reversal_setting_flips_open_and_close_direction(self):
        motor = self.make_motor(open_a_level=1, reversed_value=False)
        motor.start(1)
        normal_open = (motor.direction_a.current, motor.direction_b.current)
        motor.stop()
        motor.set_direction_reversed(True)
        motor.start(1)
        self.assertEqual((motor.direction_a.current, motor.direction_b.current), normal_open[::-1])

    def test_reversal_change_stops_motor_but_preserves_timed_position(self):
        motor = self.make_motor()
        motor.position = 42.5
        motor.start(1, target=100)
        motor.set_direction_reversed(True)
        self.assertFalse(motor.direction)
        self.assertEqual(motor.position, 42.5)
        self.assertTrue(motor.direction_reversed)


if __name__ == "__main__":
    unittest.main()