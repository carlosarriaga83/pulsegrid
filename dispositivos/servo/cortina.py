import os
import time

from stservo import STServoBus, STServoError


class Cortina:
    COUNTS_PER_TURN = 4096
    MAX_LONG_TURNS = 999.99
    MAX_SPEED = 3073
    MAX_ACCELERATION = 150
    APPROACH_SPEED = 120
    MAX_CURTAIN_SPEED = 240
    FINAL_APPROACH_SPEED = 60
    CALIBRATION_STEP_SPEED = 240
    PRECISION_COMPLETION_TOLERANCE_COUNTS = 16
    APPROACH_COUNTS = COUNTS_PER_TURN // 16
    # Accept up to 20 degrees of rotor coast after wheel-mode stop; this is
    # about 5.6% of a turn and should not invalidate the encoder reference.
    MOVEMENT_POSITION_TOLERANCE_COUNTS = int(COUNTS_PER_TURN * 20 / 360 + 0.5)
    MOVEMENT_STALL_TIMEOUT_MS = 15000
    POSITION_TOLERANCE_PERCENT = 0.05
    def __init__(self, uart, i2c=None, servo_ids=(1, 2), direction_reversed=False):
        self.bus = STServoBus(uart)
        self.direction_reversed = bool(direction_reversed)
        self.known_servo_ids = tuple(servo_ids)
        self.absolute_turns = {servo_id: 0.0 for servo_id in self.known_servo_ids}
        self.position_recovery_required = {servo_id: True for servo_id in self.known_servo_ids}
        self.blind_config = {
            servo_id: {
                'rolled_turns': 0.0, 'unrolled_turns': 10.0, 'motor_side': 'left', 'calibrated': False,
                'calibration_in_progress': False, 'window_height_cm': 0.0,
                'tube_diameter_cm': 0.0, 'fabric_thickness_mm': 0.0, 'motor_turns_per_tube_turn': 1.0,
                'estimated_turns': 0.0, 'half_travel_limit': 0.0,
                'calibration_midpoint_turns': 0.0, 'calibration_down_direction': 0,
                'calibration_direction_pending': False,
                'calibration_motion_fault': False,
                'calibration_motion_fault_reason': '',
            }
            for servo_id in self.known_servo_ids
        }
        self.blind_targets = {
            servo_id: {'percent': 50.0, 'speed': 800, 'acceleration': 50}
            for servo_id in self.known_servo_ids
        }
        self.multiturn_tasks = {servo_id: None for servo_id in self.known_servo_ids}
        self.multiturn_active = {servo_id: False for servo_id in self.known_servo_ids}
        self.calibration_references = {servo_id: set() for servo_id in self.known_servo_ids}
        self._last_positions = {}
        self._last_saved_turns = dict(self.absolute_turns)
        self._recover_state_file('blind_state.py')
        self._recover_state_file('multiturn_state.py')
        self._load_persistent_state()
        self.servo_ids = tuple(servo_id for servo_id in self.known_servo_ids if self.bus.ping(servo_id))
        active_ids = set(self.servo_ids)
        self.multiturn_tasks = {servo_id: None for servo_id in active_ids}
        self.multiturn_active = {servo_id: False for servo_id in active_ids}
        self.calibration_references = {}
        for servo_id in self.servo_ids:
            try:
                self._last_positions[servo_id] = self.bus.position(servo_id)
            except (STServoError, OSError):
                self._last_positions[servo_id] = 0
        self._save_persistent_state()

    def _load_persistent_state(self):
        try:
            from blind_state import BLIND_CONFIG, BLIND_TARGETS, DIRECTION_REVERSED
            self.direction_reversed = bool(DIRECTION_REVERSED)
            for servo_id in self.known_servo_ids:
                saved = BLIND_CONFIG.get(servo_id, {})
                config = self.blind_config[servo_id]
                config['rolled_turns'] = float(saved.get('rolled_turns', config['rolled_turns']))
                config['unrolled_turns'] = float(saved.get('unrolled_turns', config['unrolled_turns']))
                config['motor_side'] = str(saved.get('motor_side', config['motor_side'])) if saved.get('motor_side', config['motor_side']) in ('left', 'right') else 'left'
                config['calibrated'] = bool(saved.get('calibrated', False))
                for key in ('window_height_cm', 'tube_diameter_cm', 'fabric_thickness_mm', 'motor_turns_per_tube_turn', 'estimated_turns', 'half_travel_limit', 'calibration_midpoint_turns'):
                    try:
                        config[key] = float(saved.get(key, config[key]))
                    except (TypeError, ValueError):
                        pass
                config['calibration_in_progress'] = bool(saved.get('calibration_in_progress', False))
                config['calibration_down_direction'] = int(saved.get('calibration_down_direction', 0))
                config['calibration_direction_pending'] = bool(saved.get('calibration_direction_pending', False))
                config['calibration_motion_fault'] = bool(saved.get('calibration_motion_fault', False))
                config['calibration_motion_fault_reason'] = str(saved.get('calibration_motion_fault_reason', ''))
                target = BLIND_TARGETS.get(servo_id, {})
                self.blind_targets[servo_id]['percent'] = float(target.get('percent', 50.0))
                self.blind_targets[servo_id]['speed'] = int(target.get('speed', 800))
                self.blind_targets[servo_id]['acceleration'] = int(target.get('acceleration', 50))
        except (ImportError, AttributeError, TypeError, ValueError):
            pass
        try:
            from multiturn_state import ABSOLUTE_TURNS, RECOVERY_REQUIRED
            for servo_id in self.known_servo_ids:
                self.absolute_turns[servo_id] = float(ABSOLUTE_TURNS.get(servo_id, 0.0))
                self.position_recovery_required[servo_id] = bool(RECOVERY_REQUIRED.get(servo_id, True))
        except (ImportError, AttributeError, TypeError, ValueError):
            pass

    @staticmethod
    def _recover_state_file(filename):
        backup = filename + '.bak'
        try:
            os.stat(filename)
            exists = True
        except OSError:
            exists = False
        try:
            os.stat(backup)
            backup_exists = True
        except OSError:
            backup_exists = False
        if not exists and backup_exists:
            os.rename(backup, filename)
        elif exists and backup_exists:
            os.remove(backup)

    @staticmethod
    def _write_state_file(filename, content):
        temporary = filename + '.tmp'
        backup = filename + '.bak'
        with open(temporary, 'w') as state_file:
            state_file.write(content)
        try:
            os.remove(backup)
        except OSError:
            pass
        try:
            os.stat(filename)
            exists = True
        except OSError:
            exists = False
        if exists:
            os.rename(filename, backup)
        try:
            os.rename(temporary, filename)
        except Exception:
            if exists:
                try:
                    os.rename(backup, filename)
                except OSError:
                    pass
            raise
        try:
            os.remove(backup)
        except OSError:
            pass

    def _save_persistent_state(self):
        blind_config = {servo_id: dict(values) for servo_id, values in self.blind_config.items()}
        blind_targets = {servo_id: dict(values) for servo_id, values in self.blind_targets.items()}
        blind_state = 'BLIND_CONFIG = {!r}\nBLIND_TARGETS = {!r}\nDIRECTION_REVERSED = {!r}\n'.format(
            blind_config, blind_targets, self.direction_reversed)
        self._write_state_file('blind_state.py', blind_state)
        absolute = {servo_id: round(value, 4) for servo_id, value in self.absolute_turns.items()}
        recovery = {servo_id: bool(value) for servo_id, value in self.position_recovery_required.items()}
        multiturn_state = 'ABSOLUTE_TURNS = {!r}\nRECOVERY_REQUIRED = {!r}\n'.format(absolute, recovery)
        self._write_state_file('multiturn_state.py', multiturn_state)

    def set_direction_reversed(self, reversed_value):
        self.direction_reversed = bool(reversed_value)
        self._save_persistent_state()

    def recover_position_reference(self, servo_id):
        if servo_id not in self.servo_ids:
            raise ValueError('ID de servo no detectado')
        if self.multiturn_active[servo_id]:
            raise ValueError('no se puede recuperar la referencia durante un movimiento')
        position = self.bus.position(servo_id)
        motor_side = self.blind_config[servo_id].get('motor_side', 'left')
        self._last_positions[servo_id] = position
        self.absolute_turns[servo_id] = 0.0
        self._last_saved_turns[servo_id] = 0.0
        self.position_recovery_required[servo_id] = False
        self.blind_config[servo_id] = {
            'rolled_turns': 0.0,
            'unrolled_turns': 10.0,
            'motor_side': motor_side if motor_side in ('left', 'right') else 'left',
            'calibrated': False,
            'calibration_in_progress': False,
            'window_height_cm': 0.0,
            'tube_diameter_cm': 0.0,
            'fabric_thickness_mm': 0.0,
            'motor_turns_per_tube_turn': 1.0,
            'estimated_turns': 0.0,
            'half_travel_limit': 0.0,
            'calibration_midpoint_turns': 0.0,
            'calibration_down_direction': 0,
            'calibration_direction_pending': False,
            'calibration_motion_fault': False,
            'calibration_motion_fault_reason': '',
        }
        self.calibration_references[servo_id] = set()
        self.blind_targets[servo_id] = {'percent': 50.0, 'speed': 800, 'acceleration': 50}
        self._save_persistent_state()

    def position(self, servo_id):
        return self.bus.position(servo_id)

    def _track_position(self, servo_id, position):
        previous = self._last_positions.get(servo_id, position)
        delta = position - previous
        if delta > self.COUNTS_PER_TURN // 2:
            delta -= self.COUNTS_PER_TURN
        elif delta < -self.COUNTS_PER_TURN // 2:
            delta += self.COUNTS_PER_TURN
        self.absolute_turns[servo_id] += delta / self.COUNTS_PER_TURN
        self._last_positions[servo_id] = position
        return delta

    def update_multiturn(self):
        checkpoint = False
        for servo_id in self.servo_ids:
            try:
                task = self.multiturn_tasks[servo_id]
                if task is not None and task.get('position_mode'):
                    position = self.bus.position(servo_id)
                    task['encoder_read_error_at'] = None
                    delta = self._track_position(servo_id, position)
                    task['net_counts'] += delta
                    task['moved_counts'] = abs(task['net_counts'])
                    if delta != 0:
                        task['last_progress_at'] = time.ticks_ms()
                    task['remaining_counts'] = max(0, task['target_counts'] - task['moved_counts'])
                    self.absolute_turns[servo_id] = task['start_turns'] + task['net_counts'] / self.COUNTS_PER_TURN
                    if task['moved_counts'] >= task['target_counts'] - self.PRECISION_COMPLETION_TOLERANCE_COUNTS:
                        self._finish_multiturn(servo_id, completed=True)
                    elif time.ticks_diff(time.ticks_ms(), task['last_progress_at']) >= self.MOVEMENT_STALL_TIMEOUT_MS:
                        self._finish_multiturn(servo_id, timed_out=True, fault_reason='encoder_stall')
                    elif time.ticks_diff(time.ticks_ms(), task['started_at']) >= task['timeout_ms']:
                        self._finish_multiturn(servo_id, timed_out=True, fault_reason='movement_timeout')
                    continue
                position = self.bus.position(servo_id)
            except (STServoError, OSError):
                task = self.multiturn_tasks[servo_id]
                if task is not None:
                    now = time.ticks_ms()
                    if task['encoder_read_error_at'] is None:
                        task['encoder_read_error_at'] = now
                    elif time.ticks_diff(now, task['encoder_read_error_at']) >= 3000:
                        self._finish_multiturn(servo_id, timed_out=True, fault_reason='encoder_read')
                continue
            delta = self._track_position(servo_id, position)
            task = self.multiturn_tasks[servo_id]
            if task is None:
                continue
            task['encoder_read_error_at'] = None
            if delta != 0:
                task['last_progress_at'] = time.ticks_ms()
            task['moved_counts'] += delta * task['direction']
            if task['moved_counts'] >= task['target_counts']:
                self._finish_multiturn(servo_id, completed=True)
            elif task['target_counts'] - task['moved_counts'] <= self.APPROACH_COUNTS and not task['slowing']:
                self.bus.move_wheel(servo_id, task['direction'] * min(task['speed'], self.FINAL_APPROACH_SPEED), acceleration=task['acceleration'])
                task['slowing'] = True
            elif time.ticks_diff(time.ticks_ms(), task['last_progress_at']) >= self.MOVEMENT_STALL_TIMEOUT_MS:
                self._finish_multiturn(servo_id, timed_out=True, fault_reason='encoder_stall')
            elif time.ticks_diff(time.ticks_ms(), task['started_at']) >= task['timeout_ms']:
                self._finish_multiturn(servo_id, timed_out=True, fault_reason='movement_timeout')
            elif abs(self.absolute_turns[servo_id] - self._last_saved_turns[servo_id]) >= 0.5:
                self._last_saved_turns[servo_id] = self.absolute_turns[servo_id]
                checkpoint = True
        if checkpoint:
            self._save_persistent_state()

    def _finish_multiturn(self, servo_id, completed=False, timed_out=False, fault_reason=''):
        task = self.multiturn_tasks[servo_id]
        if task is None:
            return
        try:
            if task.get('position_mode'):
                self.bus.torque(servo_id, False)
                self.bus.set_mode(servo_id, 0)
                self.bus.torque(servo_id, True)
                if completed:
                    hold_position = self._last_positions.get(servo_id, task['start_position'])
                else:
                    hold_position = self.bus.position(servo_id)
                self.bus.move(servo_id, hold_position, speed=max(1, min(task['speed'], self.APPROACH_SPEED)), acceleration=task['acceleration'])
                self._last_positions[servo_id] = int(hold_position)
            else:
                self.bus.move_wheel(servo_id, 0, acceleration=50)
                self.bus.torque(servo_id, False)
                self.bus.set_mode(servo_id, 0)
                self.bus.torque(servo_id, True)
                hold_position = self.bus.position(servo_id)
                self._track_position(servo_id, hold_position)
                self.bus.move(servo_id, hold_position, speed=min(task['speed'], self.APPROACH_SPEED), acceleration=task['acceleration'])
        except (STServoError, OSError, ValueError):
            pass
        if completed and not task.get('position_mode'):
            target_error = abs(self.absolute_turns[servo_id] - task['target_turns']) * self.COUNTS_PER_TURN
            if target_error > self.MOVEMENT_POSITION_TOLERANCE_COUNTS:
                completed = False
                timed_out = True
                fault_reason = 'position_overshoot'
        if completed and task.get('position_mode'):
            self.absolute_turns[servo_id] = task['start_turns'] + task['net_counts'] / self.COUNTS_PER_TURN
        if not fault_reason:
            fault_reason = 'movement_timeout' if timed_out else 'movement_stopped' if not completed else ''
        task['completed'] = bool(completed)
        task['timed_out'] = bool(timed_out)
        task['fault_reason'] = fault_reason
        self.multiturn_tasks[servo_id] = None
        self.multiturn_active[servo_id] = False
        self.position_recovery_required[servo_id] = not (completed and self.blind_config[servo_id]['calibrated'])
        if timed_out and self.blind_config[servo_id].get('calibration_in_progress'):
            self.blind_config[servo_id]['calibration_motion_fault'] = True
            self.blind_config[servo_id]['calibration_motion_fault_reason'] = fault_reason or 'movement_timeout'
        self._last_saved_turns[servo_id] = self.absolute_turns[servo_id]
        self._save_persistent_state()

    def _start_precision_multiturn(self, servo_id, turns, speed=120, acceleration=30):
        if servo_id not in self.servo_ids:
            raise ValueError('ID de servo no detectado')
        if self.multiturn_active[servo_id]:
            raise ValueError('el servo ya esta en movimiento')
        if not -7.99 <= turns <= 7.99 or turns == 0:
            raise ValueError('vueltas de precision fuera de rango')
        speed = int(speed)
        acceleration = int(acceleration)
        if not 0 <= speed <= self.MAX_SPEED or not 0 <= acceleration <= self.MAX_ACCELERATION:
            raise ValueError('velocidad o aceleracion fuera de rango')
        self.bus.torque(servo_id, False)
        self.bus.set_mode(servo_id, 0)
        self.bus.torque(servo_id, True)
        try:
            self.bus.torque(servo_id, False)
            self.bus.set_mode(servo_id, 3)
            self.bus.torque(servo_id, True)
            start_position = self.bus.position(servo_id)
            self._last_positions[servo_id] = start_position
            direction = 1 if turns > 0 else -1
            target_counts = int(round(abs(turns) * self.COUNTS_PER_TURN))
            self.bus.move_multiturn(servo_id, turns, start_position, speed, acceleration)
        except (STServoError, OSError, ValueError):
            try:
                self.bus.torque(servo_id, False)
                self.bus.set_mode(servo_id, 0)
                self.bus.torque(servo_id, True)
            except (STServoError, OSError, ValueError):
                pass
            raise
        self.multiturn_tasks[servo_id] = {
            'direction': direction,
            'target_counts': target_counts,
            'moved_counts': 0,
            'net_counts': 0,
            'remaining_counts': target_counts,
            'started_at': time.ticks_ms(),
            'last_progress_at': time.ticks_ms(),
            'encoder_read_error_at': None,
            'timeout_ms': max(15000, int(target_counts / max(speed, 1) * 5000 + 10000)),
            'start_turns': self.absolute_turns[servo_id],
            'start_position': start_position,
            'speed': speed,
            'acceleration': acceleration,
            'position_mode': True,
        }
        self.multiturn_active[servo_id] = True
        self.position_recovery_required[servo_id] = True
        self._save_persistent_state()

    def _start_multiturn(self, servo_id, turns, speed=800, acceleration=50):
        if servo_id not in self.servo_ids:
            raise ValueError('ID de servo no detectado')
        if self.multiturn_active[servo_id]:
            raise ValueError('el servo ya esta en movimiento')
        if not -self.MAX_LONG_TURNS <= turns <= self.MAX_LONG_TURNS or turns == 0:
            raise ValueError('vueltas fuera de rango')
        speed = int(speed)
        acceleration = int(acceleration)
        if not 1 <= speed <= self.MAX_SPEED or not 0 <= acceleration <= self.MAX_ACCELERATION:
            raise ValueError('velocidad o aceleracion fuera de rango')
        speed = min(speed, self.MAX_CURTAIN_SPEED)
        current = self.bus.position(servo_id)
        self._last_positions[servo_id] = current
        self.bus.torque(servo_id, False)
        self.bus.set_mode(servo_id, 1)
        self.bus.torque(servo_id, True)
        direction = 1 if turns > 0 else -1
        target_counts = int(round(abs(turns) * self.COUNTS_PER_TURN))
        start_turns = self.absolute_turns[servo_id]
        initial_speed = min(speed, self.APPROACH_SPEED) if target_counts <= self.APPROACH_COUNTS else speed
        self.multiturn_tasks[servo_id] = {
            'direction': direction,
            'target_counts': target_counts,
            'moved_counts': 0,
            'started_at': time.ticks_ms(),
            'last_progress_at': time.ticks_ms(),
            'encoder_read_error_at': None,
            'timeout_ms': max(5000, int(target_counts / max(speed, 1) * 2500 + 3000)),
            'start_turns': start_turns,
            'target_turns': start_turns + turns,
            'start_position': current,
            'speed': speed,
            'acceleration': acceleration,
            'position_mode': False,
            'slowing': initial_speed != speed,
        }
        self.multiturn_active[servo_id] = True
        self.position_recovery_required[servo_id] = True
        self.bus.move_wheel(servo_id, direction * initial_speed, acceleration=acceleration)
        self._save_persistent_state()

    def _calibrated_target(self, servo_id, percent):
        config = self.blind_config[servo_id]
        start = config['rolled_turns']
        end = config['unrolled_turns']
        reverse_percent = config.get('motor_side', 'left') == 'right'
        if self.direction_reversed:
            reverse_percent = not reverse_percent
        if reverse_percent:
            percent = 100 - percent
        return start + (end - start) * percent / 100

    def move_blind(self, servo_id, percent, speed=800, acceleration=50):
        if servo_id not in self.servo_ids or not 0 <= float(percent) <= 100:
            raise ValueError('servo o posicion invalida')
        speed = int(speed)
        acceleration = int(acceleration)
        if not 1 <= speed <= self.MAX_SPEED or not 0 <= acceleration <= self.MAX_ACCELERATION:
            raise ValueError('velocidad o aceleracion fuera de rango')
        speed = min(speed, self.MAX_CURTAIN_SPEED)
        percent = float(percent)
        config = self.blind_config[servo_id]
        if config.get('calibration_in_progress'):
            raise ValueError('movimiento normal bloqueado durante la calibracion segura')
        if self.position_recovery_required[servo_id]:
            raise ValueError('el encoder perdio su referencia fiable; recupera el punto medio desde Pulsegrid y vuelve a aplicar la calibracion geometrica antes de mover')
        if not config['calibrated']:
            raise ValueError('aplica la calibracion geometrica antes de mover la persiana')
        self.update_multiturn()
        current_percent = self.blind_status(servo_id)['percent']
        if abs(current_percent - percent) <= self.POSITION_TOLERANCE_PERCENT:
            return False
        target_turns = self._calibrated_target(servo_id, percent)
        turns = target_turns - self.absolute_turns[servo_id]
        if abs(turns) > 0.001:
            self._start_multiturn(servo_id, turns, speed, acceleration)
        self.blind_targets[servo_id] = {'percent': percent, 'speed': int(speed), 'acceleration': int(acceleration)}
        self._save_persistent_state()
        return abs(turns) > 0.001

    def abrir(self, speed=800, acceleration=50):
        moved = False
        for servo_id in self.servo_ids:
            moved = self.move_blind(servo_id, 100, speed, acceleration) or moved
        if not moved:
            raise ValueError('la cortina ya esta en la posicion solicitada')

    def cerrar(self, speed=800, acceleration=50):
        moved = False
        for servo_id in self.servo_ids:
            moved = self.move_blind(servo_id, 0, speed, acceleration) or moved
        if not moved:
            raise ValueError('la cortina ya esta en la posicion solicitada')

    def parar(self):
        for servo_id in self.servo_ids:
            if self.multiturn_active[servo_id]:
                if self.blind_config[servo_id].get('calibration_in_progress'):
                    self.blind_config[servo_id]['calibration_motion_fault'] = True
                self._finish_multiturn(servo_id)
            else:
                try:
                    self.bus.torque(servo_id, False)
                except (STServoError, OSError):
                    pass

    def blind_status(self, servo_id):
        config = self.blind_config[servo_id]
        span = config['unrolled_turns'] - config['rolled_turns']
        percent = 0.0 if not span else (self.absolute_turns[servo_id] - config['rolled_turns']) * 100 / span
        reverse_percent = config.get('motor_side', 'left') == 'right'
        if self.direction_reversed:
            reverse_percent = not reverse_percent
        if reverse_percent:
            percent = 100.0 - percent
        return {
            'rolled_turns': config['rolled_turns'],
            'unrolled_turns': config['unrolled_turns'],
            'motor_side': config['motor_side'],
            'percent': max(0.0, min(100.0, percent)),
        }

    def multiturn_status(self, servo_id):
        if servo_id not in self.servo_ids:
            raise ValueError('ID de servo no detectado')
        task = self.multiturn_tasks[servo_id]
        position = self._last_positions.get(servo_id, 0)
        blind = self.blind_status(servo_id)
        target = self.blind_targets[servo_id]
        return {
            'absolute_turns': self.absolute_turns[servo_id],
            'remaining_turns': (task.get('remaining_counts', task['target_counts']) / self.COUNTS_PER_TURN) if task else 0.0,
            'multiturn_active': self.multiturn_active[servo_id],
            'position_recovery_required': self.position_recovery_required[servo_id],
            'blind_rolled_turns': blind['rolled_turns'],
            'blind_unrolled_turns': blind['unrolled_turns'],
            'blind_percent': blind['percent'],
            'blind_target_percent': target['percent'],
            'blind_target_speed': target['speed'],
            'blind_target_acceleration': target['acceleration'],
            'blind_motor_side': blind['motor_side'],
            'blind_calibrated': self.blind_config[servo_id]['calibrated'],
            'blind_calibration_in_progress': self.blind_config[servo_id]['calibration_in_progress'],
            'blind_estimated_turns': self.blind_config[servo_id]['estimated_turns'],
            'blind_calibration_limit_turns': self.blind_config[servo_id]['half_travel_limit'],
            'blind_calibration_motion_fault': self.blind_config[servo_id]['calibration_motion_fault'],
            'blind_calibration_motion_fault_reason': self.blind_config[servo_id]['calibration_motion_fault_reason'],
            'position': position,
        }
