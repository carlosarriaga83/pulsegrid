import os


STATE_FILE = '.pulsegrid_wifi_boots'
STATE_TEMP = STATE_FILE + '.tmp'
RESET_LIMIT = 3
STABLE_BOOT_MS = 30000


def clear_boots():
    for name in (STATE_FILE, STATE_TEMP):
        try:
            os.remove(name)
        except OSError:
            pass


def register_boot():
    count = 0
    try:
        with open(STATE_FILE, 'r') as state:
            count = max(0, int(state.read().strip()))
    except (OSError, ValueError):
        pass
    count += 1
    if count >= RESET_LIMIT:
        clear_boots()
        return True
    try:
        with open(STATE_TEMP, 'w') as state:
            state.write(str(count))
        try:
            os.remove(STATE_FILE)
        except OSError:
            pass
        os.rename(STATE_TEMP, STATE_FILE)
    except OSError as error:
        print('No se pudo guardar el ciclo de recuperacion Wi-Fi:', error)
    return False