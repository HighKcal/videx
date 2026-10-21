# Android USB CDC 전용 모바일 — CDC-only-mobile handoff

작업 위치: `/home/minwoo/.superset/projects/videx`, 브랜치 `feat/videx-v2-android-cdc-demo`. 프런트 구현·검증 완료 후 freeze. 다른 작업자의 backend·펌웨어·문서 변경은 보존했다.

## 연결과 서버 준비

1. Android Chrome에서 HTTPS 앱을 열고 VIDEX 로고를 눌러 진단 및 설정을 연다. 연결은 USB CDC 하나뿐이다. 연결 방식·펌웨어 프로필·AI 전송 경로 선택이나 키/토큰 입력란은 없다.
2. OTG/데이터 케이블로 S3 USB Serial/JTAG 포트에 연결한다. `USB 장치 선택 및 연결` 버튼을 직접 눌러 Espressif 장치를 허용한다. health 조회 완료를 기다리지 않아도 chooser 사용자 제스처는 유지된다.
3. 실제 수신 크기, 처리 프레임 증가와 보행 Worker 상태를 확인한다. 로컬 보행 처리는 서버 없이 가능하다. OCR은 선택 사진 동의, AI 음성은 별도의 텍스트 동의가 필요하다. 연속 영상은 서버에 보내지 않는다.
4. 서버 조회 중에는 `서버 상태 확인 중`을 표시한다. 올바른 ready/demo 확인 후에만 동의한 API 요청을 허용한다. 인증 필수·준비 안 됨·구형/잘못된 health·통신 실패는 운영자 설정 오류이며, 사용자에게 인증정보를 요구하지 않는다.
5. 운영자는 backend의 `VIDEX_DEMO_MODE=true`, provider 설정 및 정확한 허용 origin을 준비해야 한다. 앱은 익명 same-origin `/api/health`, `/api/vision`, `/api/speech`만 사용하며 Authorization 헤더를 보내지 않는다. 직접 OpenAI 요청·브라우저 자격증명·WSS 연결 경로는 제거했다. 서버 모드의 fixed provider 정책과 비용은 운영자 책임이다.

WebUSB는 VID/PID `303a:1001`의 CDC ACM 제어/데이터 인터페이스만 사용한다. JTAG 인터페이스, Python 브리지, Cloudflare 영상 중계, bootloader/reset handshake는 사용하지 않는다. 기종별 OS CDC 점유로 열기 실패할 수 있으며 권한 허용만으로 해결을 보장하지 않는다. 미지원·선택 취소·열기/읽기 실패·영상 지연·분리를 명확히 표시한다.

## 자동 프로토콜과 버튼

구현 전 공개된 [cdc-protocol.md](cdc-protocol.md)의 USB2 계약을 읽고 구현했다. 읽기 전용 mirror 프로필은 제거했다.

- 연결 직후 bounded USB2 hello를 보내고 CAM2 영상을 동시에 수신한다. 유효한 connected를 최대 1500 ms 기다린다. 응답이 없을 때만 legacy CAM2로 fallback하고 그 뒤 raw 모드 0/1/2를 보낸다. 수신 실제 크기로 해상도를 확인한다.
- USB2 협상 후에는 framed 명령만 사용한다. 매초 ping, 3초 heartbeat 감시, 정확한 epoch와 event_id 중복 제거, 연결 종료/재연결 generation 무효화를 적용한다. 잘못된 epoch/세션 fault는 fail-closed이며 새 chooser/hello가 필요하다. 협상된 세션 오류를 legacy 버튼 동작으로 바꾸지 않는다.
- 독립 USB2 short/long 이벤트는 JPEG가 없어도 처리한다. long은 펌웨어가 누르는 중 한 번 내보내며 release로 short를 합성하지 않는다. USB2에서는 CAM2 버튼 flags를 무시하므로 같은 동작이 두 번 실행되지 않는다.
- legacy는 유효한 프레임 눌림/해제 쌍과 결과 메타데이터만 사용한다. 전송에서 사라진 버튼 edge는 복원하지 않는다. USB2의 신뢰도나 held-long 동작을 legacy에 있다고 주장하지 않는다.
- USB2 해상도 완료에는 request_id/mode에 맞는 성공 ACK와 실제 수신 크기가 모두 필요하다. hello 이전 마지막 프레임이 새 세션의 중복 모드 명령을 만들지 않도록 controller가 connected 시 세션을 확정한다.
- short는 현재 기능 촬영/실행, long은 보행 → 글씨 → 물체 순환이다. 모드 전환·동의 철회·분리·백그라운드에서 촬영/늦은 결과를 무효화한다. 실제 해상도·최신 프레임이 준비되지 않으면 성공 촬영을 합성하지 않는다.

이전 b91f5bf 계열 v2 mirror 설치 보드는 영상만 보이고 USB RX/독립 버튼이 없을 수 있다. 앱의 자동 감지가 보드 기능을 추가하지 않는다. 신뢰 가능한 CDC2 제어는 새 S3 펌웨어가 필요하다. CAM 소스에 BTN2가 있어도 설치된 CAM 이미지와 실제 하드웨어 동작은 별도 확인 대상이다. 이 작업에서는 플래시하지 않았다.

## 오래된 사이트 캐시 / 업데이트

