# FIRMWARE 인계 — 구현 및 실제 검증 완료

## 상태 / 범위

DONE (소프트웨어 구현·호스트 검증·양쪽 타깃 크로스 빌드). 하드웨어/휴대폰 실측은 미실행이며 별도 인수 단계다.

작업 위치 `/home/minwoo/.superset/projects/videx`, 브랜치 `main`, 시작 커밋 `f7f0ea4`. 커밋·푸시·브랜치 전환 없음. 다른 담당자의 mobile/docs 변경 보존. `cam/managed_components` 수정 없음.

범위 파일:

- `cam/main/main.c`, `CMakeLists.txt`: CAMERA_LEFT 단일 송신, 원래 핀맵/캡처/CAM2 보존, NVS fail-closed, 독립 버튼 샘플/전송 태스크, 비차단 소켓의 절대 마감, 안전한 프레임 소유권 및 해상도 재설정.
- `cam/main/cam_core.{c,h}`, `cam_io.{c,h}`, `cam/tests_v2/{test_core.c,test_io.c,test_integration.py}`.
- `proxy/main/main.c`, `CMakeLists.txt`, `gateway.c`, `gateway_core.h`, `gateway_json.h`, `provision.h`, `button.h`; `proxy/sdkconfig.defaults`, `proxy/test_button.c`.
- `proxy/tests_v2/`: 전체 호스트 실행기, CAM2/VDX2·ACK·큐·프로비저닝 C 테스트, 실제 cJSON 명령 파서 테스트, CAM→BTN2→S3 버튼 통합 C 테스트, 핀맵/원본 JPEG 보존 가드, 오프라인 프로비저닝 도구/테스트.
- `docs/v2/firmware.md`, 이 인계 파일.

## 핵심 통합 계약 (CORE 확인용)

- 로컬 TLS443 `/ws`, 정확한 NVS Origin/Host 일치, RFC1918 IPv4 피어만 허용, 첫 텍스트 `{type:'authenticate',token}` 인증. 인증 전 영상/업무 이벤트 없음. 인증 뒤 `connected`가 영상보다 먼저 큐에 들어간다.
- 바이너리: 고정 VDX2 24바이트 + 원본 CAM2 28바이트 + 원본 JPEG, 총 헤더52바이트. JPEG 최대1MiB, camera_id0만. epoch/sequence/S3 수신시각 포함. 서로 다른 장치 시계 차감 금지.
- 사용자 통합 지적 반영 완료: `resolution_applied`에 `request_id,mode,width,height,reason:'observed'` 모두 포함. 실제 JPEG SOF와 CAM2 크기를 대조하고 요청 크기와 일치한 경우만 ACK한다. `width,height`는 요청 모드로 만들어 넣지 않는다. 동일 직렬화 함수를 실제 펌웨어와 C 테스트가 함께 사용한다.
- 펌웨어 ACK 제한5초, 현재 `mobile/src/core/source.ts`의6초 제한보다 짧다. 실패/timeout/busy 시 `resolution_failed`; 동시 진행은1개만. request_id는1..64 ASCII 영숫자/하이픈/밑줄(crypto.randomUUID 호환).
- 이벤트 `button_short|button_long,event_id,epoch`;2초 heartbeat; 카메라/버튼 링크 단절·제어 큐 초과 시 fail-closed 및 새 세션 요구. 오래된 press가 브라우저 재인증 뒤에 넘어오지 않도록 세션 변경과 버튼 분류를 같은 mutex로 보호한다.
- WSS pending 영상1개 + in-flight1개; 별도 신뢰 제어 FIFO16개. HTTPD work1개만 outstanding. USB는 NVS opt-in이며 독립 복사본/별도 큐로 소유권 분리. 원본 CAM2/JPEG 그대로 출력하는 진단용이다.

## CAM2 / 핀맵 보존 확인

