import hashlib
import json
import os


def _sync():
    if hasattr(os, 'sync'):
        os.sync()


def _read(path):
    try:
        with open(path, 'r') as source:
            record = json.loads(source.read())
        data = record['data']
        digest = hashlib.sha256(data.encode()).digest()
        if record['checksum'] != list(digest) or not isinstance(record['generation'], int):
            raise ValueError('Checksum o generacion invalida')
        state = json.loads(data)
        if not isinstance(state, dict):
            raise ValueError('Estado invalido')
        return record['generation'], state
    except OSError as error:
        if error.args[0] != 2:
            raise
    except (ValueError, KeyError, TypeError) as error:
        print('Tenstar: copia de estado invalida', path, error)
    return None


def exists(path):
    try:
        os.stat(path)
        return True
    except OSError as error:
        if error.args[0] != 2:
            raise
        return False


def load(path):
    first, second = _read(path + '.0'), _read(path + '.1')
    records = [record for record in (first, second) if record is not None]
    if not records:
        return None, False
    latest = max(records, key=lambda record: record[0])
    consistent = first is not None and second is not None and first == second
    if not consistent:
        print('Tenstar: recuperado respaldo; confirma referencia fisica')
    return latest[1], consistent and not exists(path + '.moving')


def mark_moving(path):
    with open(path + '.moving', 'w') as marker:
        marker.write('reference uncertain')
    _sync()
    if not exists(path + '.moving'):
        raise OSError('No se pudo guardar la marca de movimiento')


def save(path, state):
    records = [_read(path + '.0'), _read(path + '.1')]
    generation = max([record[0] for record in records if record is not None] + [0]) + 1
    data = json.dumps(state)
    encoded = json.dumps({'generation': generation, 'data': data,
                          'checksum': list(hashlib.sha256(data.encode()).digest())})
    # Replace the older slot first; never truncate the only newest valid copy.
    order = sorted(range(2), key=lambda index: records[index][0] if records[index] else -1)
    for index in order:
        target = path + '.' + str(index)
        with open(target, 'w') as output:
            output.write(encoded)
        _sync()
        if _read(target) != (generation, state):
            raise OSError('No se pudo verificar el estado Tenstar')
    if exists(path + '.moving'):
        os.remove(path + '.moving')
        _sync()
