"""One-off supervised COM6 trial; run only with a clear, observed curtain path."""
import time
from machine import I2C, Pin, UART
import config
from cortina import Cortina
from cloud_client import CloudClient

EXPECTED_DEVICE_ID = 'PULSE_2805A5C2A310'
EXPECTED_FIRMWARE = '2026.10.21.servo-r33'
SERVO_ID = 1
SPEED = 800
ACCELERATION = 50

with open('main.py', 'r') as firmware_file:
    firmware_source = firmware_file.read()
if "FIRMWARE_VERSION = '{}'".format(EXPECTED_FIRMWARE) not in firmware_source:
    raise RuntimeError('Firmware inesperado: no se ejecuta el ensayo COM6')
if getattr(config, 'DEVICE_ID', '') != EXPECTED_DEVICE_ID:
    raise RuntimeError('Device ID inesperado: COM6 no coincide con el servo de Pulsegrid')

uart = UART(1, baudrate=1000000, bits=8, parity=None, stop=1, rx=18, tx=19)
i2c = I2C(0, scl=Pin(22), sda=Pin(21), freq=100000)
controller = Cortina(uart, i2c, servo_ids=(1, 2), direction_reversed=bool(getattr(config, 'DIRECTION_REVERSED', False)))
if SERVO_ID not in controller.servo_ids:
    raise RuntimeError('Servo 1 no responde en COM6')
if controller.multiturn_active[SERVO_ID]:
    raise RuntimeError('El servo ya tiene un movimiento activo')
if controller.position_recovery_required[SERVO_ID] or not controller.blind_config[SERVO_ID]['calibrated']:
    raise RuntimeError('El encoder/calibracion no permite el ensayo')

config_blind = controller.blind_config[SERVO_ID]
span = config_blind['unrolled_turns'] - config_blind['rolled_turns']
if not span:
    raise RuntimeError('Recorrido calibrado nulo')
initial_turns = controller.absolute_turns[SERVO_ID]
initial_status = controller.multiturn_status(SERVO_ID)
raw_percent = (initial_turns - config_blind['rolled_turns']) * 100 / span
if config_blind.get('motor_side') == 'right':
    raw_percent = 100 - raw_percent
if controller.direction_reversed:
    raw_percent = 100 - raw_percent
print('START device={} fw={} servo={} encoder={} turns={:.6f} percent_clamped={:.3f} percent_unclamped={:.3f} rolled={:.6f} unrolled={:.6f} side={} reversed={}'.format(
    config.DEVICE_ID, EXPECTED_FIRMWARE, SERVO_ID, initial_status['position'], initial_turns,
    initial_status['blind_percent'], raw_percent, config_blind['rolled_turns'],
    config_blind['unrolled_turns'], config_blind.get('motor_side'), controller.direction_reversed))

def run_command(command):
    CloudClient._execute_command(None, controller, None, command)
    task = controller.multiturn_tasks[SERVO_ID]
    if task is None:
        return None
    started_at = time.ticks_ms()
    while controller.multiturn_active[SERVO_ID]:
        controller.update_multiturn()
        if time.ticks_diff(time.ticks_ms(), started_at) > 60000:
            controller.parar()
            break
        time.sleep_ms(10)
    return task


closed_goal = controller._calibrated_target(SERVO_ID, 0)
if abs(controller.absolute_turns[SERVO_ID] - closed_goal) > 0.01:
    home_start = controller.absolute_turns[SERVO_ID]
    home_goal = closed_goal
    home_task = run_command({'name': 'curtain.close', 'payload': {'speed': SPEED, 'acceleration': ACCELERATION}})
    home_end = controller.absolute_turns[SERVO_ID]
    print('HOME start={:.6f} goal={:.6f} end={:.6f} delta={:+.6f} completed={} percent={:.3f}'.format(
        home_start, home_goal, home_end, home_end - home_start,
        bool(home_task and home_task.get('completed')), controller.blind_status(SERVO_ID)['percent']))
    if not home_task or not home_task.get('completed') or abs(home_end - home_goal) * controller.COUNTS_PER_TURN > controller.MOVEMENT_POSITION_TOLERANCE_COUNTS:
        raise RuntimeError('No se pudo establecer y validar el origen cerrado antes de los diez pasos')

