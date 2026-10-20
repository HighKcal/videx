# VIDEX mobile v2 운영·구현 안내

## 실행과 배포

작업 루트: `/home/minwoo/.superset/projects/videx/mobile`.

- Node.js 22.12 이상 권장. 이 작업은 Node 26.10.0 / npm 11.19.1에서 실행했다.
- `npm ci`, `npm run dev`: 로컬 개발. 실제 휴대폰에서는 HTTPS 배포가 필요하다.
- `npm run build`: TypeScript strict 검사와 정적 `dist/` 생성.
- `npm run preview`: 로컬 프로덕션 확인. 실제 운영 서버가 아니다.
- `npm test`, `npm run test:e2e`, `npm run format:check`.
- `npm run format`은 CORE 소유 파일만 포맷한다. UI/vision 담당 파일은 변경하지 않는다.

`deployment.config.json`의 `deviceHost`는 비밀이 아닌 공개 배포 설정이다. 기본 `videx.local`은 연결을 보장하는 실제 프로비저닝이 아니다. 운영자가 실제 인증서의 정확한 호스트명(필요하면 포트)을 넣고 재빌드한다. 이 값으로 앱의 유일한 WSS URL `/ws`와 CSP의 정확한 WSS 허용 호스트를 동시에 생성한다. S3는 앱의 정확한 Origin을 별도로 허용해야 한다. 자체 서명 인증서/일반 mDNS 호스트의 공개 신뢰를 가정하지 않는다. 장치 연결 실패 시 공개 중계로 우회하지 않는다.

정적 호스팅 시 `dist/_headers`를 지원하는 배포처에서는 해당 보안 헤더를 적용한다. 다른 서버에서는 동일 CSP/Permissions-Policy/Referrer-Policy/X-Content-Type-Options를 HTTP 응답 헤더로 설정한다. HTML에도 CSP가 있지만 `frame-ancestors`는 HTTP 헤더에서만 유효하다. Vite preview는 E2E 검증을 위해 동일 CSP HTTP 헤더를 제공한다. script-src의 `wasm-unsafe-eval`만 WASM 컴파일용으로 허용하며 일반 `unsafe-eval`은 허용하지 않는다. 스타일의 `unsafe-inline`은 React CSS 변수용이다.

서비스 워커는 빌드의 해시된 JS/CSS/WASM과 index/manifest/icon만 설치 시 캐시한다. 임의 응답을 런타임 캐시에 추가하지 않는다. 정확한 same-origin GET 정적 경로만 처리하며 query/API POST/JPEG/OpenAI 요청은 제외한다. 정적 자산 lookup의 ignoreVary는 공개 불변 빌드 자산에만 적용한다. 설치 때와 모듈 fetch의 Origin/Vary 차이로 오프라인 JS가 누락되는 문제를 프로덕션 E2E로 재현 후 수정했다.

## 실제 사용 순서

1. 메인 VIDEX 로고 → 진단/설정. 유효 TLS의 페어링된 S3와 같은 로컬 네트워크에 연결한다.
2. 장치 토큰과 본인 소유 OpenAI 세션 키를 입력한다. 사진/음성 전송 동의는 별개이며 기본 비활성이다. OpenAI 없이도 로컬 보행 분석은 가능하다.
3. 설정 적용으로 WSS 인증을 시작한다. 물리 버튼의 긴 누름 또는 진단의 모듈 선택으로 기능을 바꾼다. 해상도 변경은 request_id 및 실제 width/height ACK를 확인한다.
4. 글씨 모드에서 최신 1280×1024 프레임이 도착한 뒤 짧게 눌러 1장을 선택한다. 물체 모드는 앞면과 뒷면을 각각 짧게 눌러 선택하며 서로 동일한 이미지는 거부한다. 품질 실패는 재촬영 안내한다. 병합은 휴대폰 Canvas에서 수행한다.
5. 동의한 선택 JPEG만 OpenAI Responses에 직접 보낸다. 결과/경고 텍스트만 OpenAI TTS에 보낸다. 물리 버튼은 브라우저 사용자 제스처가 아니므로 iOS 등에서는 먼저 화면의 ‘음성 재생 활성화’를 누른다. 재생 실패를 성공으로 표시하지 않는다.
6. LEFT 카메라 기본 회전은 cw90이다. 진단에서 none/cw90/ccw90/180을 선택할 수 있으며 보행/선택 이미지 모두 같은 변환을 사용한다. 변경하면 진행 촬영을 취소한다.
7. 동의 철회/연결 종료/백그라운드 진입은 촬영과 TTS를 취소하고 API 키·토큰 참조·선택 이미지 세션을 버린다. 복귀 시 다시 페어링한다. 화면 잠금 중 감지를 보장하지 않는다.