원래 main을 먼저 읽고 비교했다. `camera_id` 기본 RIGHT를 LEFT0으로 변경했으며 RIGHT pause/stereo 분기를 제거했다. CAM2 필드 순서·오프셋·28바이트 길이와 little-endian golden bytes 유지. 송신은 원래 `item.fb->buf,item.fb->len`; S3가 JPEG를 재인코딩하지 않는다. 이 조건과 핀 값은 호스트 회귀 테스트로 고정했다.

AI-Thinker classic ESP32-CAM: PWDN32, RESET-1, XCLK0, SCCB SDA26/SCL27, D7..D0=35/34/39/36/21/19/18/5, VSYNC25/HREF23/PCLK22, XCLK20MHz, JPEG 캡처. 기존 GPIO13 active-low pull-up 버튼 유지(동시에 microSD 사용 금지). S3-CAM 송신 보드로의 포팅은 제공/검증하지 않는다.

BTN2는 CAM2 payload 변경이 아닌 별도 TCP5001 채널이다.64 ASCII cam_token 인증 뒤12바이트 BTN2 + u32 sequence + pressed + zero3.20ms 샘플, CAM FIFO8개/최대100ms age/60ms sampling gap, S3 receive250ms·debounce40ms·LONG1s. JPEG가 없거나 드롭돼도 독립 처리하며, 큐 넘침/샘플 누락은 제스처를 취소한다.

## 실제 실행 결과

1. `python3 proxy/tests_v2/run_host_tests.py --sanitize` — exit0.
   실제 생산 C 코드를 사용하는7개 C 실행 파일, Python unittest9개, skip0. `-std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined` 통과. 실제 socketpair backpressure/deadline/disconnect, 영상 없는 CAM FIFO→BTN2→S3 SHORT/LONG, JSON 중복 키·스키마·인증 단계·escaped NUL 거부, ACK width/height 직렬화, 핀맵/CAM2 보존 포함.
   실제 ESP-IDF NVS 생성기로 CAM/S3 CSV→0x6000 binary 생성도 통과. 테스트 인증서/키 파일은 명시적 가짜 fixture이며 실제 TLS 성공 결과가 아니다. 비밀값 출력 없음.

2. ESP-IDF v5.5.4, Xtensa GCC14.2.0 설치 및 Python3.12 환경 dependency check 성공.
   `idf.py -C proxy -B "$TMPDIR/videx-build-proxy" -D SDKCONFIG="$TMPDIR/videx-proxy-sdkconfig" -D IDF_TARGET=esp32s3 build` — 최종 exit0, `proxy.bin`0xdd290 bytes, app partition41% 여유.

3. CAM의 vendored 변경을 방지하기 위해 main/defaults/lock/managed_components를 scratch에 정확히 복사한 스냅샷에서 빌드:
   `idf.py -C "$TMPDIR/videx-cam-build-source" -B "$TMPDIR/videx-build-cam-snapshot" -D SDKCONFIG="$TMPDIR/videx-cam-sdkconfig" -D IDF_TARGET=esp32 build` — 최종 exit0, `cam.bin`0xe5c50 bytes, app partition10% 여유.
   원본과 빌드 스냅샷 main/managed_components168개 파일 SHA256 비교 mismatch0. 레포 vendored diff0. 기존 추적 sdkconfig를 빌드 과정에서 변경하지 않았다.

4. `git diff --check -- cam proxy/main proxy/sdkconfig.defaults proxy/test_button.c` — exit0.
   `git diff --name-only -- cam/managed_components` — 출력 없음. 최종 브랜치 main.

최종 로그:

- `/home/minwoo/.hermes/profiles/dev-senior/cache/scratch/videx-host-tests.log`
- `/home/minwoo/.hermes/profiles/dev-senior/cache/scratch/videx-proxy-build-final.log`
- `/home/minwoo/.hermes/profiles/dev-senior/cache/scratch/videx-cam-build-final.log`
- 초기 S3 전체 빌드 로그 `/home/minwoo/.hermes/profiles/dev-senior/cache/terminal-output/out-1792436496-1214576-63f0.log`

