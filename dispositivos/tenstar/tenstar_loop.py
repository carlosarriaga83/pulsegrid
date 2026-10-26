import machine
import time


def control_step(app):
    with app['motor_lock']:
        completed = app['motor'].update()
        if completed is True and app['pending_motion_command'] is not None:
            app['save_calibration']()
            app['queue_ack'](app['pending_motion_command'], 'succeeded')
            app['pending_motion_command'] = None
            app['last_telemetry'] = 0


def run(app):
    app['board_led'].init(app['LED_PIN'], app['LED_ACTIVE_LOW'])
    app['load_calibration']()
    reset_cause = machine.reset_cause()
    count_reset = reset_cause in (getattr(machine, 'PWRON_RESET', 1), getattr(machine, 'HARD_RESET', 2))
    app['recovery_mode'] = app['wifi_recovery'].register_boot(count_reset)
    print('Tenstar: reset {} - recuperacion Wi-Fi {}'.format(reset_cause, app['recovery_mode']))
    if app['recovery_mode'] or not app['WIFI_SSID']:
        app['wlan'].active(False)
    else:
        app['connect_wifi']()
    if not app['WIFI_SSID']:
        print('Wi-Fi sin configurar: usa el portal Tenstar en http://192.168.4.1/')
    if not app['DEVICE_ID'] or not app['DEVICE_CODE']:
        print('Cloud pendiente: falta DEVICE_ID o DEVICE_CODE; generar con Quemador y registrar en Cloud')
    if not app['COMMANDS_ENABLED']:
        print('Cloud: comandos deshabilitados; solo se enviara telemetria')
    try:
        import ota_boot
    except ImportError:
        ota_boot = None
    if ota_boot:
        ota_boot.confirm()
    print('Tenstar Pulsegrid iniciado - {} - firmware {}'.format(app['DEVICE_ID'], app['FIRMWARE_VERSION']))
    print('Cloud destino: {} - LED GPIO{} activo {}'.format(app['API_URL'], app['LED_PIN'], 'bajo' if app['LED_ACTIVE_LOW'] else 'alto'))
    portal = app['start_network']()
    recovery_counter_cleared = False
    while True:
        try:
            if not app['recovery_mode'] and not recovery_counter_cleared and time.ticks_diff(time.ticks_ms(), app['boot_started_at']) >= app['wifi_recovery'].STABLE_BOOT_MS:
                app['wifi_recovery'].clear_counter()
                recovery_counter_cleared = True
            if app['recovery_mode']:
                status = 'recovery'
            elif app['motor'].moving:
                status = 'moving'
            elif not app['WIFI_SSID'] or not app['DEVICE_CODE'] or not app['DEVICE_ID']:
                status = 'provisioning'
            elif app['cloud_online']():
                status = 'online'
            elif not app['wlan'].isconnected():
                status = 'connecting'
            else:
                status = 'offline'
            app['board_led'].set_status(status)
            if ota_boot:
                ota_boot.feed()
            control_step(app)
        except Exception as error:
            print('Tenstar control local:', error)
            with app['motor_lock']:
                app['motor'].stop()
                app['position_valid'] = False
                failed_command = app['pending_motion_command']
                app['pending_motion_command'] = None
            if failed_command is not None:
                app['queue_ack'](failed_command, 'failed', error)
                app['last_telemetry'] = 0
        try:
            app['network_step'](portal)
        except Exception as error:
            print('Pulsegrid red:', error)
        time.sleep_ms(10)
