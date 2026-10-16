import os

from stservo import STServoBus, STServoError


class Cortina:
    COUNTS_PER_TURN = 4096
    MAX_LONG_TURNS = 999.99
    APPROACH_SPEED = 120
    FRONT_GEAR_CLOCKWISE_TURNS = -1
    FRONT_GEAR_COUNTERCLOCKWISE_TURNS = 1

    def __init__(self, uart, i2c=None, min_position=300, max_position=3700, servo_ids=(1, 2)):
        if not 0 <= min_position < max_position <= 4095:
            raise ValueError('limites de posicion invalidos')
        self.bus = STServoBus(uart)
        self.min_position = min_position
        self.max_position = max_position
        self.direction_reversed = False
        self.known_servo_ids = tuple(servo_ids)
        self.absolute_turns = {servo_id: 0.0 for servo_id in self.known_servo_ids}
        self.position_recovery_required = {servo_id: True for servo_id in self.known_servo_ids}
        self.blind_config = {
            servo_id: {'rolled_turns': 0.0, 'unrolled_turns': 10.0, 'motor_side': 'left', 'calibrated': False}
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
        for servo_id in self.known_servo_ids:
            if self.blind_config[servo_id]['calibrated']:
                self.position_recovery_required[servo_id] = False

    def _save_persistent_state(self):
        blind_config = {servo_id: dict(values) for servo_id, values in self.blind_config.items()}
        blind_targets = {servo_id: dict(values) for servo_id, values in self.blind_targets.items()}
        with open('blind_state.tmp', 'w') as state_file:
            state_file.write('BLIND_CONFIG = {!r}\n'.format(blind_config))
            state_file.write('BLIND_TARGETS = {!r}\n'.format(blind_targets))
            state_file.write('DIRECTION_REVERSED = {!r}\n'.format(self.direction_reversed))
        try:
            os.remove('blind_state.py')
        except OSError:
            pass
        os.rename('blind_state.tmp', 'blind_state.py')
        absolute = {servo_id: round(value, 4) for servo_id, value in self.absolute_turns.items()}
        recovery = {servo_id: bool(value) for servo_id, value in self.position_recovery_required.items()}
        with open('multiturn_state.tmp', 'w') as state_file:
            state_file.write('ABSOLUTE_TURNS = {!r}\n'.format(absolute))
            state_file.write('RECOVERY_REQUIRED = {!r}\n'.format(recovery))
        try:
            os.remove('multiturn_state.py')
        except OSError:
            pass
        os.rename('multiturn_state.tmp', 'multiturn_state.py')

    def set_direction_reversed(self, reversed_value):
        self.direction_reversed = bool(reversed_value)
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
                position = self.bus.position(servo_id)
            except (STServoError, OSError):
                continue
            delta = self._track_position(servo_id, position)
            task = self.multiturn_tasks[servo_id]
            if task is None:
                continue
            task['moved_counts'] += delta * task['direction']
            if task['moved_counts'] >= task['target_counts']:
                self._finish_multiturn(servo_id)
            elif abs(self.absolute_turns[servo_id] - self._last_saved_turns[servo_id]) >= 0.5:
                self._last_saved_turns[servo_id] = self.absolute_turns[servo_id]
                checkpoint = True
        if checkpoint:
            self._save_persistent_state()

    def _finish_multiturn(self, servo_id):
        try:
            self.bus.move_wheel(servo_id, 0, acceleration=50)
            self.bus.torque(servo_id, False)
            self.bus.set_mode(servo_id, 0)
        except (STServoError, OSError, ValueError):
            pass
        self.multiturn_tasks[servo_id] = None
        self.multiturn_active[servo_id] = False
        self.position_recovery_required[servo_id] = not self.blind_config[servo_id]['calibrated']
        self._last_saved_turns[servo_id] = self.absolute_turns[servo_id]
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
        if not 0 <= speed <= self.bus.MAX_SPEED or not 0 <= acceleration <= self.bus.MAX_ACCELERATION:
            raise ValueError('velocidad o aceleracion fuera de rango')
        current = self.bus.position(servo_id)
        self._last_positions[servo_id] = current
        self.bus.torque(servo_id, False)
        self.bus.set_mode(servo_id, 1)
        self.bus.torque(servo_id, True)
        direction = 1 if turns > 0 else -1
        self.multiturn_tasks[servo_id] = {
            'direction': direction,
            'target_counts': int(round(abs(turns) * self.COUNTS_PER_TURN)),
            'moved_counts': 0,
        }
        self.multiturn_active[servo_id] = True
        self.position_recovery_required[servo_id] = True
        self.bus.move_wheel(servo_id, direction * speed, acceleration=acceleration)
        self._save_persistent_state()

    def mover_vueltas(self, servo_id, turns, speed=800, acceleration=50):
        self._start_multiturn(servo_id, turns, speed, acceleration)

    def _calibrated_target(self, servo_id, percent):
        config = self.blind_config[servo_id]
        start = config['rolled_turns']
        end = config['unrolled_turns']
        if self.direction_reversed:
            percent = 100 - percent
        return start + (end - start) * percent / 100

    def move_blind(self, servo_id, percent, speed=800, acceleration=50):
        if servo_id not in self.servo_ids or not 0 <= float(percent) <= 100:
            raise ValueError('servo o posicion invalida')
        percent = float(percent)
        config = self.blind_config[servo_id]
        if config['calibrated']:
            turns = self._calibrated_target(servo_id, percent) - self.absolute_turns[servo_id]
            if abs(turns) > 0.001:
                self._start_multiturn(servo_id, turns, speed, acceleration)
        else:
            target = self.min_position + (self.max_position - self.min_position) * percent / 100
            if self.direction_reversed:
                target = self.min_position + self.max_position - target
            self.bus.torque(servo_id, True)
            self.bus.move(servo_id, int(round(target)), speed=int(speed), acceleration=int(acceleration))
        self.blind_targets[servo_id] = {'percent': percent, 'speed': int(speed), 'acceleration': int(acceleration)}
        self._save_persistent_state()

    def abrir(self, speed=800, acceleration=50):
        for servo_id in self.servo_ids:
            self.move_blind(servo_id, 100, speed, acceleration)

    def cerrar(self, speed=800, acceleration=50):
        for servo_id in self.servo_ids:
            self.move_blind(servo_id, 0, speed, acceleration)

    def parar(self):
        for servo_id in self.servo_ids:
            if self.multiturn_active[servo_id]:
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
        return {
            'rolled_turns': config['rolled_turns'],
            'unrolled_turns': config['unrolled_turns'],
            'motor_side': config['motor_side'],
            'percent': max(0.0, min(100.0, percent)),
        }

    def multiturn_status(self, servo_id):
        if servo_id not in self.servo_ids:
            raise ValueError('ID de servo no detectado')
        position = self.position(servo_id)
        self._track_position(servo_id, position)
        blind = self.blind_status(servo_id)
        target = self.blind_targets[servo_id]
        return {
            'absolute_turns': self.absolute_turns[servo_id],
            'remaining_turns': self.multiturn_tasks[servo_id]['target_counts'] / self.COUNTS_PER_TURN if self.multiturn_active[servo_id] else 0.0,
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
            'position': position,
        }
