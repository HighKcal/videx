# VIDEX v2 firmware

## Scope and fixed topology

Classic AI-Thinker ESP32-CAM (one transmitter, camera_id=0) → ESP32-S3 SoftAP TCP5000 → authenticated local TLS WebSocket /ws → paired PWA. No RIGHT camera, stereo synchronization, Internet image proxy, image disk storage, or firmware AI requests. The classic ESP32 pin map is preserved; an S3-CAM transmitter needs an explicit board port and is not claimed supported.

CAM2 TCP payload stays 28-byte little-endian `<IBB2xIIHHQ` followed by the original JPEG. S3 does not re-encode or rewrite CAM2 for mobile. WSS binary messages are exactly 24-byte VDX2 + original CAM2 + original JPEG. VDX2: magic at0, u16 version1 at4, u16 total header52 at6, u32 epoch at8, u32 sequence at12, u64 S3 receive monotonic microseconds at16. JPEG starts52. Maximum JPEG1MiB, camera_id0 only. Separate clocks must not be subtracted.

## WSS and control contract

HTTPS port443 only, one paired WSS session. Before WebSocket upgrade, exact configured HTTPS Origin and Host must match; URI must be `/ws` without query, peer must have RFC1918 IPv4 address. There is no HTTP/ws fallback or public proxy. First unfragmented text message within5s:

    {"type":"authenticate","token":"<64 lowercase hex per-device token>"}

No frame/control output before authentication. Successful authentication queues `{"type":"connected","epoch":<u32>}` before frames. Per-session sequence/event IDs do not silently wrap. Wrong authentication, malformed/oversized/fragmented JSON, unknown command, duplicate JSON key, or exhausted control queue closes the connection. Tokens are never logged.

Resolution request (at most one active):

    {"type":"resolution","request_id":"<1..64 alnum, hyphen or underscore>","mode":1}

Modes0=320×240,1=640×480,2=1280×1024. A command write is NOT an ACK. S3 checks JPEG marker boundaries and actual SOF dimensions against CAM2 metadata and requested dimensions, then emits:

    {"type":"resolution_applied","request_id":"...","mode":1,"width":640,"height":480,"reason":"observed"}

`width,height` come from the validated observed JPEG, not a requested-mode lookup. The same serializer and fields are covered by `proxy/tests_v2/test_protocol.c`, matching `mobile/src/core/source.ts` validation. Five-second timeout, camera loss/unavailability or another pending request yields `resolution_failed`; timeout dimensions are0,0, never a fabricated successful size. Mobile has a6s ACK deadline. ACKs are queued before the corresponding frame can be dequeued for WSS.

Reliable button messages use `button_short`/`button_long`, monotonic `event_id` and session `epoch`. Heartbeat every2s includes S3 time and camera/button online status. Capture link loss or button channel loss fails closed with `disconnected` and requires fresh authentication/epoch. Applications must still mark stale video UNKNOWN independently.

## Button channel, independent of capture

CAM samples GPIO13 (active-low pull-up, no microSD sharing) separately from JPEG capture. On separate local TCP5001, CAM sends exactly64 raw ASCII bytes of its per-pair `cam_token`, then12-byte little-endian records: ASCII BTN2, u32 sequence, u8 pressed0/1, three zero bytes. S3 requires consecutive sequence values,250ms receive deadline,40ms debounce,1s long press using S3 monotonic elapsed time. Missing samples, malformed records, disconnects and reconnect-held input cancel the gesture until a stable release. Browser reauthentication also resets gesture state atomically with the new session, so a held gesture cannot cross sessions. This does not derive time from FPS and does not reuse the drop-old video queue. CAM separately bounds its reliable sample FIFO to8 entries,100ms maximum sample age and60ms sampling gap; overflow/stall cancels the channel instead of dropping edges.

The CAM→S3 JPEG socket remains the existing CAM2 protocol, protected by a unique WPA2 SoftAP credential and binding TCP5000/5001 to192.168.4.1 only. CAM2 header checks are not camera authentication. The button socket additionally authenticates a separate shared token. Anyone with physical firmware/NVS access or the AP credential must be treated as trusted; keep the AP credential distinct from the browser pairing token.

## Queue and memory ownership

