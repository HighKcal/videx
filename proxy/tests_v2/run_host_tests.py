#!/usr/bin/env python3
"""Run real shared firmware-core C tests without an ESP-IDF installation."""
import argparse
import os
from pathlib import Path
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sanitize', action='store_true')
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    flags = ['-std=c11', '-Wall', '-Wextra', '-Werror', '-g']
    if args.sanitize:
        flags += ['-fsanitize=address,undefined', '-fno-omit-frame-pointer']
    with tempfile.TemporaryDirectory(prefix='videx-firmware-', dir=os.environ.get('TMPDIR')) as temp:
        suites = [(['proxy/test_button.c'], ['proxy/main']),
                  (['proxy/tests_v2/test_protocol.c'], ['proxy/main']),
                  (['proxy/tests_v2/test_provision.c'], ['proxy/main']),
                  (['cam/tests_v2/test_core.c', 'cam/main/cam_core.c'], ['cam/main']),
                  (['cam/tests_v2/test_io.c', 'cam/main/cam_io.c'], ['cam/main'])]
        suites.append((['proxy/tests_v2/test_button_link.c', 'cam/main/cam_core.c'], ['proxy/main', 'cam/main']))
        idf = Path(os.environ.get('IDF_PATH', '/nonexistent'))
        cjson = idf / 'components/json/cJSON'
        if (cjson / 'cJSON.c').is_file():
            suites.append((['proxy/tests_v2/test_gateway_json.c', str(cjson / 'cJSON.c')], ['proxy/main', str(cjson)]))
        else:
            print('SKIP: cJSON WSS parser test needs IDF_PATH (other core tests remain dependency-free)', flush=True)
        for sources, includes in suites:
            source = sources[0]
            binary = str(Path(temp) / Path(source).stem)
            command = [os.environ.get('CC', 'cc'), *flags, *[f'-I{p}' for p in includes], *sources, '-lm', '-o', binary]
            print('+', ' '.join(command), flush=True)
            subprocess.run(command, cwd=repo, check=True)
            subprocess.run([binary], cwd=repo, check=True)
    subprocess.run(['python3', '-m', 'unittest', 'discover', '-s', 'proxy/tests_v2', '-p', 'test_*.py', '-v'], cwd=repo, check=True)
    subprocess.run(['python3', '-m', 'unittest', 'discover', '-s', 'cam/tests_v2', '-p', 'test_*.py', '-v'], cwd=repo, check=True)
    print('PASS: all CAM/S3 host firmware tests (no hardware was exercised)')


if __name__ == '__main__':
    main()
