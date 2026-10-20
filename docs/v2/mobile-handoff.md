# CORE 최종 handoff / freeze

범위: mobile/의 core, modules, app wiring, dependencies, build/CSP/PWA, 테스트와 docs/v2/mobile*.md. UI/vision 소유 파일은 수정하지 않았고 VISION의 initializeVision/visionRuntimeStatus/WASM과 UI의 VidexScreen 계약을 통합했다. main 작업트리이며 commit/push/branch 변경 없음. 다른 담당자의 firmware/docs 변경을 보존했다.

구현: strict React/TS/Vite 앱, authenticated exact-host WSS VDX2/CAM2 parser와 frame/control 분리 큐, epoch/event dedupe, bounded ACK와 observed dimensions, reconnect/stale recovery, 실제 reviewed module hooks/lifecycle와 항상 활성 walking, async WASM Worker, explicit selected OCR/object front+back quality+local merge, 직접 OpenAI Responses 및 수정 지시된 OpenAI TTS, 취소/우선순위/metadata-aware 재생 watchdog, in-memory pairing/BYOK와 별도 동의·철회, cw90 기본 및 동일 회전 설정, 진단, static-only offline SW와 exact CSP.

최종 실제 실행 (mobile cwd):
- `npm test -- tests/feedback.test.ts`: exit 0, 4/4. 120초 음성의 60초 이후 유지/ended cleanup, 메타데이터 없는 hung fallback, 늦은 오디오/선점, 만료된 고우선 항목을 건너뛰고 live 항목 drain.
- `npm run format`: exit 0; UI/vision 제외.
- `npm run format:check`: exit 0.
- `npm test`: exit 0, 12 files / 31 tests. VISION 10건 포함. parser, source auth/stale/reconnect/epoch/event dedupe/control overflow/bad ACK, 임의 module hooks/lifecycle, controller ACK-generation race, late capture/vision cancellation, quality/front-back sessions, rotation, scheduler latest queue/generation/watchdog, OpenAI consent/payload, feedback를 포함한다.
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/opt/google/chrome/chrome npm run test:e2e`: exit 0, production 4/4. runner가 TypeScript strict + Vite production build를 먼저 수행한 뒤 preview를 시작한다. chromiumSandbox:true이며 --no-sandbox 없음.
- 별도 `npm run build`: exit 0. 마지막 E2E도 최종 feedback 변경 후 같은 build 명령을 재수행해 통과.
- `npm audit`: exit 0, vulnerabilities 0.
- `git check-ignore mobile/node_modules mobile/dist mobile/test-results`: 세 경로 모두 ignore 확인.
- `git diff --check`: exit 0 (공유 작업트리 tracked 변경 기준).

프로덕션 브라우저 증거:
1. mock S3 인증 → 물리 long/short → 선택 OCR → front/back 병합 object → 실제 fetch transport 요청 → 자막, 동시 walking Worker 처리와 diagnostics runtime=wasm 확인.
2. TTS 503은 사용 불가로 노출. 별도 성공 테스트는 메모리 WAV waveform 응답을 실제 HTMLAudio로 재생하여 ended 및 모든 생성 audio Blob URL revoke 확인. 자연 음질을 실 모델로 확인했다는 뜻은 아님.
3. 동의 전 image POST 0, 철회 후 POST 증가 0, 지연 vision 결과가 모드 전환/세션 종료 후 화면을 덮지 않음. unit도 delayed decode/vision cancel을 별도 검증.
4. production HTTP CSP의 exact wss allowlist 및 wasm-unsafe-eval 확인, 허용하지 않은 fetch/WebSocket이 CSP violation으로 차단됨. 실제 CacheStorage 키가 정적 index/icon/manifest/hashed JS/CSS/WASM만임을 확인. 임의 JPEG/결과/API 저장 제외. offline reload로 화면 재실행 통과.

출시/실기기 게이트 (완료로 포장하지 않음):
- 실제 ESP32/CAM/S3, 인증서 프로비저닝, Android/iOS local network 권한, AP+STA/핫스팟/셀룰러 병행, 사용자 제스처/iOS PWA autoplay, 화면 잠금/전력/실측 지연은 하드웨어 없어서 미실행.
- OpenAI 실제 유료 호출/음질/CORS/권한 미실행. 외부 호출은 테스트 mocks뿐.
- 일반 공개 서비스용 로그인/토큰 발급 체계는 미구현. Realtime ephemeral key가 Responses/TTS에 통용된다는 가정 없음. 제한된 신뢰 개인 BYOK memory-only 모드이며 공식 브라우저 키 노출 경고를 UI와 mobile.md에 공개했다. 운영 출시에는 별도 승인된 인증 경계가 필요하다.
- 4000자 텍스트 상한/최대 15분 재생 watchdog과 음성 메타데이터 실패 fallback 60초가 존재한다. 기기 로컬 음성 없으면 fallback을 하지 않는다.

Coordinator: CORE 소유 파일 freeze. 위 명령으로 독립 union 검증 가능. 배포/실기기/인증 운영 게이트는 별도 판단 필요. 상세 운영·확장 계약·공식 자료: docs/v2/mobile.md.
