def set_motor_side(cortina, servo_id, side):
    if servo_id not in cortina.servo_ids or side not in ('left', 'right'):
        raise ValueError('servo o lado del motor invalido')
    if cortina.multiturn_active[servo_id]:
        raise ValueError('espera a que termine el movimiento')
    cortina.blind_config[servo_id]['motor_side'] = side
    cortina._save_persistent_state()


def begin(cortina, servo_id):
    if servo_id not in cortina.servo_ids:
        raise ValueError('ID de servo no detectado')
    if cortina.multiturn_active[servo_id]:
        raise ValueError('espera a que termine el movimiento')
    cortina.calibration_references[servo_id] = set()
    cortina.blind_config[servo_id]['calibrated'] = False
    cortina.position_recovery_required[servo_id] = True
    cortina._save_persistent_state()


def mark(cortina, servo_id, reference):
    if servo_id not in cortina.servo_ids or reference not in ('rolled', 'deployed'):
        raise ValueError('referencia de calibracion invalida')
    cortina.update_multiturn()
    current = round(cortina.absolute_turns[servo_id], 4)
    config = cortina.blind_config[servo_id]
    config['rolled_turns' if reference == 'rolled' else 'unrolled_turns'] = current
    cortina.calibration_references.setdefault(servo_id, set()).add(reference)
    if len(cortina.calibration_references[servo_id]) == 2 and config['rolled_turns'] != config['unrolled_turns']:
        config['calibrated'] = True
        cortina.position_recovery_required[servo_id] = False
    cortina._save_persistent_state()


def jog(cortina, servo_id, direction, speed=800, acceleration=50):
    if direction in ('deployed', 'rolled'):
        positive = -1 if cortina.blind_config[servo_id]['motor_side'] == 'left' else 1
        turns = positive if direction == 'deployed' else -positive
    elif direction == 'clockwise':
        turns = cortina.FRONT_GEAR_CLOCKWISE_TURNS
    elif direction == 'counterclockwise':
        turns = cortina.FRONT_GEAR_COUNTERCLOCKWISE_TURNS
    else:
        raise ValueError('direccion de calibracion invalida')
    cortina._start_multiturn(servo_id, turns, speed, acceleration)