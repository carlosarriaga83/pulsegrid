import importlib.util
import pathlib
import sys
import types
import unittest


SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'cortina.py'


class FakeTime:
    @staticmethod
    def ticks_ms():
        return 1000

    @staticmethod
    def ticks_diff(first, second):
        return first - second


class FakeBus:
    MAX_SPEED = 3073

    def __init__(self, position):
        self.current_position = position
        self.calls = []

    def position(self, _servo_id):
        return self.current_position

    def torque(self, _servo_id, enabled):
        self.calls.append(('torque', enabled))

    def set_mode(self, _servo_id, mode):
        self.calls.append(('mode', mode))

    def move(self, _servo_id, position, speed, acceleration):
        self.calls.append(('move', position, speed, acceleration))


class CalibrationCompletionTests(unittest.TestCase):
    def test_a_turn_stopping_two_counts_short_is_completed_not_stalled(self):
        previous_time = sys.modules.get('time')
        previous_stservo = sys.modules.get('stservo')
        stservo = types.ModuleType('stservo')
        stservo.STServoBus = object
        stservo.STServoError = type('STServoError', (Exception,), {})
        sys.modules['time'] = FakeTime
        sys.modules['stservo'] = stservo
        try:
            spec = importlib.util.spec_from_file_location('cortina_test_subject', SOURCE)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        finally:
            if previous_time is None:
                sys.modules.pop('time', None)
            else:
                sys.modules['time'] = previous_time
            if previous_stservo is None:
                sys.modules.pop('stservo', None)
            else:
                sys.modules['stservo'] = previous_stservo

        controller = object.__new__(module.Cortina)
        controller.servo_ids = (1,)
        controller.bus = FakeBus(position=998)
        controller.multiturn_tasks = {1: {
            'position_mode': True,
            'direction': 1,
            'target_counts': 4096,
            'moved_counts': 4092,
            'remaining_counts': 4,
            'net_counts': -4092,
            'started_at': 0,
            'last_progress_at': 900,
            'encoder_read_error_at': None,
            'timeout_ms': 120000,
            'start_turns': -3.9253,
            'start_position': 1000,
            'speed': 120,
            'acceleration': 30,
        }}
        controller.multiturn_active = {1: True}
        controller.absolute_turns = {1: -3.9253}
        controller.position_recovery_required = {1: True}
        controller.blind_config = {1: {'calibrated': False, 'calibration_motion_fault': False,
                                       'calibration_motion_fault_reason': ''}}
        controller._last_positions = {1: 1000}
        controller._last_saved_turns = {1: -3.9253}
        controller._save_persistent_state = lambda: None

        controller.update_multiturn()

        self.assertFalse(controller.multiturn_active[1])
        self.assertIsNone(controller.multiturn_tasks[1])
        self.assertFalse(controller.blind_config[1]['calibration_motion_fault'])
        self.assertEqual(controller.blind_config[1]['calibration_motion_fault_reason'], '')
        self.assertAlmostEqual(controller.absolute_turns[1], -4.9248, places=4)


if __name__ == '__main__':
    unittest.main()