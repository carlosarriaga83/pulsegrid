import machine
import os
import ujson

STATE_FILE = "ota_state.json"
STAGE_DIR = ".pulsegrid_ota/stage"
BACKUP_DIR = ".pulsegrid_ota/backup"
HEALTH_FILE = ".pulsegrid_ota/health"
_wdt = None


def _exists(path):
    try:
        os.stat(path)
        return True
    except OSError:
        return False


def _mkdir(path):
    try:
        os.mkdir(path)
    except OSError:
        pass


def _remove(path):
    try:
        os.remove(path)
    except OSError:
        pass


def _read_state():
    if not _exists(STATE_FILE):
        return None
    try:
        with open(STATE_FILE, "r") as source:
            return ujson.loads(source.read())
    except Exception:
        return {"state": "installing", "files": []}


def _write_state(state):
    temporary = STATE_FILE + ".tmp"
    with open(temporary, "w") as target:
        target.write(ujson.dumps(state))
    _remove(STATE_FILE)
    os.rename(temporary, STATE_FILE)


def _clear_directory(path, names=None):
    if not _exists(path):
        return
    for name in names or os.listdir(path):
        _remove(path + "/" + name)


def begin(version, total_bytes):
    free = os.statvfs(".")
    available = free[0] * free[4]
    if available < int(total_bytes) + 8192:
        raise OSError("Espacio flash insuficiente para OTA")
    _mkdir(".pulsegrid_ota")
    _mkdir(STAGE_DIR)
    _mkdir(BACKUP_DIR)
    _clear_directory(STAGE_DIR)
    _clear_directory(BACKUP_DIR)
    _remove(HEALTH_FILE)
    _write_state({"state": "downloading", "version": str(version), "files": []})


def stage_path(name):
    if not name or "/" in name or "\\" in name or name.startswith("."):
        raise ValueError("Nombre de archivo OTA invalido")
    return STAGE_DIR + "/" + name


def ready(version, files):
    _write_state({"state": "ready", "version": str(version), "files": list(files)})


def _rollback(files, present=None):
    present = present or []
    for name in files:
        backup = BACKUP_DIR + "/" + name
        if _exists(backup):
            _remove(name)
            os.rename(backup, name)
        elif name not in present:
            _remove(name)
        _remove(STAGE_DIR + "/" + name)
    _clear_directory(BACKUP_DIR)
    _clear_directory(STAGE_DIR)
    _remove(HEALTH_FILE)
    _remove(STATE_FILE)


def _apply(state):
    files = list(state.get("files") or [])
    present = [name for name in files if _exists(name)]
    for name in files:
        if not _exists(stage_path(name)):
            raise OSError("Falta archivo OTA: " + name)
    _write_state({"state": "installing", "version": state.get("version", ""), "files": files, "present": present})
    try:
        for name in files:
            backup = BACKUP_DIR + "/" + name
            _remove(backup)
            if _exists(name):
                os.rename(name, backup)
        for name in files:
            os.rename(STAGE_DIR + "/" + name, name)
        _write_state({"state": "applied", "version": state.get("version", ""), "files": files})
        _remove(HEALTH_FILE)
        global _wdt
        try:
            _wdt = machine.WDT(timeout=20000)
        except Exception:
            _wdt = None
    except Exception:
        _rollback(files, present)
        raise


def _finalize(state):
    files = list(state.get("files") or [])
    _clear_directory(BACKUP_DIR, files)
    _clear_directory(STAGE_DIR)
    _remove(HEALTH_FILE)
    _remove(STATE_FILE)


def run():
    state = _read_state()
    if not state:
        return
    if state.get("state") == "applied":
        if _exists(HEALTH_FILE):
            _finalize(state)
        else:
            _rollback(list(state.get("files") or []), list(state.get("present") or []))
        return
    if state.get("state") == "ready":
        _apply(state)
        return
    if state.get("state") == "installing":
        _rollback(list(state.get("files") or []), list(state.get("present") or []))


def confirm():
    state = _read_state()
    if state and state.get("state") == "applied":
        with open(HEALTH_FILE + ".tmp", "w") as marker:
            marker.write(str(state.get("version", "")))
        _remove(HEALTH_FILE)
        os.rename(HEALTH_FILE + ".tmp", HEALTH_FILE)
    feed()


def feed():
    if _wdt:
        try:
            _wdt.feed()
        except Exception:
            pass
