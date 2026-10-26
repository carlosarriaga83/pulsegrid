def empty():
    return {
        'version': 2, 'active': False, 'open_marked': False, 'closed_marked': False,
        'calibrated': False, 'direction_confirmed': False, 'close_direction': 1,
        'test_started': False, 'test_origin': 0,
        'open_span_pulses': 0, 'open_direction': 1,
    }


def handle(name, payload, motor, state, pulses_per_turn, minimum_speed, referenced, before_move=None):
    if motor.moving:
        raise ValueError('Deten el motor antes de cambiar la calibracion')
    fields = {
        'tenstar.calibration.begin': {'atOpen'},
        'tenstar.calibration.reset': set(),
        'tenstar.calibration.testDirection': set(),
        'tenstar.calibration.confirmDirection': {'movement'},
        'tenstar.calibration.step': {'turns', 'direction'},
        'tenstar.calibration.setClosed': set(),
        'tenstar.calibration.referenceOpen': set(),
        'tenstar.calibration.referenceClosed': set(),
    }
    allowed = fields.get(name)
    if allowed is None:
        raise ValueError('Usa el asistente Tenstar que inicia en abierto')
    if not isinstance(payload, dict) or set(payload) != allowed:
        raise ValueError('Payload de calibracion incompleto o desconocido')
    if name in ('tenstar.calibration.begin', 'tenstar.calibration.reset'):
        if name.endswith('.begin') and payload['atOpen'] is not True:
            raise ValueError('Coloca manualmente la cortina completamente abierta')
        state.clear()
        state.update(empty())
        motor.zero()
        motor.target_position = None
        if name.endswith('.begin'):
            state['active'] = True
            state['open_marked'] = True
            motor.target_position = 100
            return True
        return False
    if name in ('tenstar.calibration.referenceOpen', 'tenstar.calibration.referenceClosed'):
        if not state['calibrated']:
            raise ValueError('Completa primero la calibracion de ambos extremos')
        opened = name.endswith('.referenceOpen')
        motor.set_position(state['open_span_pulses'] * state['open_direction'] if opened else 0)
        motor.target_position = 100 if opened else 0
        return True
    if not state.get('active') or state['calibrated'] or not referenced:
        raise ValueError('Inicia la calibracion en abierto durante esta sesion')
    if name == 'tenstar.calibration.testDirection':
        if state['test_started']:
            raise ValueError('La prueba ya se hizo; confirma si subio o bajo')
        origin = motor.snapshot()
        if before_move:
            before_move()
        motor.move_turns(0.05, 1, max(25, minimum_speed))
        state['test_origin'] = origin
        state['test_started'] = True
        motor.target_position = None
    elif name == 'tenstar.calibration.confirmDirection':
        if not state['test_started'] or state['direction_confirmed']:
            raise ValueError('Realiza primero el paso de prueba')
        movement = payload['movement']
        delta = motor.snapshot() - state['test_origin']
        if movement not in ('up', 'down') or delta < 4:
            raise ValueError('Indica subio o bajo; el encoder debe registrar el paso positivo')
        state['close_direction'] = 1 if movement == 'down' else -1
        state['direction_confirmed'] = True
    elif name == 'tenstar.calibration.step':
        if not state['direction_confirmed']:
            raise ValueError('Confirma primero si el paso de prueba subio o bajo')
        turns = payload['turns']
        direction = payload['direction']
        if isinstance(turns, bool) or not isinstance(turns, (int, float)) or not 0 < turns <= 20 or direction not in ('up', 'down'):
            raise ValueError('Indica vueltas entre 0 y 20 y direccion up o down')
        sign = state['close_direction'] * (1 if direction == 'down' else -1)
        delta = int(turns * pulses_per_turn)
        current = motor.snapshot() * state['close_direction']
        projected = current + delta * sign * state['close_direction']
        if delta < 1 or (projected < 0 and projected <= current) or projected > pulses_per_turn * 20:
            raise ValueError('El paso sale de la referencia abierta o supera 20 vueltas')
        if before_move:
            before_move()
        motor.move_turns(turns, sign, max(25, minimum_speed))
        motor.target_position = None
    elif name == 'tenstar.calibration.setClosed':
        if not state['direction_confirmed']:
            raise ValueError('Confirma primero el sentido del paso de prueba')
        span = motor.snapshot() * state['close_direction']
        if span < 100 or span > pulses_per_turn * 20:
            raise ValueError('Recorrido invalido: 100 pulsos a 20 vueltas desde abierto')
        state['open_span_pulses'] = span
        state['open_direction'] = -state['close_direction']
        state['closed_marked'] = True
        state['calibrated'] = True
        state['active'] = False
        # Normal operation keeps the existing convention: closed=0, open=100.
        motor.zero()
        motor.target_position = 0
    return True
