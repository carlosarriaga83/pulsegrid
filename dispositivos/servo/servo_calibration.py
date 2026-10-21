TEST_DIRECTION_TURNS = 1.0


def configure_cloud_estimate(cortina, servo_id, height_cm, tube_diameter_cm, fabric_thickness_mm, motor_turns_per_tube_turn, estimated_turns, motor_side):
    if servo_id not in cortina.servo_ids:
        raise ValueError('ID de servo no detectado')
    if motor_side not in ('left', 'right'):
        raise ValueError('el lado del motor debe ser left o right')
    if cortina.multiturn_active[servo_id]:
        raise ValueError('espera a que termine el movimiento')
    values = (height_cm, tube_diameter_cm, fabric_thickness_mm, motor_turns_per_tube_turn, estimated_turns)
    if any(isinstance(value, bool) for value in values):
        raise ValueError('medidas de calibracion invalidas')
    height = float(height_cm)
    diameter = float(tube_diameter_cm)
    thickness = float(fabric_thickness_mm)
    ratio = float(motor_turns_per_tube_turn)
    estimated = float(estimated_turns)
    if any(value != value or abs(value) > 1000000.0 for value in (height, diameter, thickness, ratio, estimated)):
        raise ValueError('medidas de calibracion no finitas')
    if not 20.0 <= height <= 1000.0 or not 1.0 <= diameter <= 30.0 or not 0.01 <= thickness <= 5.0 or not 0.1 <= ratio <= 20.0:
        raise ValueError('medidas fuera de rango')
    thickness_cm = thickness / 10.0
    calculated = ((-diameter + (diameter * diameter + 4.0 * thickness_cm * height / 3.141592653589793) ** 0.5) / (2.0 * thickness_cm)) * ratio
    if estimated < 1.0 or estimated > cortina.MAX_LONG_TURNS or abs(calculated - estimated) > 0.01:
        raise ValueError('vueltas calculadas fuera del rango seguro')
    cortina.update_multiturn()
    if cortina.position_recovery_required[servo_id]:
        raise ValueError('recupera primero una referencia fiable del encoder antes de calibrar')
    midpoint = round(cortina.absolute_turns[servo_id], 4)
    half_limit = estimated * 0.4
    config = cortina.blind_config[servo_id]
    config.clear()
    config.update({
        'motor_side': motor_side,
        'rolled_turns': midpoint - half_limit,
        'unrolled_turns': midpoint + half_limit,
        'calibrated': True,
        'calibration_in_progress': False,
        'window_height_cm': height,
        'tube_diameter_cm': diameter,
        'fabric_thickness_mm': thickness,
        'motor_turns_per_tube_turn': ratio,
        'estimated_turns': estimated,
        'half_travel_limit': half_limit,
        'calibration_midpoint_turns': midpoint,
        'calibration_down_direction': 0,
        'calibration_direction_pending': False,
        'calibration_motion_fault': False,
        'calibration_motion_fault_reason': '',
    })
    cortina.calibration_references[servo_id] = set()
    target = cortina.blind_targets[servo_id]
    target['percent'] = 50.0
    cortina._save_persistent_state()


def set_motor_side(cortina, servo_id, side):
    if servo_id not in cortina.servo_ids or side not in ('left', 'right'):
        raise ValueError('servo o lado del motor invalido')
    if cortina.multiturn_active[servo_id]:
        raise ValueError('espera a que termine el movimiento')
    cortina.blind_config[servo_id]['motor_side'] = side
    cortina._save_persistent_state()