## 코어와 모듈 경계

- `src/core/wire.ts`: 정확한 VDX2/CAM2 길이·카메라·해상도·JPEG 경계 검증, 별도 원격 시각 보존. 서로 다른 장치 시계를 빼지 않는다.
- `source.ts`: exact WSS/auth, 인증 전 frame 차단, epoch/serial 순서와 event_id 중복 제거, 최신 1프레임 버퍼, 32개 신뢰 제어 큐의 과부하 fail-closed, 4개 해상도 요청 상한과 6초 ACK timeout, 2초 stale/10초 무응답, 제한된 지수 재접속.
- `modules.ts`: manifest 검증, init/activate/deactivate/dispose, 활성 모듈 onFrame/onShort/cancel hooks. continuous 모듈은 다른 기능 선택 중에도 활성이다.
- `src/modules/builtins.ts`: 실제 보행/인식 어댑터. OCR/object 촬영 세션과 API 호출은 이 모듈 안에 있으며 controller에는 해당 기능 ID 분기가 없다.
- 새 검토 모듈은 `VidexModule`과 `ModuleHost`로 구현하고 composition root에서 `new AppController(host => [...builtInModules(host), new ReviewedModule(host)])`처럼 등록한다. source/controller/common VidexScreen/다른 모듈 내부 수정 없이 동적 진단 목록·색상·해상도·생명주기·버튼/frame routing을 재사용한다. controller.test.ts가 임의 ID extension의 실제 hooks 실행을 검증한다. 네트워크 권한 manifest가 JavaScript 보안 샌드박스라는 주장은 하지 않는다. 동적 외부 코드 로딩은 없다.
- `scheduler.ts`/`walking.worker.ts`: 항상 보행에 최신 프레임 제공, Worker에서 JPEG 디코드/회전/축소/비전 분석. initializeVision을 기다리고 실제 runtime wasm/javascript를 진단에 표시한다. 오래된 세대의 ready/result를 무시하고 처리 지연/Worker 오류는 UNKNOWN이다.
- `feedback.ts`: 장애물 > 고장 > 인식 > 일반 안내. 높은 우선순위 선점·취소, bounded 대기 큐와 만료 필터. 네트워크 timeout 15초, 메타데이터 미확보 재생 watchdog 60초. loadedmetadata/durationchange 뒤 실제 남은 길이+15초 여유로 연장하되 재생 시작부터 유한 상한 15분. 120초 정상 음성을 60초에서 중단하지 않는 테스트가 있다. 텍스트는 4000자까지 전달하며 이 한계 이상은 잘린다. 기기 대체는 명시 동의한 경우 localService=true인 한국어 음성만 선택한다. 음성 실패/중단/종료에 audio src 해제 및 Blob URL revoke를 수행한다.

## OpenAI 인증의 실제 한계와 출시 게이트

### Current guidance: server-default mode (supersedes the historical direct-only snapshot below)