빌드 산출물:

- `/home/minwoo/.hermes/profiles/dev-senior/cache/scratch/videx-build-proxy/proxy.bin` 및 `proxy.elf`
- `/home/minwoo/.hermes/profiles/dev-senior/cache/scratch/videx-build-cam-snapshot/cam.bin` 및 `cam.elf`

재현 환경:

    export IDF_PATH=/home/minwoo/.hermes/profiles/dev-senior/cache/scratch/videx-idf
    export IDF_TOOLS_PATH=/home/minwoo/.hermes/profiles/dev-senior/cache/scratch/videx-idf-tools
    export IDF_PYTHON_ENV_PATH="$IDF_TOOLS_PATH/python_env/idf5.5_py3.12_env"
    source "$IDF_PYTHON_ENV_PATH/bin/activate"
    source "$IDF_PATH/export.sh"

## 자식 작업 중단과 복구

CAM 자식과 ESP-IDF 설치 자식 모두 모델/API 타임아웃으로 interrupted 상태로 종료했다. 자식의 완료 주장을 사용하지 않았다. 남겨진 CAM main/core/I/O/tests를 부모가 전부 읽고 인수하여 AP 암호 최소 길이16으로 S3와 정합화, 전체 호스트 테스트 및 실제 CAM 빌드를 수행했다. 미완료 자식에 남겨 둔 필수 구현/검증은 없다.

IDF 설치 자식은 IDF clone/submodules 및 타깃 도구 설치까지 성공했으나 Python venv seed 단계에서 타임아웃이었다. 부모가 `uv pip install --python <venv-python> --index-url https://pypi.org/simple pip setuptools -r <IDF>/tools/requirements/requirements.core.txt`로 복구 후 공식 `idf_tools.py install-python-env --features core`와 공식5.5 constraints를 적용했다. dependency check OK 뒤 양 타깃 빌드 완료. 설치 실패로 남은 blocker 없음.

최초 CAM 시도에서 `IDF_COMPONENT_MANAGER=0`으로 managed alias `esp32-camera`를 해석하지 못해 exit2였다. 소스 컴파일 오류가 아니라 관리형 의존성 이름 해석 문제였으며, vendored를 건드리지 않는 정확한 scratch 스냅샷에서 component manager를 켠 정식 빌드로 해결했다.

## 남은 실제 인수 / 위험

하드웨어가 없어 플래시·부팅·카메라 영상·GPIO 실입력·USB 실전송·실제 WSS/TLS handshake·Android/iOS PWA 연결·AP+STA 채널 전환/인터넷 병행·실측 FPS/지연/전력은 전부 미실행. 크로스 빌드나 host socket 테스트를 하드웨어 성공으로 표현하지 않는다. 실제/유료 OpenAI 호출 없음.

기기별 NVS, 유효한 신뢰 TLS fullchain/key, local DNS, 정확한 PWA Origin/장치 Host를 운영자가 프로비저닝해야 한다. 기본 비밀값/HTTP 폴백/공개 이미지 중계 없음. AP 암호는 per-pair 고유값이며 CAM2 이미지 채널의 신뢰 경계다. AP 암호 또는 물리 NVS를 가진 상대는 신뢰 대상으로 취급한다. secure boot/flash·NVS 암호화는 별도 생산 보안 작업이다.

S3 PSRAM 종류/핀/플래시 규격은 실제 보드에 맞춰 확인한다(현재 S3 defaults는 quad PSRAM auto, not-found 허용). 메모리 부족이면 스트림을 끊으며 성공으로 가장하지 않는다. 기존 upstream/hotspot이192.168.4.0/24와 겹치지 않아야 한다. 인증서 갱신, 모바일 로컬 네트워크 권한·client isolation·셀룰러 병행 가능성은 별도 검증한다. 배포/프로비저닝/하드웨어 체크리스트는 `firmware.md` 참조.