def _servo(cortina, servo_id):
    if servo_id not in cortina.servo_ids:
        raise ValueError('ID de servo no detectado')
    if cortina.multiturn_active[servo_id]:
        raise ValueError('espera a que termine el movimiento')
    config = cortina.blind_config[servo_id]
    if not config.get('calibration_in_progress'):
        raise ValueError('no hay una calibracion segura en curso')
    if config.get('calibration_motion_fault'):
        reason = config.get('calibration_motion_fault_reason', '')
        if reason == 'encoder_read':
            detail = 'no se pudo leer el encoder'
        elif reason == 'encoder_stall':
            detail = 'el encoder no registró cambios durante 15 segundos'
        elif reason == 'movement_timeout':
            detail = 'se excedió el tiempo máximo de movimiento'
        elif reason == 'user_stop':
            detail = 'el movimiento fue detenido manualmente'
        else:
            detail = 'falta de avance del encoder'
        raise ValueError('movimiento detenido: {}; cancela y revisa el mecanismo'.format(detail))
    return config


def begin_safe(cortina, servo_id, height_cm, tube_diameter_cm, fabric_thickness_mm, motor_turns_per_tube_turn=1.0):
    if servo_id not in cortina.servo_ids:
        raise ValueError('ID de servo no detectado')
    if cortina.multiturn_active[servo_id]:
        raise ValueError('espera a que termine el movimiento')
    height = float(height_cm)
    diameter = float(tube_diameter_cm)
    thickness_mm = float(fabric_thickness_mm)
    ratio = float(motor_turns_per_tube_turn)
    thickness_cm = thickness_mm / 10.0
    if not 20.0 <= height <= 1000.0 or not 1.0 <= diameter <= 30.0 or not 0.01 <= thickness_mm <= 5.0 or not 0.1 <= ratio <= 20.0:
        raise ValueError('medidas fuera de rango')
    estimated = ((-diameter + (diameter * diameter + 4.0 * thickness_cm * height / 3.141592653589793) ** 0.5) / (2.0 * thickness_cm)) * ratio
    if estimated < 1.0 or estimated > cortina.MAX_LONG_TURNS:
        raise ValueError('vueltas calculadas fuera del rango seguro')
    cortina.update_multiturn()
    midpoint = round(cortina.absolute_turns[servo_id], 4)
    config = cortina.blind_config[servo_id]
    config['calibration_motion_fault'] = False
    config['calibration_motion_fault_reason'] = ''
    config.update({
        'rolled_turns': midpoint,
        'unrolled_turns': midpoint,
        'calibrated': False,
        'calibration_in_progress': True,
        'window_height_cm': height,
        'tube_diameter_cm': diameter,
        'fabric_thickness_mm': thickness_mm,
        'motor_turns_per_tube_turn': ratio,
        'estimated_turns': estimated,
        'half_travel_limit': estimated * 0.4,
        'calibration_midpoint_turns': midpoint,
        'calibration_down_direction': 0,
        'calibration_direction_pending': True,
    })
    cortina.position_recovery_required[servo_id] = True
    cortina._save_persistent_state()


def test_safe_direction(cortina, servo_id):
    config = _servo(cortina, servo_id)
    if not config.get('calibration_direction_pending'):
        raise ValueError('la prueba de sentido ya fue confirmada')
    midpoint = config['calibration_midpoint_turns']
    if abs(cortina.absolute_turns[servo_id] - midpoint) > 0.02:
        raise ValueError('la prueba de sentido solo se permite desde el punto medio')
    if config['half_travel_limit'] < TEST_DIRECTION_TURNS:
        raise ValueError('el recorrido calculado no permite una prueba de una vuelta')
    cortina._start_precision_multiturn(servo_id, TEST_DIRECTION_TURNS, cortina.APPROACH_SPEED, 30)


def stop_safe(cortina, servo_id):
    if servo_id not in cortina.servo_ids:
        raise ValueError('ID de servo no detectado')
    if not cortina.blind_config[servo_id].get('calibration_in_progress'):
        raise ValueError('no hay una calibracion segura en curso')
    if cortina.multiturn_active[servo_id]:
        cortina.blind_config[servo_id]['calibration_motion_fault'] = True
        cortina.blind_config[servo_id]['calibration_motion_fault_reason'] = 'user_stop'
        cortina._finish_multiturn(servo_id)


