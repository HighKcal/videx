"""Offline provisioning tests: temporary dummy bytes are NOT TLS/hardware results."""
import csv
import importlib.util
import pathlib
import subprocess
import sys
import tempfile
import unittest

PATH = pathlib.Path(__file__).with_name('provision_device.py')

class ProvisionTests(unittest.TestCase):
    @unittest.skipUnless(importlib.util.find_spec('esp_idf_nvs_partition_gen'), 'ESP-IDF Python NVS generator not installed')
    def test_actual_idf_nvs_csv_to_binary(self):
        spec = importlib.util.spec_from_file_location('provision_device', PATH)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            cert, key = root / 'fixture-cert.pem', root / 'fixture-key.pem'
            cert.write_text('TEST FIXTURE NOT A CERTIFICATE ' * 3)
            key.write_text('TEST FIXTURE NOT A PRIVATE KEY ' * 3)
            out = root / 'generated'
            module.provision(out, cert, key, 'https://videx.example.com', 'device.example.com')
            for board in ('cam', 's3'):
                result = subprocess.run([sys.executable, '-m', 'esp_idf_nvs_partition_gen', 'generate',
                    str(out / f'{board}.csv'), str(out / f'{board}.bin'), '0x6000'], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, 'Actual ESP-IDF NVS CSV generation failed')
                self.assertEqual((out / f'{board}.bin').stat().st_size, 0x6000)

    def test_offline_pair_has_distinct_strong_secrets_and_correct_nvs(self):
        spec = importlib.util.spec_from_file_location('provision_device', PATH)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            cert = root / 'certificate.pem'
            key = root / 'private.pem'
            cert.write_text('test certificate fixture, not a real certificate')
            key.write_text('test key fixture, not a real private key')
            out = root / 'generated'
            module.provision(out, cert, key, 'https://videx.example.com', 'device.example.com')
            def rows(name):
                with (out / name).open() as stream:
                    return {r[0]: r[3] for r in list(csv.reader(stream))[2:]}
            cam, s3 = rows('cam.csv'), rows('s3.csv')
            self.assertEqual(cam['ap_pass'], s3['ap_pass'])
            self.assertEqual(cam['cam_token'], s3['cam_token'])
            self.assertNotEqual(s3['cam_token'], s3['pair_token'])
            self.assertEqual(len(s3['cam_token']), 64)
            self.assertGreaterEqual(len(s3['ap_pass']), 16)
            self.assertEqual(s3['tls_cert'], str(cert.resolve()))
            self.assertEqual(s3['sta_enabled'], '0')
            self.assertEqual((out / 's3.csv').stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                module.provision(out, cert, key, 'https://videx.example.com', 'device.example.com')
    def test_bad_origin_does_not_write(self):
        spec = importlib.util.spec_from_file_location('provision_device', PATH)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as temp:
            out = pathlib.Path(temp) / 'generated'
            with self.assertRaises(ValueError):
                module.provision(out, pathlib.Path('x'), pathlib.Path('y'), 'http://bad', 'device.example.com')
            self.assertFalse(out.exists())

if __name__ == '__main__':
    unittest.main()
