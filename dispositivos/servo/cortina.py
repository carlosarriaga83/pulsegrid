import os

from stservo import STServoBus, STServoError


class Cortina:
    SERVO_IDS = (1, 2)
    LED_PIN = 23
    LED_COUNT = 10
    COUNTS_PER_TURN = 4096
    MAX_LONG_TURNS = 999.99
    CHECKPOINT_COUNTS = COUNTS_PER_TURN // 2
    APPROACH_COUNTS = COUNTS_PER_TURN // 16
    APPROACH_SPEED = 120
    BLIND_TARGET_TOLERANCE_TURNS = 0.02
    FRONT_GEAR_CLOCKWISE_TURNS = -1
    FRONT_GEAR_COUNTERCLOCKWISE_TURNS = 1

    def __init__(self, uart, i2c, min_position=300, max_position=3700, servo_ids=(1, 2)):
        if not 0 <= min_position < max_position <= 4095:
            raise ValueError("limites de posicion invalidos")
        self.bus = STServoBus(uart)
        self.min_position = min_position
        self.max_position = max_position
        self.display = None
        self.leds = None
        self.direction_reversed = False
        try:
            from blind_state import DIRECTION_REVERSED
            self.direction_reversed = bool(DIRECTION_REVERSED)
        except (ImportError, AttributeError, TypeError, ValueError):
            pass
        try:
            from ssd1306 import SSD1306_I2C
            self.display = SSD1306_I2C(128, 32, i2c, addr=0x3C)
        except (ImportError, OSError, TypeError, ValueError):
            self.display = None
        self._set_leds((0, 0, 20))
        self._show("Cortina", "iniciando")
        self.known_servo_ids = tuple(servo_ids)
        self.servo_ids = self.known_servo_ids
        self.absolute_turns = {servo_id: 0.0 for servo_id in self.known_servo_ids}
        self.remaining_turns = {servo_id: 0.0 for servo_id in self.known_servo_ids}
        self.multiturn_active = {servo_id: False for servo_id in self.known_servo_ids}
        self.multiturn_tasks = {servo_id: None for servo_id in self.known_servo_ids}
        self.position_recovery_required = {servo_id: False for servo_id in self.known_servo_ids}
        self.calibration_references = {servo_id: set() for servo_id in self.known_servo_ids}
        self._restored_absolute_state = False
        self._load_absolute_turns()
        self.blind_config = {
            servo_id: {"rolled_turns": 0.0, "unrolled_turns": 10.0, "motor_side": "left", "calibrated": False}
            for servo_id in self.known_servo_ids
        }
        self.blind_targets = {
            servo_id: {"percent": 50.0, "speed": 800, "acceleration": 50}
            for servo_id in self.known_servo_ids
        }
        self._load_blind_config()
        self.calibration_confirmed = {}
        for servo_id in self.known_servo_ids:
            config = self.blind_config[servo_id]
            confirmed = bool(config["calibrated"]) or (self._restored_absolute_state and not self.position_recovery_required[servo_id])
            self.calibration_confirmed[servo_id] = confirmed
            self.position_recovery_required[servo_id] = not confirmed
            if confirmed:
                self.calibration_references[servo_id] = {"rolled", "deployed"}
        self.available = tuple(servo_id for servo_id in self.known_servo_ids if self.bus.ping(servo_id))
        self.servo_ids = self.available
        detected = ",".join(str(servo_id) for servo_id in self.available) or "ninguno"
        self._show("Cortina lista", "servos " + detected)

    def position(self, servo_id):
        return self.bus.position(servo_id)

    def scan_servos(self, first_id=1, last_id=20):
        detected = tuple(self.bus.scan(first_id, last_id))
        self._show("Scan servos", ",".join(str(servo_id) for servo_id in detected) or "ninguno")
        self.servo_ids = detected
        return detected

    def configuration(self, servo_id):
        return self.bus.configuration(servo_id)

    def multiturn_status(self, servo_id):
        if servo_id not in self.servo_ids:
            raise ValueError("ID de servo no detectado")
        blind = self.blind_status(servo_id)
        return {
            "absolute_turns": self.absolute_turns[servo_id],
            "remaining_turns": self.remaining_turns[servo_id],
            "multiturn_active": self.multiturn_active[servo_id],
            "position_recovery_required": self.position_recovery_required[servo_id],
            "blind_rolled_turns": blind["rolled_turns"],
            "blind_unrolled_turns": blind["unrolled_turns"],
            "blind_percent": blind["percent"],
            "blind_target_percent": self.blind_targets[servo_id]["percent"],
            "blind_target_speed": self.blind_targets[servo_id]["speed"],
            "blind_target_acceleration": self.blind_targets[servo_id]["acceleration"],
            "blind_motor_side": blind["motor_side"],
            "blind_calibrated": self.calibration_confirmed[servo_id],
        }

    def blind_status(self, servo_id):
        if servo_id not in self.servo_ids:
            raise ValueError("ID de servo no detectado")
        config = self.blind_config[servo_id]
        span = config["unrolled_turns"] - config["rolled_turns"]
        percent = 0.0 if not span else (self.absolute_turns[servo_id] - config["rolled_turns"]) * 100 / span
        return {
            "rolled_turns": config["rolled_turns"],
            "unrolled_turns": config["unrolled_turns"],
            "motor_side": config["motor_side"],
            "percent": max(0.0, min(100.0, percent)),
        }

    def _load_absolute_turns(self):
        restored = False
        try:
            from multiturn_state import ABSOLUTE_TURNS, RECOVERY_REQUIRED
            restored = True
            for servo_id in self.known_servo_ids:
                self.absolute_turns[servo_id] = float(ABSOLUTE_TURNS.get(servo_id, 0.0))
                self.position_recovery_required[servo_id] = bool(RECOVERY_REQUIRED.get(servo_id, False))
        except ImportError:
            try:
                from multiturn_state import ABSOLUTE_TURNS
                restored = True
                for servo_id in self.known_servo_ids:
                    self.absolute_turns[servo_id] = float(ABSOLUTE_TURNS.get(servo_id, 0.0))
            except (ImportError, AttributeError, TypeError, ValueError):
                pass
        except (AttributeError, TypeError, ValueError):
            pass
        if restored:
            self._restored_absolute_state = True

    def _save_absolute_turns(self):
        values = {servo_id: round(self.absolute_turns[servo_id], 4) for servo_id in self.known_servo_ids}
        recovery = {servo_id: self.position_recovery_required[servo_id] for servo_id in self.known_servo_ids}
        with open("multiturn_state.tmp", "w") as state_file:
            state_file.write("ABSOLUTE_TURNS = {!r}\n".format(values))
            state_file.write("RECOVERY_REQUIRED = {!r}\n".format(recovery))
        os.rename("multiturn_state.tmp", "multiturn_state.py")

    def _load_blind_config(self):
        try:
            from blind_state import BLIND_CONFIG, BLIND_TARGETS
            for servo_id in self.known_servo_ids:
                saved = BLIND_CONFIG.get(servo_id, {})
                rolled = float(saved.get("rolled_turns", self.blind_config[servo_id]["rolled_turns"]))
                unrolled = float(saved.get("unrolled_turns", self.blind_config[servo_id]["unrolled_turns"]))
                if rolled != unrolled:
                    self.blind_config[servo_id]["rolled_turns"] = rolled
                    self.blind_config[servo_id]["unrolled_turns"] = unrolled
                side = str(saved.get("motor_side", self.blind_config[servo_id]["motor_side"]))
                if side in ("left", "right"):
                    self.blind_config[servo_id]["motor_side"] = side
                self.blind_config[servo_id]["calibrated"] = bool(saved.get("calibrated", False))
                target = BLIND_TARGETS.get(servo_id, {})
                percent = float(target.get("percent", self.blind_targets[servo_id]["percent"]))
                speed = int(target.get("speed", self.blind_targets[servo_id]["speed"]))
                acceleration = int(target.get("acceleration", self.blind_targets[servo_id]["acceleration"]))
                if 0 <= percent <= 100 and 0 <= speed <= self.bus.MAX_SPEED and 0 <= acceleration <= self.bus.MAX_ACCELERATION:
                    self.blind_targets[servo_id] = {"percent": percent, "speed": speed, "acceleration": acceleration}
        except ImportError:
            try:
                from blind_state import BLIND_CONFIG
                for servo_id in self.known_servo_ids:
                    saved = BLIND_CONFIG.get(servo_id, {})
                    rolled = float(saved.get("rolled_turns", self.blind_config[servo_id]["rolled_turns"]))
                    unrolled = float(saved.get("unrolled_turns", self.blind_config[servo_id]["unrolled_turns"]))
                    if rolled != unrolled:
                        self.blind_config[servo_id]["rolled_turns"] = rolled
                        self.blind_config[servo_id]["unrolled_turns"] = unrolled
            except (ImportError, AttributeError, TypeError, ValueError):
                pass
        except (AttributeError, TypeError, ValueError):
            pass

    def _save_blind_config(self):
        with open("blind_state.tmp", "w") as state_file:
            state_file.write("BLIND_CONFIG = {!r}\n".format(self.blind_config))
            state_file.write("BLIND_TARGETS = {!r}\n".format(self.blind_targets))
            state_file.write("DIRECTION_REVERSED = {!r}\n".format(self.direction_reversed))
        os.rename("blind_state.tmp", "blind_state.py")

    def set_direction_reversed(self, reversed_direction):
        self.direction_reversed = bool(reversed_direction)
        self._save_blind_config()
        self._show("Sentido", "reversa" if self.direction_reversed else "normal")

    def configure_blind(self, servo_id, rolled_turns, unrolled_turns):
        if servo_id not in self.servo_ids:
            raise ValueError("ID de servo no detectado")
        if isinstance(rolled_turns, bool) or isinstance(unrolled_turns, bool):
            raise ValueError("las vueltas de persiana deben ser numeros")
        rolled_turns = float(rolled_turns)
        unrolled_turns = float(unrolled_turns)
        if rolled_turns == unrolled_turns:
            raise ValueError("los extremos de persiana deben ser distintos")
        if abs(rolled_turns) > self.MAX_LONG_TURNS or abs(unrolled_turns) > self.MAX_LONG_TURNS:
            raise ValueError("los extremos de persiana deben estar entre -999.99 y 999.99")
        self.blind_config[servo_id]["rolled_turns"] = rolled_turns
        self.blind_config[servo_id]["unrolled_turns"] = unrolled_turns
        self.blind_config[servo_id]["calibrated"] = False
        self.calibration_confirmed[servo_id] = False
        self.position_recovery_required[servo_id] = True
        self.calibration_references[servo_id] = set()
        self._save_blind_config()

    def set_motor_side(self, servo_id, side):
        if servo_id not in self.servo_ids:
            raise ValueError("ID de servo no detectado")
        if self.multiturn_active[servo_id]:
            raise ValueError("espera a que termine el movimiento")
        if side not in ("left", "right"):
            raise ValueError("el lado del motor debe ser left o right")
        self.blind_config[servo_id]["motor_side"] = side
        self._save_blind_config()

    def begin_blind_calibration(self, servo_id):
        if servo_id not in self.servo_ids:
            raise ValueError("ID de servo no detectado")
        if self.multiturn_active[servo_id]:
            raise ValueError("espera a que termine el movimiento")
        self.calibration_references[servo_id] = set()
        self.calibration_confirmed[servo_id] = False
        self.position_recovery_required[servo_id] = True
        self.blind_config[servo_id]["calibrated"] = False
        self._save_blind_config()
        self._save_absolute_turns()

    def mark_blind_reference(self, servo_id, reference):
        if servo_id not in self.servo_ids:
            raise ValueError("ID de servo no detectado")
        if self.multiturn_active[servo_id]:
            raise ValueError("espera a que termine el movimiento")
        if reference not in ("rolled", "deployed"):
            raise ValueError("referencia de persiana invalida")
        current_turns = round(self.absolute_turns[servo_id], 4)
        is_first_reference = not self.calibration_references[servo_id]
        config = self.blind_config[servo_id]
        rolled_turns = current_turns if reference == "rolled" else config["rolled_turns"]
        unrolled_turns = config["unrolled_turns"] if reference == "rolled" else current_turns
        if not is_first_reference and rolled_turns == unrolled_turns:
            raise ValueError("mueve la cortina al otro extremo antes de fijar esta referencia")
        if reference == "rolled":
            config["rolled_turns"] = current_turns
        else:
            config["unrolled_turns"] = current_turns
        self.calibration_references[servo_id].add(reference)
        if len(self.calibration_references[servo_id]) == 2:
            self.calibration_confirmed[servo_id] = True
            self.position_recovery_required[servo_id] = False
            config["calibrated"] = True
            self._save_absolute_turns()
        self._save_blind_config()
        self._show("Referencia lista", "{} S{}: {:.2f}".format(reference, servo_id, current_turns))

    def jog_blind(self, servo_id, direction="deployed", speed=None, acceleration=None):
        if servo_id not in self.servo_ids:
            raise ValueError("ID de servo no detectado")
        if self.multiturn_active[servo_id]:
            raise ValueError("espera a que termine el movimiento")
        if direction not in ("deployed", "rolled", "clockwise", "counterclockwise"):
            raise ValueError("direccion de calibracion invalida")
        positive_for_deployed = -1 if self.blind_config[servo_id]["motor_side"] == "left" else 1
        if direction == "deployed":
            turns = positive_for_deployed
        elif direction == "rolled":
            turns = -positive_for_deployed
        else:
            turns = self.FRONT_GEAR_CLOCKWISE_TURNS if direction == "clockwise" else self.FRONT_GEAR_COUNTERCLOCKWISE_TURNS
        self.mover_vueltas(servo_id, turns, speed, acceleration)

    def move_blind(self, servo_id, percent, speed=None, acceleration=None):
        if servo_id not in self.servo_ids or not 0 <= percent <= 100:
            raise ValueError("posicion de persiana debe estar entre 0 y 100")
        if self.multiturn_active[servo_id]:
            raise ValueError("espera a que termine el movimiento actual")
        if self.position_recovery_required[servo_id]:
            raise ValueError("calibra ambos extremos antes de mover la persiana")
        speed = getattr(self, "speed", 800) if speed is None else speed
        acceleration = getattr(self, "acceleration", 50) if acceleration is None else acceleration
        if not 0 <= speed <= self.bus.MAX_SPEED or not 0 <= acceleration <= self.bus.MAX_ACCELERATION:
            raise ValueError("velocidad debe estar entre 0 y 3073, aceleracion entre 0 y 150")
        self.blind_targets[servo_id] = {"percent": float(percent), "speed": int(speed), "acceleration": int(acceleration)}
        self._save_blind_config()
        config = self.blind_config[servo_id]
        effective_percent = 100 - percent if self.direction_reversed else percent
        target = config["rolled_turns"] + (config["unrolled_turns"] - config["rolled_turns"]) * effective_percent / 100
        remaining_turns = target - self.absolute_turns[servo_id]
        if abs(remaining_turns) <= self.BLIND_TARGET_TOLERANCE_TURNS:
            self._show("Cortina", "ya en {:.0f}%".format(percent))
            return target
        self.mover_vueltas(servo_id, remaining_turns, speed, acceleration)
        return target

    def reset_absolute_turns(self, servo_id):
        if servo_id not in self.servo_ids:
            raise ValueError("ID de servo no detectado")
        if self.multiturn_active[servo_id]:
            raise ValueError("no se puede reiniciar el contador durante un movimiento")
        self.absolute_turns[servo_id] = 0.0
        self.remaining_turns[servo_id] = 0.0
        self.position_recovery_required[servo_id] = True
        self.calibration_references[servo_id] = set()
        self.calibration_confirmed[servo_id] = False
        self.blind_config[servo_id]["calibrated"] = False
        self._save_blind_config()
        self._save_absolute_turns()

    def configure_servo(self, servo_id, min_angle, max_angle, mode, torque_limit):
        if servo_id not in self.servo_ids:
            raise ValueError("ID de servo no configurado")
        if mode == 3:
            min_angle = 0
            max_angle = 0
        elif not 0 <= min_angle < max_angle <= 4095:
            raise ValueError("limites invalidos para modo Servo")
        self.bus.torque(servo_id, False)
        self.bus.set_mode(servo_id, mode)
        if mode != 3:
            self.bus.set_limits(servo_id, min_angle, max_angle)
        self.bus.set_torque_limit(servo_id, torque_limit)
        self.min_position = min_angle
        self.max_position = max_angle
        self._show("Configurado", "servo {} listo".format(servo_id))

    def change_id(self, current_id, new_id):
        if current_id not in self.servo_ids or new_id in self.servo_ids or not 1 <= new_id <= 20:
            raise ValueError("ID nuevo debe ser unico y estar entre 1 y 20")
        self.bus.set_id(current_id, new_id)
        self.servo_ids = tuple(new_id if servo_id == current_id else servo_id for servo_id in self.servo_ids)
        self._show("ID actualizado", "{} -> {}".format(current_id, new_id))

    def configure_motion(self, speed, acceleration):
        if not 0 <= speed <= self.bus.MAX_SPEED or not 0 <= acceleration <= self.bus.MAX_ACCELERATION:
            raise ValueError("velocidad debe estar entre 0 y 3073, aceleracion entre 0 y 150")
        self.speed = speed
        self.acceleration = acceleration
        self._show("Movimiento", "v{} a{}".format(speed, acceleration))

    def set_motion(self, speed, acceleration=None):
        if acceleration is None:
            acceleration = getattr(self, "acceleration", 50)
        self.configure_motion(speed, acceleration)

    def _show(self, line1, line2, line3=None):
        if self.display is None:
            return
        if line1 == "WiFi conectado" and line3:
            line1, line2 = line2, line3
        self.display.fill(0)
        self.display.text(line1[:21], 0, 0)
        self.display.text(line2[:21], 0, 16)
        self.display.show()

    def show_status(self, label="estado"):
        positions = [self.position(servo_id) for servo_id in self.servo_ids]
        if not positions:
            self._show("Sin servos", label)
        else:
            summary = " ".join("P{}:{}".format(servo_id, position) for servo_id, position in zip(self.servo_ids, positions))
            self._show(summary, label)
        return positions

    def _set_leds(self, color):
        if self.leds is None:
            return
        for index in range(self.LED_COUNT):
            self.leds[index] = color
        self.leds.write()

    def _move_both(self, target, color, label):
        target = max(self.min_position, min(self.max_position, target))
        if self.direction_reversed:
            target = self.min_position + self.max_position - target
        self._set_leds(color)
        self._show("Cortina", label)
        try:
            for servo_id in self.servo_ids:
                self.bus.torque(servo_id, True)
            for servo_id in self.servo_ids:
                self.bus.move(
                    servo_id,
                    target,
                    speed=getattr(self, "speed", 800),
                    acceleration=getattr(self, "acceleration", 50),
                )
        except (STServoError, OSError, ValueError):
            self.parar()
            raise

    def abrir(self, speed=None, acceleration=None):
        for servo_id in self.servo_ids:
            self.move_blind(servo_id, 100, speed, acceleration)
        self._set_leds((0, 30, 0))
        self._show("Cortina", "abierta")

    def cerrar(self, speed=None, acceleration=None):
        for servo_id in self.servo_ids:
            self.move_blind(servo_id, 0, speed, acceleration)
        self._set_leds((30, 0, 0))
        self._show("Cortina", "cerrada")

    def mover_a(self, position):
        self._move_both(position, (0, 0, 30), "posicion {}".format(position))

    def _start_long_multiturn(self, servo_id, turns, speed, acceleration):
        direction = 1 if turns > 0 else -1
        target_counts = int(round(abs(turns) * self.COUNTS_PER_TURN))
        last_position = self.bus.position(servo_id)
        self.bus.torque(servo_id, False)
        self.bus.set_mode(servo_id, 1)
        self.bus.torque(servo_id, True)
        self.multiturn_tasks[servo_id] = {
            "direction": direction,
            "target_counts": target_counts,
            "moved_counts": 0,
            "last_position": last_position,
            "start_turns": self.absolute_turns[servo_id],
            "speed": speed,
            "acceleration": acceleration,
            "slowing": False,
            "last_checkpoint_count": 0,
        }
        self.remaining_turns[servo_id] = abs(turns)
        self.multiturn_active[servo_id] = True
        self.position_recovery_required[servo_id] = True
        self._set_leds((0, 30, 0))
        self._save_absolute_turns()
        self.bus.move_wheel(servo_id, direction * speed, acceleration=acceleration)

    def update_multiturn(self):
        for servo_id in self.servo_ids:
            task = self.multiturn_tasks[servo_id]
            if task is None:
                continue
            try:
                position = self.bus.position(servo_id)
                delta = position - task["last_position"]
                if delta > self.COUNTS_PER_TURN // 2:
                    delta -= self.COUNTS_PER_TURN
                elif delta < -self.COUNTS_PER_TURN // 2:
                    delta += self.COUNTS_PER_TURN
                task["last_position"] = position
                task["moved_counts"] += delta * task["direction"]
                counted = max(0, task["moved_counts"])
                self.absolute_turns[servo_id] = task["start_turns"] + task["direction"] * task["moved_counts"] / self.COUNTS_PER_TURN
                remaining = task["target_counts"] - task["moved_counts"]
                self.remaining_turns[servo_id] = max(0, remaining) / self.COUNTS_PER_TURN
                if remaining <= 0:
                    self._finish_multiturn(servo_id)
                elif counted - task["last_checkpoint_count"] >= self.CHECKPOINT_COUNTS:
                    task["last_checkpoint_count"] = counted
                    self._save_absolute_turns()
                elif remaining <= self.APPROACH_COUNTS and not task["slowing"]:
                    slow_speed = min(task["speed"], self.APPROACH_SPEED)
                    self.bus.move_wheel(servo_id, task["direction"] * slow_speed, acceleration=task["acceleration"])
                    task["slowing"] = True
            except (STServoError, OSError, ValueError):
                self._set_leds((30, 0, 0))
                self.parar_servo(servo_id, confirmed=False)

    def _finish_multiturn(self, servo_id):
        task = self.multiturn_tasks[servo_id]
        if task is None:
            return
        self.bus.move_wheel(servo_id, 0, acceleration=task["acceleration"])
        self.bus.torque(servo_id, False)
        self.absolute_turns[servo_id] = task["start_turns"] + task["direction"] * task["target_counts"] / self.COUNTS_PER_TURN
        self.bus.set_mode(servo_id, 3)
        self.bus.torque(servo_id, True)
        self.multiturn_tasks[servo_id] = None
        self.multiturn_active[servo_id] = False
        self.remaining_turns[servo_id] = 0.0
        self.position_recovery_required[servo_id] = not self.calibration_confirmed[servo_id]
        self._set_leds((30, 0, 0))
        self._save_absolute_turns()

    def mover_vueltas(self, servo_id, turns, speed=None, acceleration=None):
        if servo_id not in self.servo_ids:
            raise ValueError("ID de servo no detectado")
        if isinstance(turns, bool) or not isinstance(turns, (int, float)) or not -self.MAX_LONG_TURNS <= turns <= self.MAX_LONG_TURNS:
            raise ValueError("vueltas debe estar entre -999.99 y 999.99")
        if not turns:
            return
        if self.direction_reversed:
            turns = -turns
        if speed is None:
            speed = getattr(self, "speed", 800)
        if acceleration is None:
            acceleration = getattr(self, "acceleration", 50)
        if not 0 <= speed <= self.bus.MAX_SPEED or not 0 <= acceleration <= self.bus.MAX_ACCELERATION:
            raise ValueError("velocidad debe estar entre 0 y 3073, aceleracion entre 0 y 150")
        self.parar_servo(servo_id)
        self._set_leds((20, 0, 30))
        self._show("Multivuelta", "{} vueltas".format(turns))
        self._start_long_multiturn(servo_id, turns, speed, acceleration)

    def comando(self, mode, position=None, turns=None, speed=None, servo_id=None):
        targets = self.servo_ids if servo_id is None else (servo_id,)
        if any(target not in self.servo_ids for target in targets):
            raise ValueError("ID de servo no detectado")
        if mode == 0:
            if position is None or not 0 <= position <= 4095:
                raise ValueError("posicion servo debe estar entre 0 y 4095")
            if self.direction_reversed:
                position = self.min_position + self.max_position - position
            self._set_leds((0, 0, 30))
            self._show("Servo", "posicion {}".format(position))
            for target in targets:
                self.parar_servo(target)
                self.bus.torque(target, False)
                self.bus.set_mode(target, 0)
                self.bus.torque(target, True)
                self.bus.move(target, position, speed=getattr(self, "speed", 800), acceleration=getattr(self, "acceleration", 50))
        elif mode == 3:
            motion_speed = getattr(self, "speed", 800)
            motion_acceleration = getattr(self, "acceleration", 50)
            for target in targets:
                self.mover_vueltas(target, turns, motion_speed, motion_acceleration)
        elif mode == 1:
            if speed is None or not -self.bus.MAX_SPEED <= speed <= self.bus.MAX_SPEED:
                raise ValueError("velocidad rueda debe estar entre -3073 y 3073")
            self._set_leds((30, 15, 0))
            self._show("Rueda", "velocidad {}".format(speed))
            for target in targets:
                self.parar_servo(target)
                self.bus.torque(target, False)
                self.bus.set_mode(target, 1)
                self.bus.torque(target, True)
                self.bus.move_wheel(target, -speed if self.direction_reversed else speed, acceleration=getattr(self, "acceleration", 50))
        else:
            raise ValueError("modo de comando no valido")

    def parar(self):
        for servo_id in self.servo_ids:
            self.parar_servo(servo_id)
        self._set_leds((20, 10, 0))
        self._show("Cortina", "detenida")

    def torque_servo(self, servo_id, enabled):
        if servo_id not in self.servo_ids:
            raise ValueError("ID de servo no detectado")
        self.bus.torque(servo_id, enabled)
        self._show("Servo {}".format(servo_id), "torque {}".format("ON" if enabled else "OFF"))

    def parar_servo(self, servo_id, confirmed=True):
        if servo_id not in self.servo_ids:
            raise ValueError("ID de servo no detectado")
        try:
            self.multiturn_active[servo_id] = False
            self.multiturn_tasks[servo_id] = None
            if self.multiturn_tasks[servo_id] is None:
                self.remaining_turns[servo_id] = 0.0
            self.bus.torque(servo_id, False)
            if confirmed:
                self.position_recovery_required[servo_id] = False
            self._save_absolute_turns()
        except (STServoError, OSError):
            pass