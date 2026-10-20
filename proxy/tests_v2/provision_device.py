#!/usr/bin/env python3
"""Generate per-pair NVS CSVs offline. NEVER prints secrets or flashes a board.
Use the ESP-IDF nvs_partition_gen.py utility to turn CSV into partition images.
Output contains credentials: keep outside git and provision via a trusted cable.
"""
import argparse
import csv
import json
import os
from pathlib import Path
import re
import secrets


def _write_csv(path, entries):
    with path.open('x', encoding='utf-8', newline='') as stream:
        os.chmod(path, 0o600)
        writer = csv.writer(stream)
        writer.writerow(['key', 'type', 'encoding', 'value'])
        writer.writerow(['videx', 'namespace', '', ''])
        writer.writerows(entries)


def provision(out, certificate, private_key, origin, host, *, sta_ssid='', sta_pass='', usb=False):
    if not re.fullmatch(r'https://[a-z0-9.-]+(?::[0-9]+)?', origin):
        raise ValueError('Origin must be one exact HTTPS origin, without trailing slash/path')
    if not re.fullmatch(r'[a-z0-9.-]{1,128}', host) or len(origin) > 192:
        raise ValueError('Host must be the exact lowercase TLS DNS hostname, port 443')
    if bool(sta_ssid) != bool(sta_pass) or len(sta_ssid.encode()) > 32 or (sta_pass and not 8 <= len(sta_pass.encode()) <= 63):
        raise ValueError('Optional WPA2 STA credentials must be supplied together')
    certificate, private_key = Path(certificate).resolve(), Path(private_key).resolve()
    if not certificate.is_file() or not private_key.is_file():
        raise ValueError('Certificate chain and key must already exist; no generated/self-signed fallback')
    # Do not read or print a private key. ESP-IDF handles file/blob ingestion.
    if certificate.stat().st_size > 8192 or private_key.stat().st_size > 4096:
        raise ValueError('PEM files exceed firmware limits')
    out = Path(out)
    out.mkdir(mode=0o700, parents=True, exist_ok=False)
    common = [('ap_ssid', 'data', 'string', 'VIDEX-' + secrets.token_hex(4)),
              ('ap_pass', 'data', 'string', secrets.token_urlsafe(24)),
              ('cam_token', 'data', 'string', secrets.token_hex(32))]
    pair_token = secrets.token_hex(32)
    s3 = common + [('pair_token', 'data', 'string', pair_token),
                   ('origin', 'data', 'string', origin), ('host', 'data', 'string', host),
                   ('sta_enabled', 'data', 'u8', int(bool(sta_ssid))),
                   ('usb_diag', 'data', 'u8', int(usb)),
                   ('tls_cert', 'file', 'binary', str(certificate)),
                   ('tls_key', 'file', 'binary', str(private_key))]
    if sta_ssid:
        s3 += [('sta_ssid', 'data', 'string', sta_ssid), ('sta_pass', 'data', 'string', sta_pass)]
    _write_csv(out / 'cam.csv', common)
    _write_csv(out / 's3.csv', s3)
    with (out / 'pairing.json').open('x', encoding='utf-8') as stream:
        os.chmod(out / 'pairing.json', 0o600)
        json.dump({'url': f'wss://{host}/ws', 'host': host, 'token': pair_token}, stream)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True, help='NEW private directory outside repository')
    parser.add_argument('--certificate', type=Path, required=True, help='Trusted PEM full certificate chain')
    parser.add_argument('--private-key', type=Path, required=True)
    parser.add_argument('--origin', required=True)
    parser.add_argument('--host', required=True)
    parser.add_argument('--sta-config', type=Path, help='Optional private JSON file: ssid,password; never printed')
    parser.add_argument('--usb-diagnostics', action='store_true')
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    if args.out.resolve().is_relative_to(repo):
        parser.error('Provisioning output must be outside the repository')
    sta = json.loads(args.sta_config.read_text()) if args.sta_config else {}
    try:
        provision(args.out, args.certificate, args.private_key, args.origin, args.host,
                  sta_ssid=sta.get('ssid', ''), sta_pass=sta.get('password', ''), usb=args.usb_diagnostics)
    except (ValueError, OSError) as error:
        parser.error(str(error))
    print('Offline provisioning files created. Secrets not displayed; no hardware flashed.')


if __name__ == '__main__':
    main()
