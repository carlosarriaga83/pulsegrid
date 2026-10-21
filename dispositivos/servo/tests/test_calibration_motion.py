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


def load_cortina_module(name):
    previous_time = sys.modules.get('time')
    previous_stservo = sys.modules.get('stservo')
    stservo = types.ModuleType('stservo')
    stservo.STServoBus = object
    stservo.STServoError = type('STServoError', (Exception,), {})
    sys.modules['time'] = FakeTime
    sys.modules['stservo'] = stservo
    try:
        spec = importlib.util.spec_from_file_location(name, SOURCE)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        if previous_time is None:
            sys.modules.pop('time', None)
        else:
            sys.modules['time'] = previous_time
        if previous_stservo is None:
            sys.modules.pop('stservo', None)
        else:
            sys.modules['stservo'] = previous_stservo


class CalibrationCompletionTests(unittest.TestCase):
    def test_calibrated_targets_and_reported_percentages_respect_each_motor_side(self):
        module = load_cortina_module('cortina_motor_side_direction_test')
        controller = object.__new__(module.Cortina)
        controller.servo_ids = (1, 2)
        controller.direction_reversed = False
        controller.blind_config = {
            1: {'rolled_turns': 0.0, 'unrolled_turns': 1.0, 'motor_side': 'left', 'calibrated': True, 'calibration_in_progress': False},
            2: {'rolled_turns': 0.0, 'unrolled_turns': 1.0, 'motor_side': 'right', 'calibrated': True, 'calibration_in_progress': False},
        }
        controller.position_recovery_required = {1: False, 2: False}
        controller.absolute_turns = {1: 0.5, 2: 0.5}
        controller.blind_targets = {1: {'percent': 50.0}, 2: {'percent': 50.0}}
        controller.multiturn_active = {1: False, 2: False}
        controller.update_multiturn = lambda: None
        targets = []
        controller._start_multiturn = lambda servo_id, turns, speed, acceleration: targets.append((servo_id, turns))
        controller._save_persistent_state = lambda: None

        controller.move_blind(1, 51)
        controller.move_blind(2, 51)
        self.assertEqual([servo_id for servo_id, _ in targets], [1, 2])
        self.assertAlmostEqual(targets[0][1], 0.01)
        self.assertAlmostEqual(targets[1][1], -0.01)
        self.assertEqual(controller.blind_status(1)['percent'], 50.0)
        self.assertEqual(controller.blind_status(2)['percent'], 50.0)

        for percent in (52, 53):
            for servo_id in (1, 2):
                current = controller.absolute_turns[servo_id]
                controller.move_blind(servo_id, percent)
                controller.absolute_turns[servo_id] = controller._calibrated_target(servo_id, percent)
                self.assertGreater((controller.absolute_turns[servo_id] - current) * (1 if servo_id == 1 else -1), 0)
        self.assertEqual([1 if turns > 0 else -1 for _, turns in targets], [1, -1, 1, -1, 1, -1])

        controller.absolute_turns = {1: 0.5, 2: 0.5}
        controller.direction_reversed = True
        self.assertAlmostEqual(controller._calibrated_target(1, 51), 0.49)
        self.assertAlmostEqual(controller._calibrated_target(2, 51), 0.51)
        self.assertEqual(controller.blind_status(1)['percent'], 50.0)
        self.assertEqual(controller.blind_status(2)['percent'], 50.0)

    def test_repeating_the_same_percent_corrects_encoder_position_drift(self):
        module = load_cortina_module('cortina_absolute_setpoint_test')
        controller = object.__new__(module.Cortina)
        controller.servo_ids = (1,)
        controller.direction_reversed = False
        controller.blind_config = {1: {'rolled_turns': 0.0, 'unrolled_turns': 1.0, 'motor_side': 'left', 'calibrated': True, 'calibration_in_progress': False}}
        controller.position_recovery_required = {1: False}
        controller.absolute_turns = {1: 0.50}
        controller.blind_targets = {1: {'percent': 63.0}}
        controller.multiturn_active = {1: False}
        controller.update_multiturn = lambda: None
        controller._save_persistent_state = lambda: None
        commands = []
        controller._start_multiturn = lambda servo_id, turns, speed, acceleration: commands.append((servo_id, turns))

        controller.move_blind(1, 63)

        self.assertEqual(len(commands), 1)
        self.assertAlmostEqual(commands[0][1], 0.13)

    def test_cloud_encoder_reference_recovery_is_stationary_and_invalidates_old_limits(self):
        module = load_cortina_module('cortina_reference_recovery_test')
        controller = object.__new__(module.Cortina)
        controller.servo_ids = (1,)
        controller.bus = FakeBus(position=1420)
        controller.multiturn_active = {1: False}
        controller.blind_config = {1: {'calibration_in_progress': True, 'calibrated': True,
                                       'calibration_motion_fault': True, 'calibration_motion_fault_reason': 'encoder_read'}}
        controller.blind_targets = {1: {'percent': 85.0, 'speed': 900, 'acceleration': 60}}
        controller.absolute_turns = {1: 12.75}
        controller.position_recovery_required = {1: True}
        controller._last_positions = {1: 3000}
        controller._last_saved_turns = {1: 12.75}
        controller._save_persistent_state = lambda: None

        controller.recover_position_reference(1)

        self.assertEqual(controller.absolute_turns[1], 0.0)
        self.assertEqual(controller._last_positions[1], 1420)
        self.assertEqual(controller._last_saved_turns[1], 0.0)
        self.assertFalse(controller.position_recovery_required[1])
        self.assertFalse(controller.blind_config[1]['calibrated'])
        self.assertFalse(controller.blind_config[1]['calibration_in_progress'])
        self.assertFalse(controller.blind_config[1]['calibration_motion_fault'])
        self.assertEqual(controller.blind_targets[1]['percent'], 50.0)
        self.assertEqual(controller.bus.calls, [])

    def test_cloud_encoder_reference_recovery_rejects_active_motion(self):
        module = load_cortina_module('cortina_active_reference_recovery_test')
        controller = object.__new__(module.Cortina)
        controller.servo_ids = (1,)
        controller.bus = FakeBus(position=1420)
        controller.multiturn_active = {1: True}
        controller.blind_config = {1: {'calibration_in_progress': False}}

        with self.assertRaisesRegex(ValueError, 'durante un movimiento'):
            controller.recover_position_reference(1)
        self.assertEqual(controller.bus.calls, [])

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