S3 retains one latest frame plus at most one in-flight WSS frame; a new capture frees/replaces the older pending frame. Receiver can additionally own the frame currently being received. Control ring is separate,16 entries ×256 bytes, FIFO, no silent overwrite. Overflow closes the session. At most one HTTPD work callback is outstanding; all WebSocket writes are serialized in that server task. Each whole WSS send has an absolute2s budget,4096-byte TLS writes and200ms socket timeout; partial/zero/failing writes fail closed.

USB is optional, disabled unless NVS `usb_diag=1`. It uses an independent allocated copy, one queued frame and a separate bounded writer; no shared JPEG pointer/refcount or USB-originated resolution control race. USB output remains CAM2/JPEG, diagnostics only. UART carries logs. No JPEG, pairing token or credentials appear in logs.

## Offline per-device provisioning

Unprovisioned/invalid NVS means no radio/server; no default AP secret, built-in TLS key, open provisioning AP, self-signed fallback or automatic credential erase. Provision over a trusted cable. Namespace `videx`:

- Both boards: strings `ap_ssid` (1..32 bytes), `ap_pass` (16..63 bytes), `cam_token` (64 lowercase hex).
- S3 only: distinct `pair_token` (64 lowercase hex), exact `origin` (HTTPS origin with no slash/path), exact lowercase DNS `host` (default TLS443), binary PEM file blobs `tls_cert` (≤8192 bytes), `tls_key` (≤4096 bytes).
- S3 flags u8 `sta_enabled` and `usb_diag`, default0. Optional WPA2 `sta_ssid` and `sta_pass` required together when enabled.

Generate fresh pair CSVs into a NEW private directory outside git:

    python3 proxy/tests_v2/provision_device.py --out /secure/new-device --certificate /secure/fullchain.pem --private-key /secure/device-key.pem --origin https://videx.example.com --host device.example.com

Optional `--sta-config /secure/router.json` reads `{ "ssid": "...", "password": "..." }`; no secrets on command-line/logs. `--usb-diagnostics` enables diagnostic copies. Tool creates0600 `cam.csv`, `s3.csv`, `pairing.json`, directory0700; refuses overwrite. It never prints secrets or flashes a board. Certificate/key fixture files in tests are explicitly NOT real TLS certificates. The actual certificate must be valid for `host`, trusted by the target phone and renewed out of band. Use local DNS to resolve that hostname to S3 LAN address. DNS-01/CA issuance is an operator prerequisite, not an insecure firmware workaround.

Use ESP-IDF's `components/nvs_flash/nvs_partition_generator/nvs_partition_gen.py generate <csv> <binary> <nvs-partition-size>` and write each image to that board's actual NVS partition address. Read the generated partition table before flashing; do not guess offsets or erase the whole board. NVS images/CSVs contain secrets; never add to git. Flash encryption/secure boot/NVS encryption are separate production hardening, not enabled or hardware-verified by this change.

## Network operation and limitations

Default S3 AP serves camera plus phone. Optional AP+STA keeps CAM on S3 AP and connects S3/phone via existing router or phone hotspot. STA channel wins; evaluate camera reconnects/throughput/power, client isolation, DNS and local-network browser permissions. If router/phone hotspot subnet overlaps192.168.4.0/24, choose a nonoverlapping upstream network; this firmware's preserved camera link uses192.168.4.1. No NAT/router/Internet-image forwarding is enabled. Cellular Internet alongside phone Wi-Fi is OS-specific, NOT guaranteed. No hardware/mobile-browser results are claimed.

## Host verification

From repository root, use `python3 proxy/tests_v2/run_host_tests.py --sanitize` (C compiler required). This runner includes CAM and S3 core C tests, actual socket deadline/disconnect tests, a CAM FIFO→BTN2→S3 event integration test with no video, preserved pin/wire guards, and offline provisioning tests. Set `IDF_PATH` to additionally compile the actual cJSON command parser; activate the IDF Python environment to also test real CSV→NVS binary generation. Without these optional dependencies, those checks explicitly report SKIP. All were actually run without skips in this implementation environment. Build/flashing/radio/TLS browser acceptance results belong in `firmware-handoff.md`; do not equate host tests or a cross-compile with functioning hardware.
