"""Supervised bench trial: adjacent 10% absolute targets after r33 reset."""
import time
from machine import I2C, Pin, UART
import config
from cortina import Cortina
from cloud_client import CloudClient
from servo_calibration import configure_cloud_estimate

DEVICE_ID = 'PULSE_2805A5C2A310'
FIRMWARE = '2026.10.21.servo-r33'
SERVO_ID = 1
SPEED = 800
ACCELERATION = 50
HEIGHT_CM = 20.0
TUBE_DIAMETER_CM = 5.0
FABRIC_THICKNESS_MM = 0.5
MOTOR_RATIO = 1.0

with open('main.py', 'r') as file:
    if "FIRMWARE_VERSION = '{}'".format(FIRMWARE) not in file.read():
        raise RuntimeError('El firmware r33 no está instalado; ensayo cancelado')
if getattr(config, 'DEVICE_ID', '') != DEVICE_ID:
    raise RuntimeError('COM6 no corresponde al Servo esperado; ensayo cancelado')

uart = UART(1, baudrate=1000000, bits=8, parity=None, stop=1, rx=18, tx=19)
i2c = I2C(0, scl=Pin(22), sda=Pin(21), freq=100000)
controller = Cortina(uart, i2c, servo_ids=(1, 2), direction_reversed=bool(getattr(config, 'DIRECTION_REVERSED', False)))
if SERVO_ID not in controller.servo_ids:
    raise RuntimeError('El servo no responde; ensayo cancelado')
if controller.multiturn_active[SERVO_ID]:
    raise RuntimeError('Hay un movimiento activo; ensayo cancelado')

# The mechanism is mechanically decoupled per user authorization. Reset only
# software calibration/reference; recover_position_reference sends no motor command.
controller.recover_position_reference(SERVO_ID)
turns = ((-TUBE_DIAMETER_CM + (TUBE_DIAMETER_CM ** 2 + 4 * (FABRIC_THICKNESS_MM / 10) * HEIGHT_CM / 3.141592653589793) ** 0.5) / (2 * (FABRIC_THICKNESS_MM / 10))) * MOTOR_RATIO
side = controller.blind_config[SERVO_ID].get('motor_side', 'left')
configure_cloud_estimate(controller, SERVO_ID, HEIGHT_CM, TUBE_DIAMETER_CM, FABRIC_THICKNESS_MM, MOTOR_RATIO, turns, side)
print('READY fw={} encoder={} origin={:.5f} side={} envelope=[{:.5f},{:.5f}]'.format(
    FIRMWARE, controller.position(SERVO_ID), controller.absolute_turns[SERVO_ID], side,
    controller.blind_config[SERVO_ID]['rolled_turns'], controller.blind_config[SERVO_ID]['unrolled_turns']))


def move_to(percent):
    controller.update_multiturn()
    start = controller.absolute_turns[SERVO_ID]
    goal = controller._calibrated_target(SERVO_ID, percent)
    task_before = controller.multiturn_tasks[SERVO_ID]
    if task_before is not None:
        raise RuntimeError('Unexpected active task before target {}'.format(percent))
    CloudClient._execute_command(None, controller, None, {
        'name': 'curtain.move',
        'payload': {'servoId': SERVO_ID, 'percent': percent, 'speed': SPEED, 'acceleration': ACCELERATION},
    })
    task = controller.multiturn_tasks[SERVO_ID]
    if task is None:
        raise RuntimeError('Target {} did not start a move'.format(percent))
    started = time.ticks_ms()
    while controller.multiturn_active[SERVO_ID]:
        controller.update_multiturn()
        if time.ticks_diff(time.ticks_ms(), started) > 45000:
            controller.parar()
            raise RuntimeError('Target {} exceeded 45 seconds'.format(percent))
        time.sleep_ms(10)
    actual = controller.absolute_turns[SERVO_ID]
    error_counts = round(abs(actual - goal) * controller.COUNTS_PER_TURN)
    actual_delta = actual - start
    expected_delta = goal - start
    print('STEP target={} encoder={} start={:.5f} goal={:.5f} actual={:.5f} move={:+.5f} err_counts={} status={} ref_required={}'.format(
        percent, controller.position(SERVO_ID), start, goal, actual, actual_delta,
        error_counts, task.get('fault_reason') or ('completed' if task.get('completed') else 'failed'),
        controller.position_recovery_required[SERVO_ID]))
    if not task.get('completed'):
        raise RuntimeError('Target {} failed: {}'.format(percent, task.get('fault_reason')))
    if actual_delta * expected_delta <= 0:
        raise RuntimeError('Encoder direction was inconsistent at {}'.format(percent))
    if error_counts > controller.MOVEMENT_POSITION_TOLERANCE_COUNTS:
        raise RuntimeError('Target {} exceeded tolerance despite successful ACK'.format(percent))
    if controller.position_recovery_required[SERVO_ID]:
        raise RuntimeError('A successful movement incorrectly invalidated the reference')
    return actual_delta


first_delta = move_to(60)
second_delta = move_to(70)
print('PASS consecutive targets 60% then 70%; encoder direction consistent={}'.format(first_delta * second_delta > 0))
