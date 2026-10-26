import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import test_connectivity


class Motor:
    def __init__(self):
        self.position = 0
        self.target = None
        self.target_position = None
        self.speed = None

    @property
    def moving(self):
        return self.target is not None

    def snapshot(self):
        return self.position

    def set_position(self, pulses):
        self.position = pulses

    def zero(self):
        self.set_position(0)

    def move_turns(self, turns, direction, speed):
        if self.moving:
            raise ValueError('Movimiento activo')
        self.target = self.position + int(turns * 1980) * direction
        self.speed = speed

    def complete(self):
        self.position = self.target
        self.target = None

    def stop(self):
        self.target = None


class CalibrationTest(unittest.TestCase):
    load = staticmethod(test_connectivity.FirmwareTest.load)

    def setUp(self):
        test_connectivity.FirmwareTest.setUp(self)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.main.CALIBRATION_FILE = str(Path(directory.name) / 'calibration.json')
        self.motor = Motor()
        self.main.motor = self.motor
        self.acks = []
        self.main.acknowledge = lambda *args: self.acks.append(args)
        self.telemetry = []
        self.main.send_telemetry = lambda: self.telemetry.append(dict(self.main.calibration))
        self.sequence = 0

    def command(self, name, payload=None, success=True):
        self.sequence += 1
        self.main.execute({'id': self.sequence, 'name': name, 'payload': payload or {}})
        if success and self.motor.moving:
            self.assertEqual(self.main.pending_motion_command, self.sequence)
        else:
            self.assertEqual(self.acks[-1][1], 'succeeded' if success else 'failed', self.acks[-1])

    def begin(self):
        self.command('tenstar.calibration.begin', {'atOpen': True})
        self.assertEqual(self.motor.position, 0)
        self.assertFalse(self.motor.moving)
        self.assertTrue(self.main.position_valid)
        self.assertTrue(self.telemetry[-1]['active'])

    def direction(self, movement):
        self.command('tenstar.calibration.testDirection')
        self.assertEqual(self.motor.target, 99)
        self.assertLessEqual(self.motor.speed, 35)
        self.motor.complete()
        self.command('tenstar.calibration.confirmDirection', {'movement': movement})

    def calibrated(self, movement):
        self.begin()
        self.direction(movement)
        self.command('tenstar.calibration.step', {'turns': 2, 'direction': 'down'})
        self.motor.complete()
        span = abs(self.motor.position)
        self.command('tenstar.calibration.setClosed')
        self.assertEqual(self.motor.position, 0)
        self.assertEqual(self.main.calibration['open_span_pulses'], span)
        self.assertTrue(self.main.calibration['calibrated'])
        self.assertTrue(self.telemetry[-1]['calibrated'])
        return span

    def test_open_closed_and_percentage_mapping_both_motor_directions(self):
        for movement, open_sign in [('down', -1), ('up', 1)]:
            with self.subTest(movement=movement):
                span = self.calibrated(movement)
                self.assertEqual(self.main.calibration['open_direction'], open_sign)
                for name, payload, percent in [
                    ('curtain.open', {}, 100),
                    ('curtain.move', {'percent': 50}, 50),
                    ('curtain.close', {}, 0),
                ]:
                    self.command(name, payload)
                    if self.motor.moving:
                        self.assertLessEqual(abs(self.motor.target - round(percent * span / 100) * open_sign), 1)
                        self.motor.complete()
                    self.assertEqual(self.motor.target_position, percent)

    def test_reboot_load_preserves_span_but_requires_reference(self):
        span = self.calibrated('up')
        self.main.position_valid = False
        self.main.load_calibration()
        self.assertEqual(self.main.calibration['open_span_pulses'], span)
        self.command('curtain.open', success=False)
        self.command('tenstar.calibration.referenceOpen')
        self.assertEqual(self.motor.position, span)
        self.assertEqual(self.motor.target_position, 100)
        self.command('curtain.close')
        self.assertEqual(self.motor.target, 0)

    def test_incomplete_calibration_cannot_resume_after_reboot(self):
        self.begin()
        self.direction('down')
        self.main.position_valid = False
        self.main.load_calibration()
        self.assertFalse(self.main.calibration['active'])
        self.command('tenstar.calibration.step', {'turns': 1, 'direction': 'down'}, success=False)

    def test_existing_closed_first_calibration_can_be_referenced(self):
        Path(self.main.CALIBRATION_FILE).write_text(json.dumps({
            'calibrated': True, 'closed_marked': True, 'open_marked': True,
            'open_span_pulses': 5000, 'open_direction': -1,
        }))
        self.main.load_calibration()
        self.command('tenstar.calibration.referenceOpen')
        self.assertEqual(self.motor.position, -5000)
        self.command('curtain.close')
        self.assertEqual(self.motor.target, 0)

    def test_transition_validation_no_zeroing_on_unconfirmed_open(self):
        self.motor.position = 123
        self.command('tenstar.calibration.begin', {'atOpen': False}, success=False)
        self.assertEqual(self.motor.position, 123)
        self.command('tenstar.calibration.setClosed', success=False)
        self.begin()
        self.command('tenstar.calibration.confirmDirection', {'movement': 'down'}, success=False)
        self.command('tenstar.calibration.step', {'turns': 1, 'direction': 'down'}, success=False)
        self.command('tenstar.calibration.setClosed', success=False)

    def test_test_requires_real_encoder_pulses_and_cannot_be_repeated(self):
        self.begin()
        self.command('tenstar.calibration.testDirection')
        self.motor.stop()
        self.command('tenstar.calibration.confirmDirection', {'movement': 'down'}, success=False)
        self.command('tenstar.calibration.testDirection', success=False)
        self.command('tenstar.calibration.begin', {'atOpen': True})

    def test_steps_respect_open_reference_and_twenty_turn_limit(self):
        self.begin()
        self.direction('down')
        for payload in [
            {'turns': 1, 'direction': 'up'},
            {'turns': 20, 'direction': 'down'},
            {'turns': 0, 'direction': 'down'},
            {'turns': float('nan'), 'direction': 'down'},
            {'turns': True, 'direction': 'down'},
            {'turns': 1, 'direction': 'left'},
        ]:
            self.command('tenstar.calibration.step', payload, success=False)
            self.assertFalse(self.motor.moving)
        self.command('tenstar.calibration.step', {'turns': 0.5, 'direction': 'down'})
        self.motor.complete()
        self.command('tenstar.calibration.step', {'turns': 0.25, 'direction': 'up'})
        self.assertEqual(self.motor.target, 594)

    def test_stop_interrupts_step_and_remains_available_during_calibration(self):
        self.begin()
        self.direction('down')
        self.command('tenstar.calibration.step', {'turns': 2, 'direction': 'down'})
        interrupted = self.sequence
        self.command('tenstar.calibration.setClosed', success=False)
        self.command('curtain.stop')
        self.assertIn((interrupted, 'failed', 'Movimiento detenido por comando de parada'), self.acks)
        self.assertFalse(self.motor.moving)

    def test_persistence_failure_invalidates_reference_and_reports_error(self):
        self.calibrated('down')
        self.main.save_calibration = lambda: (_ for _ in ()).throw(OSError('flash full'))
        self.command('tenstar.calibration.referenceOpen', success=False)
        self.assertIn('flash full', str(self.acks[-1][2]))
        self.assertFalse(self.main.position_valid)
        self.assertFalse(self.main.calibration['calibrated'])
        self.command('curtain.close', success=False)

    def test_small_down_steps_recover_an_upward_direction_test(self):
        self.begin()
        self.direction('up')
        self.command('tenstar.calibration.step', {'turns': 0.01, 'direction': 'up'}, success=False)
        self.command('tenstar.calibration.step', {'turns': 0.01, 'direction': 'down'})
        self.assertEqual(self.motor.target, 80)
        self.motor.complete()
        self.command('tenstar.calibration.step', {'turns': 0.1, 'direction': 'down'})
        self.assertEqual(self.motor.target, -118)

    def test_real_driver_reference_is_atomic_and_target_motion_restores_timeout(self):
        class Pin:
            IN = PULL_UP = IRQ_RISING = IRQ_FALLING = 1

            def __init__(self, *_args):
                pass

            def value(self):
                return 0

            def irq(self, **_kwargs):
                pass

        irq_calls = []
        self.machine.Pin = Pin
        self.machine.PWM = lambda *_args, **_kwargs: types.SimpleNamespace(duty_u16=lambda _value: None)
        self.machine.disable_irq = lambda: irq_calls.append('disable') or 7
        self.machine.enable_irq = lambda state: irq_calls.append(state)
        with patch.dict(sys.modules, {'micropython': types.SimpleNamespace(alloc_emergency_exception_buf=lambda _size: None)}):
            driver = self.load('tenstar_motor').TenstarMotor()
            driver.set_position(-300)
            self.assertEqual(irq_calls, ['disable', 7])
            self.assertEqual(driver.snapshot(), -300)
            driver.motion_timeout_ms = 350
            driver.move_turns(0.5, 1, 25)
            self.assertEqual(driver.target, 690)
            self.assertEqual(driver.motion_timeout_ms, 60000)
            driver.stop()
            driver.zero()
            self.assertEqual(driver.snapshot(), 0)


if __name__ == '__main__':
    unittest.main()
