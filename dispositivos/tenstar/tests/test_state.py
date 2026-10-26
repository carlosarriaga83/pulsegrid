import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('state_test', Path(__file__).resolve().parents[1] / 'tenstar_state.py')
state = importlib.util.module_from_spec(spec)
spec.loader.exec_module(state)


class StateTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = str(Path(directory.name) / 'state.json')
        self.old = {'calibrated': True, 'span': 4000, 'position': 0}
        self.new = {**self.old, 'position': 2000}

    def test_redundant_checksum_records_round_trip(self):
        state.save(self.path, self.old)
        self.assertEqual(state.load(self.path), (self.old, True))
        state.mark_moving(self.path)
        self.assertEqual(state.load(self.path), (self.old, False))
        state.save(self.path, self.new)
        self.assertEqual(state.load(self.path), (self.new, True))

    def test_truncated_copy_recovers_calibration_not_position(self):
        state.save(self.path, self.old)
        Path(self.path + '.0').write_text('{"generation":')
        self.assertEqual(state.load(self.path), (self.old, False))

    def test_checksum_rejects_altered_valid_json(self):
        state.save(self.path, self.old)
        path = Path(self.path + '.1')
        record = json.loads(path.read_text())
        record['data'] = json.dumps(self.new)
        path.write_text(json.dumps(record))
        self.assertEqual(state.load(self.path), (self.old, False))

    def test_cut_at_each_write_boundary_keeps_a_valid_copy_and_dirty_reference(self):
        original_open = open
        for boundary in (1, 2):
            with self.subTest(boundary=boundary):
                state.save(self.path, self.old)
                state.mark_moving(self.path)
                writes = []

                def interrupted_open(path, mode):
                    if mode == 'w':
                        writes.append(path)
                        if len(writes) == boundary:
                            with original_open(path, 'w') as truncated:
                                truncated.write('{')
                            raise OSError('power cut')
                    return original_open(path, mode)

                with patch.object(state, 'open', interrupted_open, create=True):
                    with self.assertRaisesRegex(OSError, 'power cut'):
                        state.save(self.path, self.new)
                recovered, trusted = state.load(self.path)
                self.assertTrue(recovered['calibrated'])
                self.assertFalse(trusted)

    def test_marker_removal_failure_never_restores_stale_reference(self):
        state.save(self.path, self.old)
        state.mark_moving(self.path)
        with patch.object(state.os, 'remove', side_effect=OSError('power cut')):
            with self.assertRaises(OSError):
                state.save(self.path, self.new)
        self.assertEqual(state.load(self.path), (self.new, False))

    def test_save_failure_before_motion_is_explicit(self):
        with patch.object(state, 'open', side_effect=OSError('flash full'), create=True):
            with self.assertRaisesRegex(OSError, 'flash full'):
                state.mark_moving(self.path)

    def test_no_files_are_not_successfully_loaded(self):
        self.assertEqual(state.load(self.path), (None, False))


if __name__ == '__main__':
    unittest.main()
