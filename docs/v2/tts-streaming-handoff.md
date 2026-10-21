SUPERSET_WORKER_DONE task:TTS-STREAM

DONE · bounded TTS byte relay와 브라우저 progressive MP3 재생 구현/실행 검증 완료.
작업 트리: /home/minwoo/.superset/worktrees/videx/feat/tts-streaming
브랜치/기준: feat/tts-streaming / 8a9528a26ad91431a84aa6e035d2798d72c28c6d

결과
  서버 전체 MP3 buffering을 제거하고 최대 10MB, 64KiB writable 조각, drain backpressure로 relay한다. 기존 12초 TTS deadline 및 5초 blocked delivery wait, quota/concurrency/auth/origin/no-store를 유지한다. 헤더 이후 오류는 stream destroy이며 JSON을 붙이지 않는다.
  브라우저는 feature-detected audio/mpeg MediaSource로 조기 재생한다. 미지원/재생 전 MSE 오류에는 동일 요청의 bounded 원본 Blob만 사용한다. 네트워크 실패/재생 후 오류/취소는 유료 재요청하지 않는다. local default/consent 및 gpt-4o-mini-tts/coral/mp3를 유지한다.
  취소/우선순위 선점/철회의 signal, reader, listener, URL, Audio source, timer 정리와 stale ended/finally 경쟁을 검증했다. 취소 후 진단 음성 상태도 음성 대기로 복구한다.

Worker 원 실행 검증 (아래 로그는 docs/v2/tts-streaming-logs/ 기준)
  npm ci: exit 0 · npm-ci.log
  npm run build: exit 0 · build-final.log
  npm test: exit 0 · 25 files / 164 tests · units-final.log
  npm run test:server: exit 0 · 40 tests · server-final.log
  PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome npm run test:e2e -- --config playwright.tts.config.ts
    exit 0 · 25 tests · playwright-final.log
  변경 소유 TS/runner Prettier: exit 0 · format-owned-final.log
  git diff --check: exit 0
  전체 npm run format:check: exit 1 · format-check-final.log
    이번에 수정하지 않은 기존 5개 파일 경고: src/core/usb-source.ts, src/core/usb-wire.ts, tests/button-diagnostics.test.ts, tests/legacy-compat.test.ts, tests/usb-source.test.ts. 범위 밖 수정하지 않음.
  각 기능의 실제 RED/GREEN raw output은 *-red.log / *-green.log에 저장했다. 특히 upstream EOF 전 바이트/재생, same-request fallback, cancel/revoke/ended 경쟁, 기존 5초 slow delivery 제한을 각각 RED→GREEN으로 검증했다. 상세 매트릭스는 계약 문서 참조.

Coordinator frozen union 독립 검증 완료
  npm test: exit 0 · 25 files / 164 tests · coordinator-units.log
  npm run test:server: exit 0 · 40 tests · coordinator-server.log
  npm run build: exit 0 · coordinator-build.log
  PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome npm run test:e2e -- --config playwright.tts.config.ts
    exit 0 · 25 passed (59.2s) · coordinator-playwright.log
  위 raw 로그와 최신 측정 JSON의 일치를 확인했다. 이번 갱신은 문서 두 개만 수정하며 테스트/빌드 재실행이나 source 변경은 하지 않았다.

실제 Chrome 결과 · Worker 원 실행
  Chrome 155.0.8059.84, 실제 빌드 앱 + 실제 Node relay + 유효한 ffmpeg MP3 32,435 bytes. 공급자 대체 stream은 4096 bytes / 250ms pace. Audio/MediaSource 디코더 mock 없음.
  Progressive: native playing 260ms, currentTime 증가 시작 508ms, upstream EOF 2252ms. EOF 이전 실제 currentTime 0.429212초 확인.
  Buffered baseline: native playing 2265ms, currentTime 증가 시작 2523ms, upstream EOF 2253ms. 각각 요청 1회.
  baseline은 같은 relay/MP3에서 MSE 지원 감지만 끈 완전 버퍼 재생이며, 과거 서버 소스 전체의 재실행은 아니다.
  실제 Chrome 동의 철회: native paused=true, src=null, object URL 전부 revoke, 동일 공급자 signal abort/body cancel, 호출 1회.
  원 실행 raw: playwright-final.log 및 변경하지 않은 source-freeze.json의 measurements. 보존된 worker 스크린샷: screenshots/ 하위.