The current default AI mode sends only a user-selected still image for OCR/object recognition, and separately consented recognition/screen text for speech, through the operator's own backend to OpenAI. It does not send continuous frames or walking-analysis data; USB and continuous walking analysis remain local. TTS receives text only, never the image. The browser's `VIDEX_ACCESS_TOKEN` authenticates to the VIDEX backend and is not an OpenAI API key; `OPENAI_API_KEY` stays server-side. A single personal/shared bearer token is not full public multi-user authentication. Keep the service in a trusted deployment boundary unless a reviewed user identity/authorization and abuse-control design is added. See backend-owned [`server-api.md`](server-api.md) for configuration, exact allowed-origin policy, API contract, and operations.

Direct OpenAI BYOK remains an explicit advanced option: it sends selected photo/text directly to OpenAI after separate consent, with the existing browser-key exposure limitations below. No automatic direct fallback occurs when the backend fails.

### Historical direct-only implementation snapshot (superseded for current default mode)

공식 문서 확인:
- https://platform.openai.com/docs/api-reference/authentication
- https://developers.openai.com/api/reference/overview.md
- https://developers.openai.com/api/reference/resources/realtime/subresources/client_secrets/methods/create
- https://developers.openai.com/api/docs/guides/text-to-speech
- https://developers.openai.com/api/docs/guides/images-vision

공식 일반 인증 안내는 비밀 API 키를 브라우저/앱 코드에 노출하지 말고 서버의 환경/키 관리에 둘 것을 권장한다. Realtime client secret은 Realtime API 접근용이며 임의 Responses 또는 `/audio/speech`용 범용 임시 키가 아니다. 공식 문서에는 workload identity federation 접근 토큰도 있으나, 본 앱을 위한 승인된 브라우저 사용자 인증/토큰 발급 체계를 구성·검증한 것은 아니다.

이 문단은 당시 직접 BYOK 구현의 이력이다. 현재 기본 모드는 위의 server-default 안내를 따른다. 직접 모드를 선택하면 세션 키는 탭 내 실행 코드/브라우저 확장/XSS에 대해 강한 보안 격리된 비밀이 아니며, 신뢰된 개인 앱/제한된 프로젝트 키만 사용하고 종료 후 폐기해야 한다. JavaScript 문자열의 물리 메모리 zeroization도 보장하지 않는다. 서버 bearer token도 그 자체로 공개 다중 사용자 인증 체계가 되지 않는다.

Historical direct transport: Responses used the fixed `https://api.openai.com/v1/responses`, gpt-4.1-mini, store:false, selected JPEG data URL; TTS used fixed `/v1/audio/speech`, gpt-4o-mini-tts/coral, text only. Current server-mode upstream contract and deployment instructions are maintained in [`server-api.md`](server-api.md). `store:false` is not a guarantee of no OpenAI retention/ZDR. Actual paid API behavior, account permissions and voice quality remain unverified.

## 브라우저 테스트 러너

기본은 Playwright가 설치한 Chromium이다: `npx playwright install chromium` 후 `npm run test:e2e`.
이미 설치된 Chrome을 쓰려면 운영자가 실제 실행 파일을 확인하고 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/실제/경로/chrome npm run test:e2e`로 명시한다. 자동으로 /opt 경로를 가정하지 않는다. 이 환경에서는 `/opt/google/chrome/chrome`를 확인해 해당 override를 사용했다. config의 chromiumSandbox:true를 유지하며 --no-sandbox 옵션은 사용하지 않는다. 샌드박스를 사용할 수 없는 호스트는 격리를 끄지 말고 호스트 권한/컨테이너 런타임을 수정한다.

E2E는 매번 production build 후 127.0.0.1:4173 preview를 소유한다. 다른 담당자는 같은 포트에서 별도 서버를 띄우지 않는다. 외부 paid API는 Playwright route로만 대체한다. 모의 S3/WSS를 쓰므로 하드웨어 TLS/인증서/로컬 네트워크 권한을 검증한 것은 아니다.