def confirm_safe_direction(cortina, servo_id, positive_is_down):
    config = _servo(cortina, servo_id)
    cortina.update_multiturn()
    if not config.get('calibration_direction_pending') or cortina.multiturn_active[servo_id]:
        raise ValueError('la prueba de una vuelta aun no termina')
    if abs(cortina.absolute_turns[servo_id] - config['calibration_midpoint_turns']) < 0.75:
        raise ValueError('no se detecto el recorrido de prueba completo')
    if not isinstance(positive_is_down, bool):
        raise ValueError('confirma si la persiana descendio')
    config['calibration_down_direction'] = 1 if positive_is_down else -1
    config['calibration_direction_pending'] = False
    cortina._save_persistent_state()


def safe_step(cortina, servo_id, direction, turns=0.125):
    config = _servo(cortina, servo_id)
    cortina.update_multiturn()
    if config.get('calibration_direction_pending') or config['calibration_down_direction'] not in (-1, 1):
        raise ValueError('primero confirma el sentido de descenso')
    if direction not in ('down', 'up'):
        raise ValueError('direccion de movimiento invalida')
    amount = float(turns)
    if not 0.0 < amount <= 1.0:
        raise ValueError('cada avance debe ser de hasta una vuelta')
    midpoint = config['calibration_midpoint_turns']
    current = cortina.absolute_turns[servo_id]
    remaining = config['half_travel_limit'] - abs(current - midpoint)
    if remaining <= 0.001:
        raise ValueError('limite preventivo calculado alcanzado; no sigas avanzando')
    amount = min(amount, remaining)
    signed = amount * config['calibration_down_direction'] * (1 if direction == 'down' else -1)
    cortina._start_precision_multiturn(servo_id, signed, cortina.CALIBRATION_STEP_SPEED, 40)


def mark_safe(cortina, servo_id, reference):
    config = _servo(cortina, servo_id)
    if config.get('calibration_direction_pending') or reference not in ('rolled', 'deployed'):
        raise ValueError('sentido sin confirmar o extremo invalido')
    cortina.update_multiturn()
    if cortina.multiturn_active[servo_id]:
        raise ValueError('espera a que termine el movimiento')
    current = round(cortina.absolute_turns[servo_id], 4)
    if abs(current - config['calibration_midpoint_turns']) < 0.25:
        raise ValueError('avanza desde el punto medio antes de guardar un extremo')
    if abs(current - config['calibration_midpoint_turns']) > config['half_travel_limit'] + 0.001:
        raise ValueError('el extremo excede el limite preventivo calculado')
    other_key = 'unrolled_turns' if reference == 'rolled' else 'rolled_turns'
    other = config[other_key]
    if other != config['calibration_midpoint_turns']:
        span = abs(current - other)
        if span < 0.5 or span > config['estimated_turns'] * 1.1:
            raise ValueError('los extremos no concuerdan con el recorrido estimado')
    config['rolled_turns' if reference == 'rolled' else 'unrolled_turns'] = current
    if config['rolled_turns'] != config['calibration_midpoint_turns'] and config['unrolled_turns'] != config['calibration_midpoint_turns']:
        config['calibrated'] = True
        config['calibration_in_progress'] = False
        cortina.position_recovery_required[servo_id] = False
    cortina._save_persistent_state()


def cancel_safe(cortina, servo_id):
    if servo_id not in cortina.servo_ids:
        raise ValueError('ID de servo no detectado')
    if cortina.multiturn_active[servo_id]:
        cortina.blind_config[servo_id]['calibration_motion_fault'] = True
        cortina._finish_multiturn(servo_id)
    config = cortina.blind_config[servo_id]
    config['calibration_in_progress'] = False
    config['calibrated'] = False
    config['calibration_motion_fault'] = False
    config['calibration_motion_fault_reason'] = ''
    config['calibration_direction_pending'] = False
    cortina.calibration_references[servo_id] = set()
    cortina.position_recovery_required[servo_id] = True
    cortina._save_persistent_state()