실제 Chrome 결과 · Coordinator 최신 실행
  Progressive: native playing 262ms, currentTime 증가 시작 512ms, upstream EOF 2254ms. EOF 이전 실제 currentTime 0.43751초 확인.
  Buffered baseline: native playing 2265ms, currentTime 증가 시작 2519ms, upstream EOF 2251ms, 폴링 currentTime 0.548059초. 각각 요청 1회.
  실제 철회 케이스도 upstream cancel/abort, native paused=true/src=null, object URL 전부 revoke 및 호출 1회를 통과했다.
  최신 raw: coordinator-playwright.log. chrome-measurements.json은 coordinator 재실행이 덮어쓴 최신 측정이며 해당 로그와 일치한다. Worker 원 수치나 동결 manifest의 measurements를 이 최신 수치로 덮어쓰지 않는다.

산출물
  계약/명령/검증/제한: docs/v2/tts-streaming.md
  이 인계: docs/v2/tts-streaming-handoff.md
  빌드: mobile/dist (이 격리 worktree 안에만 작성)
  최종 source/dist SHA-256: docs/v2/tts-streaming-logs/source-freeze.json
  원시 로그 및 캡처: docs/v2/tts-streaming-logs/

변경 소스/테스트/runner 18개
  mobile/server/server.mjs
  mobile/server/tts-streaming.test.mjs
  mobile/server/tts-delivery-timeout.test.mjs
  mobile/src/core/openai.ts
  mobile/src/core/feedback.ts
  mobile/src/core/progressive-speech.ts
  mobile/src/modules/builtins.ts (최초 지정 live 복사만; 인식 중간 안내 제거 보존)
  mobile/tests/recognition.test.ts (최초 지정 live 복사만)
  mobile/tests/tts-streaming.test.ts
  mobile/tests/progressive-speech.test.ts
  mobile/tests/feedback.test.ts
  mobile/tests/server-transport.test.ts
  mobile/tests/walking-feedback.test.ts
  mobile/tests/e2e/tts-streaming.spec.ts
  mobile/tests/e2e/tts-isolated-server.mjs
  mobile/tests/e2e/cdc-fixtures.ts (기존 Blob byte-identity 관찰기를 명시적 buffered 경로로 유지)
  mobile/tests/e2e/usb.spec.ts (고정 4173 가정 대신 runner baseURL의 정확한 origin 경계 사용)
  mobile/playwright.tts.config.ts (기존 Vite/8787 proxy를 쓰지 않는 격리 runner)

정리/미실행/남은 일
  최초 live 두 파일만 읽어 복사했고 다른 live dirty 파일/프록시/펌웨어는 복사·수정하지 않았다. npm ci는 이 worktree에서만 실행했다.
  격리 포트 14373 및 API ephemeral runner는 종료했다. cleanup.log에 확인 출력이 있다. tool 소유 TypeScript LSP만 남아 있고 테스트 runner가 아니므로 건드리지 않았다. 다른 runner/서비스에 terminal interrupt를 보내지 않았다.
  commit/push/merge/restart 및 production dist 작성 없음. 실제 유료 공급자 호출/secret 사용 없음.
  실제 Android 물리 USB/기기/스피커, 유료 공급자, 기타 브라우저의 실제 MSE, 외부 배포 proxy buffering은 미실행.
  Coordinator의 최종 frozen union 독립 검증은 완료됐다. 남은 일은 별도 승인 범위의 실기기/유료 공급자 검증이며, 구현 및 union 검증 대기 항목은 없다.

SOURCE FREEZE
  최종 동결 스냅샷: source-freeze.json generatedAt 2026-10-21T21:26:12.882769+00:00.
  이 최종 소스/테스트/runner 및 dist를 더 수정하지 않는다. Coordinator 독립 검증 완료 뒤에도 동일 manifest를 유지한다. 문서 조정 전후 source/dist 해시 일치와 manifest 불변을 확인하며, 이번 수정 대상은 docs/v2/tts-streaming.md와 이 인계 문서뿐이다. 하드웨어/유료 공급자 미실행 표시는 유지한다.
