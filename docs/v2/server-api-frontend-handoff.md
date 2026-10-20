# Server API frontend handoff

## 범위와 결과

- 작업 위치: /home/minwoo/.superset/projects/videx, 실제 미커밋 main v2.
- 기존 CAM/proxy/Android CDC/보행 피드백 변경은 수정하지 않았다. backend peer 소유 mobile/server/**도 수정하지 않았다.
- OpenAITransport와 AppController는 기본 server 모드. same-origin POST /api/vision에는 {image,kind}, /api/speech에는 {text}만 보낸다. 기본 인증은 Authorization Bearer 서버 접근 토큰이다. 명시적 서버 데모 확인 시에만 토큰 없이 사용한다 (아래 demo-frontend 참고). 서버로 클라이언트 모델/프롬프트/endpoint를 보내지 않는다.
- 이미지/텍스트 개별 동의가 없으면 요청하지 않는다. 일반 인증 모드는 메모리 자격증명도 요구한다. 취소 signal 전달, 시작 전/응답 후 abort 확인, 서버 실패 시 직접 OpenAI fallback 없음. 잘못된 JSON 및 HTTP 오류 본문은 UI에 노출하지 않는다. 서버 음성 응답은 audio/mpeg만 수용한다.
- UI는 자체 서버 기본 / 고급 direct BYOK를 구별하고 서버 토큰과 OpenAI 키가 다름을 설명한다. 적용 시 입력 폼 초기화, 연결 종료/동의 철회/백그라운드 시 기존 세션 삭제 경로 유지. 모드 전환 시 연결 종료 및 자격증명 입력 교체.
- 개인정보 문구는 선택한 사진/텍스트만 자체 서버를 거쳐 OpenAI 전송, 연속 영상 전송 없음, BYOK는 직접 전송임을 명시한다.
- Vite dev 및 preview /api 프록시: http://127.0.0.1:8787. .vt.ssammwu.info allowedHosts 유지. CSP는 기존 self + 정확한 OpenAI/장치 origin 유지; Cloudflare analytics 허용 추가 없음. index.html 변경 불필요.
- npm run server = node server/index.mjs, npm run test:server = node --test server/*.test.mjs 추가. backend 파일/환경변수 구현은 peer 담당이다.

## 변경 파일

- mobile/src/core/openai.ts
- mobile/src/core/controller.ts
- mobile/src/main.tsx
- mobile/tests/openai.test.ts (기존 직접 BYOK 테스트에 direct 명시)
- mobile/tests/server-transport.test.ts (신규 6개 단위 테스트)
- mobile/tests/e2e/consent.spec.ts (same-origin 모의 서버로 이전)
- mobile/tests/e2e/flow.spec.ts (same-origin payload/auth 엄격 검증으로 이전)
- mobile/tests/e2e/privacy.spec.ts (기존 실제 HTMLAudio 모의 파형 테스트는 direct 명시)
- mobile/tests/e2e/server-auth.spec.ts (신규 기본 모드/메모리/auth/실패 테스트)
- mobile/tests/e2e/server-integration.spec.ts (실제 Node/static/API 교차 경계 통합 테스트)
- mobile/package.json
- mobile/vite.config.ts
- 이 인계 문서

## 실제 실행과 결과

아래 npm 명령은 /home/minwoo/.superset/projects/videx/mobile에서 실행했다.

1. npm test -- tests/server-transport.test.ts
   RED: 기본 same-origin 계약 테스트가 기존 direct 응답 파싱에서 실패했다.
2. npm test -- tests/server-transport.test.ts tests/openai.test.ts
   GREEN: 최초 서버 계약 + 명시적 direct 테스트 3개 통과.
3. PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome npm run test:e2e -- tests/e2e/consent.spec.ts
   RED: 서버 접근 토큰 UI가 없어 실패했다. UI/Controller 구현 후 전체 suite에서 통과했다.
4. npm test -- tests/server-transport.test.ts
   RED: HTML 응답을 음성으로 수용하여 실패. audio/mpeg 검증 추가 후 통과.
5. npm test -- tests/server-transport.test.ts
   RED: 잘못된 JSON의 본문 일부가 파싱 오류 메시지에 노출되어 실패. 안전한 오류 및 null 검증 후 통과.
6. npm run format && npm run format:check
   PASS. 포맷 명령이 열거한 비수정 기존 파일은 unchanged였다.
7. npm test
   PASS: 18 files, 57 tests (기존 51 + 신규 6).
8. npm run build
   PASS: tsc --noEmit 및 Vite production build. mobile/dist 생성, 배포하지 않음.
9. PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome npm run test:e2e
   최종 PASS: 8/8, 26.3s (기존 7 + 신규 auth 1). 실제 browser HTMLAudio, WASM worker, offline 정적 캐시, consent/늦은 결과, OCR/앞뒷면 payload, USB parsing/unplug/선택 제스처 모두 포함.
   중간 실패는 새 AI 설정 라벨이 기존 USB 연결 방식 locator와 충돌한 문제를 라벨 분리로 수정했다. 신규 auth 테스트의 상태 검증은 기존 FeedbackManager의 정확한 안전 오류 문구로 바로잡았다. 기존 USB 테스트의 assertion은 변경하지 않았다.
10. npm run format:check && git diff --check
    최종 PASS.

## 미실행/인계

- 실제 Node/static/API 통합 검증과 npm run test:server는 아래 후속 검증에서 완료했다. Vite 프록시 실제 통신은 이 frontend 작업에서 미실행이다.
- 실제 OpenAI 유료 호출, 실기기 USB/Android/iOS 검증, 운영 배포는 미실행.
- .env/비밀 파일 열람 없음. 실제 키 출력/테스트 없음. 커밋/푸시/플래시/배포 없음. 운영 서버 kill/restart 없음. 추가 Vite dev 서버 없음; 고정 포트 브라우저 검증은 기존 Playwright production preview 러너만 직렬 실행했다.
- backend peer는 /api/vision {text:string}, /api/speech audio/mpeg 및 안전한 JSON 오류 계약을 유지해야 한다. 기본 서버 모드 사용 시 UI에는 OpenAI 키가 아닌 VIDEX_ACCESS_TOKEN을 입력한다. 서버 환경 검증/health/고정 provider 모델과 prompts/production static 제공 책임은 backend에 있다.

## 실제 교차 경계 통합 E2E 후속 완료 / freeze

- server-integration.spec.ts는 peer의 createVidexServer를 server/server.mjs에서 직접 import하고 실제 built dist를 Node에서 제공한다. 브라우저 실제 UI/Controller/OpenAITransport → 같은 origin HTTP /api → backend → 주입된 mock fetcher → 실제 OCR 결과/MP3 Blob/HTMLAudio ended를 검증했다. page.route 또는 API 요청/응답 intercept는 전혀 사용하지 않는다. 시뮬레이션 경계는 USB 하드웨어 및 backend upstream fetcher뿐이다. Audio/Blob 계측은 실제 동작에 위임하며 바이트와 MPEG ended를 관찰만 한다.
- backend 설정은 생성 시 snapshot이므로 OS 임의 포트를 먼저 확보/해제하고 그 origin으로 factory를 구성한 뒤 해당 임의 포트에 bind한다. 재바인드 경쟁 시 EADDRINUSE만 최대 5회 새 임의 포트로 재시도한다. 전용 서버는 finally에서만 종료한다. backend 환경은 전부 테스트용 synthetic 값으로 명시하고 process.env/실제 비밀을 읽지 않는다.
- 잘못된 접근 토큰은 실제 backend 401이고 upstream 호출은 0이다. 정상 브라우저 POST는 접근 토큰만, upstream은 서로 다른 synthetic provider key만 받는다. 브라우저에는 provider key를 입력하지 않는다. 요청 payload 키, JPEG, 서버 고정 모델/store:false, OCR 결과와 해당 결과 텍스트의 TTS, audio/mpeg 및 실제 클라이언트 Blob의 MP3 전체 바이트, MPEG 재생 ended, 영구 저장 없음까지 검증한다.
- Origin 위험: backend request listener에서 실제 POST Origin을 관찰해 모두 임의 포트의 정확한 origin임을 검증한다. null Origin을 허용하도록 backend를 변경하지 않았다. 현재 Chrome에서 변경 전에도 정상 API까지 도달했으나, 명시적 정책 회귀 방지를 위해 서버 referrerPolicy=same-origin 단위 assertion을 먼저 RED로 확인한 후 클라이언트 한 줄을 수정했다. direct BYOK는 no-referrer 유지 assertion을 추가했다.
- 초기 통합 테스트 실패는 짧은 기본 timeout 및 CDP response.body()에서 빈 바이트 관찰로 발생했다. 결과 텍스트의 TTS 요청을 정확히 선택하고 실제 클라이언트 소비 Blob 바이트와 MPEG ended를 검증하도록 정리했다. 무음 MP3 fixture는 로컬 ffmpeg에서 생성한 유효한 짧은 MPEG이며 유료 API 응답이 아니다.
- 최종 실행 명령 (cwd=mobile):
  - npm test -- tests/server-transport.test.ts : 정책 변경 전 RED (expected same-origin, received no-referrer).
  - npm test -- tests/server-transport.test.ts tests/openai.test.ts : 변경 후 8/8 PASS.
  - npm run format && npm run format:check : PASS.
  - npm test : 18 files / 57 tests PASS.
  - npm run build : TypeScript + production Vite build PASS.
  - PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome npm run test:e2e : 전체 9/9 PASS, 12.0s.
  - PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome npm run test:e2e -- tests/e2e/server-integration.spec.ts --repeat-each=3 : 임의 포트 통합 반복 3/3 PASS, 10.0s.
  - git diff --check : PASS.
- 기존 Playwright runner가 관리하는 preview는 직렬 실행했으며, 통합 테스트의 실제 페이지/API는 preview나 Vite proxy가 아닌 별도 임의 포트 Node에서만 처리했다. backend 파일, 운영 서버, 실제 키, peer 변경은 수정하지 않았다. 완료 후 프런트 구현/테스트는 freeze한다.

## demo-frontend 완료 / freeze (최신 검증)

- 앱 최초 로드 및 설정 열기에서 same-origin GET /api/health를 cache:no-store로 조회한다. pending/통신 실패/비정상 HTTP/잘못된 JSON·MIME·스키마/구형 health는 인증 필수로 유지한다. 서버가 올바른 {ready:boolean,authRequired:false}를 명시한 경우만 데모를 허용한다. ready는 준비 상태, authRequired는 인증 정책으로 별개이며, 준비되지 않은 명시적 데모에서도 토큰을 요구하지 않고 실제 API의 안전한 503을 처리한다. 늦은 이전 health 결과나 취소된 조회는 정책을 덮어쓰지 않는다.
- 확인된 데모에서는 서버 토큰 필드를 숨기고 비용/자체 서버 전송 문구를 표시한다. 이미지·음성 동의는 여전히 별개이며 없으면 전송하지 않는다. 서버 모드 데모 요청에는 Authorization 헤더 자체가 없다. direct BYOK는 여전히 별도 키/동의 및 no-referrer 정책을 사용한다. 일반 인증 모드의 Bearer 동작도 유지한다.
- USB submit 경로에는 health await를 추가하지 않았다. pending health 중에도 chooser가 클릭 활성화 내에서 호출됨을 검증했다. 촬영 화면으로 돌아갈 때 불필요한 재조회로 직전 데모 확인을 무효화하지 않는다. 페이지 로드/설정 열기만으로는 provider 요청이 발생하지 않는다.
- 실제 Node 통합 E2E를 일반 인증/데모 두 경우로 실행한다. 데모 서버 env에는 VIDEX_DEMO_MODE='true'만 추가하고 VIDEX_ACCESS_TOKEN 속성을 아예 넣지 않는다. 실제 dist/UI → same-origin /api → peer backend → injected mock upstream만 사용한다. /api 및 health intercept 없음. 토큰 필드 없음, 동의 전 POST/upstream 0, Authorization 없음, 정확한 Origin, 실제 OCR 결과 및 TTS MP3 Blob 바이트/재생 ended, USB 사용자 제스처를 검증한다. 기존 일반 인증 401/접근키 분리 검증도 유지한다.
- 이번 변경 파일: mobile/src/core/openai.ts, mobile/src/main.tsx, mobile/tests/demo-transport.test.ts (신규 6개), mobile/tests/e2e/demo-ui.spec.ts (신규 2개), mobile/tests/e2e/server-integration.spec.ts (데모 case 추가). 기존 consent/flow/privacy/server-auth/usb e2e에는 명시적 auth-required health fixture만 추가했다. 기존 회귀 assertion은 약화하지 않았다. backend 파일/manifest/운영 서버는 수정하지 않았다.
- TDD 실제 RED: refreshHealth 부재, 실제 데모에서 토큰 필드 잔존, 설정 닫기 시 불필요한 세 번째 health 조회, JSON이 아닌 MIME 수용, readiness와 인증 정책 혼동, 데모 동의 오류에 토큰 안내 잔존을 각각 실행해 확인한 후 구현/수정했다.
- 최종 명령/실제 결과 (cwd=/home/minwoo/.superset/projects/videx/mobile):
  - npm run format && npm run format:check : PASS.
  - npm test : 19 files, 63/63 PASS (기존 57 + demo 단위 6).
  - npm run build : tsc --noEmit + Vite production build PASS.
  - npm run test:server : peer backend 25/25 PASS (파일 수정 없음, random-port 합성 검증).
  - PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome npm run test:e2e : 12/12 PASS, 18.9s (기존 9 + demo UI 2 + 실제 demo integration 1).
  - PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome npm run test:e2e -- tests/e2e/server-integration.spec.ts --grep 'tokenless demo' --repeat-each=3 : 3/3 PASS, 10.6s.
  - git diff --check : PASS.
- 실제 paid API/실제 키/비밀 파일/실기기/운영 배포 미사용. commit/push/flash/deploy 및 live 서버 재시작 없음. 기존 preview runner만 직렬 실행했고 Vite dev 인스턴스를 추가하지 않았다. demo-frontend 완료 후 freeze.