서비스 워커는 정적 빌드 파일만 캐시한다. `/api`, 사진·텍스트·음성·동의는 캐시/영구 저장하지 않는다. 새 worker는 기존 페이지가 있으면 waiting 상태로 대기하며 `skipWaiting`, 강제 controller 전환, 자동 reload를 하지 않는다. 촬영 중 업데이트로 앞면 사진을 잃게 하지 않는다.

옛 WSS/키 입력 화면이 보이면 먼저 현재 촬영을 완료하거나 취소하고 USB 세션을 종료한다. 그 뒤 같은 사이트의 모든 탭/PWA 창을 닫고 다시 연다. 기존 root 캐시를 우회하려면 `https://vt.ssammwu.info/?cdc=BQito510`처럼 새 query로 연다. query 요청은 기존 static-only worker 캐시 대상이 아니다. 이미 진행 중인 촬영 화면을 강제로 reload하거나 앱이 저장하지 않은 앞면을 보존한다고 기대해서는 안 된다. 마지막 검증 빌드의 앱 asset은 `index-BQito510.js`다. 실제 도메인 readback은 parent가 freeze 이후 수행한다.

## 변경 범위

- `mobile/src/main.tsx`, `core/controller.ts`, `core/openai.ts`: CDC/익명 API 전용. WSS `core/source.ts` 및 기존 envelope parser 삭제, Frame/WalkingScheduler와 mode/cancel 경로 유지.
- `core/usb-source.ts`, `core/usb-wire.ts`: bounded CAM2/USB2 multiplex parser, 자동 legacy 협상, 독립 이벤트·lease·해상도 검증.
- `mobile/vite.config.ts`, `mobile/index.html`: `connect-src 'self'`만 허용. OpenAI/WSS CSP 허용 제거. `.vt.ssammwu.info` allowedHosts와 same-origin 개발 proxy는 유지했다.
- `mobile/tests/**`: WSS/BYOK/readonly 전용 stale tests 제거, 보행 fixture를 transport-independent Frame으로 이관. 익명 전송·CDC2·legacy·회귀·실제 Node 통합·서비스 워커 테스트 추가/이관.
- backend/펌웨어 파일은 해당 peer 소유이며 이 프런트 작업에서 수정하지 않았다. 기존 모듈·보행 피드백 동작과 다른 작업자의 변경을 보존했다.

## 실제 실행 증거

아래 명령은 `mobile/`에서 직렬 실행했다. 추가 Vite dev 인스턴스나 운영 서버 kill/restart는 없었다. 테스트 전용 임의 포트 Node 인스턴스만 finally에서 닫았다.

- TDD RED→GREEN: credential UI/CSP 정책, CDC-only controller, USB2 parser/협상/이벤트/lease, 익명 전송, readiness 운영자 오류, health loading의 허위 오류 표시, pre-hello 프레임의 중복 모드 명령을 실제 실행으로 확인했다.
- `npm run format && npm run format:check`: PASS.
- `npm test`: 18 files / 105 tests PASS.
- `npm run build`: TypeScript + Vite production build PASS; 위 `index-BQito510.js` 생성. 운영 중 Node는 dist를 제공하므로 빌드는 live 정적 artifact를 갱신하지만 프로세스 재시작/배포 작업은 하지 않았다.
- `npm run test:server`: frozen peer backend 25/25 PASS.
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome npm run test:e2e`: 14/14 PASS, 24.5s.
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome npm run test:e2e -- tests/e2e/cdc-events.spec.ts tests/e2e/cdc-integration.spec.ts --repeat-each=3`: 15/15 PASS, 53.2s.
- `git diff --check`: PASS.

실제 Node 통합은 실제 dist/UI/OpenAITransport → same-origin HTTP API → backend → injected mock upstream만 사용한다. API/health route interception 없이 legacy·CDC2의 모의 물리 short/long으로 OCR 및 앞뒷면 인식, TTS MP3 전체 Blob 바이트/실제 HTMLAudio ended, 정확한 Origin/Authorization 없음/동의 전 upstream 0/철회 후 추가 전송 없음/지속 WASM 보행을 검증했다. 일반 인증 서버에서도 키 입력 대신 운영자 오류와 upstream 0을 검증했다.

서비스 워커 업데이트 테스트는 live dist를 수정하지 않고 `mobile/tests/` 아래 임시 복사본을 만들어 실제 Node에서 제공하고 정리했다. unsaved 앞면 촬영 중 새 worker가 waiting인 상태에서 caption·페이지 marker 유지 및 controllerchange 0을 확인했다. 초기 브라우저 실패는 재연결 시 모의 USB가 닫힌 read를 취소하지 않던 fixture를 수정하고, stale epoch에 대한 계약상의 세션 fault/reconnect를 명시적으로 검증해 해결했다. 회귀 assertion을 삭제해 통과시키지 않았다.

실제 유료 API·실제 키·비밀 파일·실기기 Android USB/처리량·설치 보드 물리 버튼·펌웨어 flash·commit/push는 미실행이다. 펌웨어 소스/build 및 sanitized host-suite 증거는 firmware peer/parent의 별도 보고 범위다. 프런트 최종 회귀와 이 문서를 완료하고 freeze한다.