for target_percent in range(10, 101, 10):
    controller.update_multiturn()
    start_turns = controller.absolute_turns[SERVO_ID]
    target_turns = controller._calibrated_target(SERVO_ID, target_percent)
    expected_delta = target_turns - start_turns
    if abs(expected_delta) <= 0.001:
        print('FAIL target={} already within movement threshold at turns={:.6f}'.format(target_percent, start_turns))
        break
    command = {
        'name': 'curtain.move',
        'payload': {'servoId': SERVO_ID, 'percent': target_percent, 'speed': SPEED, 'acceleration': ACCELERATION},
    }
    task = run_command(command)
    if task is None:
        print('FAIL target={} command did not start a movement'.format(target_percent))
        break
    actual_turns = controller.absolute_turns[SERVO_ID]
    actual = controller.multiturn_status(SERVO_ID)
    actual_delta = actual_turns - start_turns
    actual_raw_percent = (actual_turns - config_blind['rolled_turns']) * 100 / span
    if config_blind.get('motor_side') == 'right':
        actual_raw_percent = 100 - actual_raw_percent
    if controller.direction_reversed:
        actual_raw_percent = 100 - actual_raw_percent
    task_error_turns = actual_turns - target_turns
    direction_ok = actual_delta * expected_delta > 0
    target_ok = abs(task_error_turns) * controller.COUNTS_PER_TURN <= controller.MOVEMENT_POSITION_TOLERANCE_COUNTS
    task_completed = task.get('completed') is True
    print('STEP target={} start={:.6f} goal={:.6f} end={:.6f} delta={:+.6f} expected_sign={} actual_sign={} raw_percent={:.3f} reported_percent={:.3f} error_turns={:+.6f} completed={} direction_ok={} target_ok={}'.format(
        target_percent, start_turns, target_turns, actual_turns, actual_delta,
        1 if expected_delta > 0 else -1, 1 if actual_delta > 0 else -1,
        actual_raw_percent, actual['blind_percent'], task_error_turns,
        task_completed, direction_ok, target_ok))
    if not controller.multiturn_active[SERVO_ID] and task_completed and direction_ok and target_ok:
        continue
    if controller.multiturn_active[SERVO_ID]:
        controller.parar()
    print('FAIL target={} stopping the trial at the first inconsistent encoder result'.format(target_percent))
    break
else:
    print('PASS all ten commands: 10,20,30,40,50,60,70,80,90,100')

if not controller.multiturn_active[SERVO_ID] and controller.blind_status(SERVO_ID)['percent'] >= 99.0:
    close_start = controller.absolute_turns[SERVO_ID]
    close_goal = controller._calibrated_target(SERVO_ID, 0)
    close_task = run_command({'name': 'curtain.close', 'payload': {'speed': SPEED, 'acceleration': ACCELERATION}})
    close_end = controller.absolute_turns[SERVO_ID]
    close_ok = bool(close_task and close_task.get('completed')) and abs(close_end - close_goal) * controller.COUNTS_PER_TURN <= controller.MOVEMENT_POSITION_TOLERANCE_COUNTS
    print('CLOSE start={:.6f} goal={:.6f} end={:.6f} delta={:+.6f} completed={} percent={:.3f}'.format(
        close_start, close_goal, close_end, close_end - close_start,
        bool(close_task and close_task.get('completed')), controller.blind_status(SERVO_ID)['percent']))
    if not close_ok:
        raise RuntimeError('El cierre posterior al 100% no terminó en el objetivo encoder')
    before_duplicate = controller.absolute_turns[SERVO_ID]
    try:
        duplicate_task = run_command({'name': 'curtain.close', 'payload': {'speed': SPEED, 'acceleration': ACCELERATION}})
        print('FAIL duplicate close was accepted task={} delta={:+.6f}'.format(
            bool(duplicate_task), controller.absolute_turns[SERVO_ID] - before_duplicate))
    except ValueError as error:
        after_duplicate = controller.absolute_turns[SERVO_ID]
        print('DUPLICATE_CLOSE rejected={} encoder_delta={:+.6f} active={}'.format(
            error, after_duplicate - before_duplicate, controller.multiturn_active[SERVO_ID]))

print('END encoder={} turns={:.6f} percent={:.3f} active={}'.format(
    controller.position(SERVO_ID), controller.absolute_turns[SERVO_ID],
    controller.blind_status(SERVO_ID)['percent'], controller.multiturn_active[SERVO_ID]))
