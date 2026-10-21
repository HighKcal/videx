# TTS-STREAM 계약 및 검증

## 범위와 선택

작업 트리: `/home/minwoo/.superset/worktrees/videx/feat/tts-streaming`
브랜치: `feat/tts-streaming`
기준: `8a9528a26ad91431a84aa6e035d2798d72c28c6d`

지정된 live 파일 `mobile/src/modules/builtins.ts`, `mobile/tests/recognition.test.ts`만 최초에 읽고 복사했다. 인식 중간 안내 제거를 보존했다. 다른 live dirty 파일, 프록시, 펌웨어는 복사·수정하지 않았다. 상위 경로 및 작업 트리에 적용되는 AGENTS.md가 없음을 확인했고 TDD 지침을 적용했다.

서버는 TTS 전체 응답 버퍼를 제거하고 bounded byte relay를 사용한다. 브라우저는 기존 Audio 요소를 재사용하되 `MediaSource.isTypeSupported("audio/mpeg")`로 기능을 감지하고 순차 append한다. 별도 요청/새 오디오 포맷/프로바이더 SDK를 도입하지 않았다. 동일 요청 fallback을 위해 클라이언트에만 최대 10MB 원본 바이트를 보관한다. 이 bounded 복사 비용을 허용하는 대신 실패 시 추가 과금 요청을 확실히 피한다.

## HTTP 및 보안 계약

- 요청: 기존 동일 출처 `POST /api/speech`, JSON `{ "text": "..." }`만 허용한다. 비어 있지 않은 최대 4000자이며 모델/음성 등 추가 필드는 거절한다.
- 공급자 payload는 `gpt-4o-mini-tts` / `coral` / `response_format: mp3` 및 기존 한국어 instructions를 그대로 유지한다.
- 성공: `200`, `Content-Type: audio/mpeg`, `Cache-Control: no-store`. 전체 길이를 미리 알 수 없으므로 Content-Length를 생성하지 않는다. 첫 유효 바이트부터 전달하며 임의 청크 경계는 MP3 프레임 경계가 아니다.
- 공급자 status/redirect/MIME/body 및 advertised size를 검사한다. 첫 비어 있지 않은 청크 전 오류·빈 응답·초기 overflow는 기존 generic JSON 오류다. 오디오 헤더 전송 뒤 overflow/read failure/timeout은 연결을 destroy한다. JSON을 오디오 뒤에 붙이지 않는다.
- 최대 10,000,000 bytes. 한 번에 writable에 넣는 조각은 최대 65,536 bytes이며 write가 false이면 drain 전 다음 조각/다음 upstream read를 진행하지 않는다. 전체 MP3를 서버 배열/Buffer.concat으로 모으지 않는다. OS socket 및 upstream stream 자체의 작은 선행 버퍼는 존재한다.
- TTS 공급자 deadline은 기존 최대 12초이며 이제 실제 릴레이 완료까지 적용한다. blocked drain/finish에는 기존 5초 delivery wait bound도 유지한다. 더 낮은 테스트용 upstream limit도 적용된다. 전송을 무기한 기다리지 않는다.
- concurrency slot은 delivery finish/disconnect/failure 정리까지 유지한다. disconnect/timeout/overflow는 공급자 signal과 reader를 취소하고 슬롯을 해제한다. 헤더가 늦게 돌아오는 취소된 요청의 body도 정리한다.
- 기존 기본 bearer 인증, 정확한 Origin allowlist, 명시적 demo mode, 전역 quota/concurrency, upload/HTTP parser bounds, no-store, CSP 및 서버 전용 공급자 credential 경계는 유지한다. 브라우저는 credential을 받거나 전송하지 않는다.
- vision은 기존 bounded JSON 경로를 유지한다. 모델/프롬프트/파서 계약을 바꾸지 않았다.

## 브라우저 재생 및 fallback 계약

- 기본은 기존 기기 한국어 localService 음성이다. 사용자 speech consent 없는 원격 요청이나 자동 local→remote 전환은 없다. 명시적으로 허용한 기존 remote→local fallback만 유지한다.
- `OpenAITransport.speech(text, signal, consume?)`는 동일한 한 요청의 바이트를 bounded read하며 optional async consumer를 매 청크 await한다. 최종 반환값은 기존 `Blob(audio/mpeg)`로 호환된다. 잘못된 MIME/empty/read failure/overflow는 generic 오류이며 response body를 취소한다.
- MSE 지원 시 첫 append 완료 후 native Audio.play를 요청하고 다음 append를 updateend까지 기다린다. upstream EOF 뒤 endOfStream하고 native ended까지 기다린다.
- MSE 미지원/부재는 처음부터 동일 요청을 bounded buffering하여 Blob으로 재생한다. MSE setup/append/parser/source failure가 playing 이전이고 currentTime이 0이면 같은 요청을 끝까지 읽어 원본 전체 Blob으로 fallback한다.
- playing 관찰 또는 currentTime 증가 이후 MSE 오류는 재시작하지 않고 실패로 끝낸다. 네트워크 오류/timeout/overflow/사용자 취소/autoplay 거절도 재요청하거나 부분 음성을 성공 처리하지 않는다. 네트워크 오류를 MSE fallback과 혼동하지 않는다.
- fallback 과정에서 이전 play promise의 지연 rejection이 새 Blob 재생을 중단하지 않도록 generation을 확인한다.
- 생성/읽기/append watchdog 15초를 유지한다. 각 4000자 단위 재생은 기본 60초 watchdog, finite metadata의 남은 길이+15초, 최대 15분이다. 장문은 기존처럼 4000자 단위 요청을 순차 처리하며 fallback을 위한 중복 요청은 하지 않는다.
- 취소·우선순위 preemption·모드 변경·disconnect·동의 철회 시 reader/signal, 대기 append/sourceopen listener, timer, Audio source, object URL을 정리한다. 이전 작업의 지연 finally/ended는 후속 작업 Audio를 정리하지 않는다. 취소 시 진단 상태는 `음성 대기`로 돌아간다.

## 재현 명령

모든 명령은 이 worktree의 `mobile`에서 실행한다. 이 트리에서만 `npm ci`를 실행했다. 빌드는 이 트리의 `mobile/dist`만 작성한다.

```sh
npm ci
npm run build
npm test
npm run test:server
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome npm run test:e2e -- --config playwright.tts.config.ts
```

집중 실행:

```sh
node --test server/tts-streaming.test.mjs server/tts-delivery-timeout.test.mjs
npm test -- tests/tts-streaming.test.ts tests/progressive-speech.test.ts
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome npm run test:e2e -- --config playwright.tts.config.ts tests/e2e/tts-streaming.spec.ts
```

`playwright.tts.config.ts`는 기본 14373 포트의 격리된 static Node runner를 사용한다. 충돌 시 `VIDEX_TTS_E2E_PORT`로 다른 격리 포트를 지정할 수 있다. 기존 4173 runner를 재사용하지 않고 `reuseExistingServer: false`다. API fixture는 각각 ephemeral loopback port를 사용한다. 이 runner는 명시적 빈 env와 upstream 금지 fetcher로 실행하므로 Vite의 기존 8787 proxy나 실제 공급자에 접근하지 않는다. 실제 TTS fixture는 synthetic credential과 대체 fetcher만 사용한다. ambient secret은 읽지 않는다.

Node 26.10.0 / npm 11.19.1 / Chrome 155.0.8059.84 / ffmpeg n9.0.1 환경이다. 정확한 버전 출력은 `tts-streaming-logs/versions.log`에 있다.

## 수직 RED/GREEN 근거

각 항목은 실제 동작 부재로 실패한 raw RED를 저장한 뒤 최소 변경을 적용하고 GREEN을 실행했다. 관련 경계 검증을 추가하고 전체 회귀를 다시 실행했다. 경로는 `docs/v2/tts-streaming-logs/` 기준이다.

| 동작 | RED | GREEN |
| --- | --- | --- |
| upstream EOF 전 실제 바이트 전달 | server-relay-red.log | server-relay-green.log |
| 클라이언트 조기 청크/consumer backpressure | client-chunks-red.log | client-chunks-green.log |
| EOF 전 MSE 재생 시작 | client-playback-red.log | client-playback-green.log |
| 같은 요청 pre-play parser fallback | client-fallback-red.log | client-fallback-green.log |
| 취소 즉시 정리 및 successor 보호 | client-cancel-red.log | client-cancel-green.log |
| 전송 동의 철회 중 body 취소 | client-revoke-red.log | client-revoke-green.log |
| ended/preemption microtask 경쟁 | client-ended-preempt-red.log | client-ended-preempt-green.log |
| 취소 후 진단 상태 정리 | client-cancel-status-red.log | client-cancel-status-green.log |
| blocked downstream 기존 5초 제한 | server-delivery-timeout-red.log | server-delivery-timeout-green.log |

서버 테스트는 실제 loopback TCP slow consumer에서 upstream pull 수가 안정화되고 concurrency가 429로 유지됨을 확인한다. disconnect 후 reader 취소 및 다음 요청 200, 첫 청크 뒤 overflow/timeout/provider read failure의 stream destruction, 기존 헤더/업로드 deadline 및 비밀 비노출 검사도 포함한다. 클라이언트는 supported/unsupported/absent MSE, same-request fallback, audible failure non-replay, autoplay rejection, sourceopen 대기 취소, stale completion, 기존 local fallback 및 장문 재생 watchdog을 검사한다.

## 실제 Chrome 합성 MP3 측정

실제 빌드 앱 + 실제 Node relay + ffmpeg의 유효한 4초 mono 64kbps MP3(32,435 bytes)를 사용했다. 공급자 대체 stream은 4096-byte 청크를 250ms 간격으로 내보낸다. USB만 기존 합성 fixture다. Audio 생성/디코더/MediaSource를 mock하지 않았으며 native play를 그대로 호출하는 관찰 wrapper로 playing/timeupdate/currentTime/ended를 기록했다.

비교 baseline은 동일 relay/동일 MP3/동일 pace에서 브라우저 MSE 지원 감지만 false로 한 완전 버퍼 재생이다. 과거 서버 소스 전체를 재실행한 벤치마크가 아니며, 사용자에게 들리기 시작하는 progressive 대 buffered 재생 차이를 격리한 것이다. 각 시나리오의 공급자 호출은 정확히 1회다.

Worker 원 실행(`playwright-final.log`)의 공급자 시작 기준 측정이다. 아래 원 기록과 동결 manifest의 measurements는 그대로 보존한다.

| 관찰 | Progressive MSE | Buffered baseline |
| --- | ---: | ---: |
| 첫 native playing | 260ms | 2265ms |
| 첫 currentTime > 0.05s timeupdate | 508ms | 2523ms |
| upstream EOF | 2252ms | 2253ms |
| 위 시점 폴링의 실제 currentTime | 0.429212s (EOF 이전) | 0.541297s (EOF 이후) |
| EOF 대비 currentTime 시작 | 1744ms 먼저 | 270ms 뒤 |

Coordinator가 동일 frozen union을 독립 재실행한 최신 측정(`coordinator-playwright.log`)은 다음과 같다.

| 관찰 | Progressive MSE | Buffered baseline |
| --- | ---: | ---: |
| 첫 native playing | 262ms | 2265ms |
| 첫 currentTime > 0.05s timeupdate | 512ms | 2519ms |
| upstream EOF | 2254ms | 2251ms |
| 위 시점 폴링의 실제 currentTime | 0.43751s (EOF 이전) | 0.548059s (EOF 이후) |
| EOF 대비 currentTime 시작 | 1742ms 먼저 | 268ms 뒤 |

두 실행 모두 각 시나리오 호출 1회이며 progressive currentTime 증가는 EOF 이전, buffered control의 증가는 EOF 이후다. Coordinator의 최신 철회 케이스도 upstream cancel/abort, native paused=true/src=null, 생성 URL 전부 revoke 및 호출 1회를 통과했다.

native ended와 UI `음성 완료`까지 확인했다. 별도 Chrome 케이스에서 재생 중 동의 철회가 native paused/src 제거/모든 object URL revoke/동일 upstream abort+cancel/호출 1회를 만족했다. 320px 및 확대 글꼴 스트리밍/철회 화면도 캡처했고, 철회 뒤 `음성 대기`와 세션 종료 표시를 확인했다. 청크 헤더나 mock Audio의 play 호출만으로 조기 재생을 주장하지 않는다.

원 실행 raw는 `tts-streaming-logs/playwright-final.log`와 변경하지 않은 `source-freeze.json`의 measurements에 있다. `tts-streaming-logs/chrome-measurements.json`은 coordinator 재실행으로 갱신된 최신 결과이며 `coordinator-playwright.log`의 측정 JSON과 일치함을 확인했다. 보존된 worker 캡처는 `tts-streaming-logs/screenshots/`에 있다. 각 실행의 절대 타임스탬프 및 재생 종료 시각은 해당 로그/JSON을 사용한다. 합성 localhost 측정이므로 실제 OpenAI 지연, 인터넷/역방향 프록시 buffering, 휴대폰 스피커 출력 지연의 보장은 아니다.

## 최종 결과 및 한계

Worker 원 실행 결과:

- `npm run build`: exit 0, TypeScript + Vite build 통과 (`build-final.log`).
- `npm test`: exit 0, 25 files / 164 tests 통과 (`units-final.log`).
- `npm run test:server`: exit 0, 40 tests 통과 (`server-final.log`).
- Chrome 전체 Playwright: exit 0, 25 tests 통과 (`playwright-final.log`).

Coordinator의 frozen union 독립 검증도 완료했다. 아래 raw 로그를 읽어 성공 결과와 최신 재생/철회 증거를 확인했으며, 이번 문서 조정에서는 테스트나 빌드를 재실행하지 않았다.

- `npm test`: exit 0, 25 files / 164 tests 통과 (`coordinator-units.log`).
- `npm run test:server`: exit 0, 40 tests 통과 (`coordinator-server.log`).
- `npm run build`: exit 0, TypeScript + Vite build 통과 (`coordinator-build.log`).
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome npm run test:e2e -- --config playwright.tts.config.ts`: exit 0, 25 passed (59.2s) (`coordinator-playwright.log`).

기존 보조 검사 및 검증 범위:

- 기존 포맷 스크립트 대상인 변경 소유 TS/runner 파일 Prettier 검사 및 `git diff --check`: exit 0 (`format-owned-final.log`). 서버 mjs는 기존 서버 스타일을 유지한다.
- 전체 `npm run format:check`: exit 1. 이번에 변경하지 않은 기존 5개 파일 경고만 남는다: `src/core/usb-source.ts`, `src/core/usb-wire.ts`, `tests/button-diagnostics.test.ts`, `tests/legacy-compat.test.ts`, `tests/usb-source.test.ts`. 범위 밖 포맷 수정은 하지 않았다 (`format-check-final.log`, 해당 파일 git diff 없음).
- 초기 서버 전체 실행의 dist 부재와 초기 Playwright의 Blob 전용 관찰기/고정 포트 가정 실패는 raw 로그로 남겼다. 격리 dist build 및 테스트 fixture 계약 조정 후 최종 전체 실행은 통과했다. 기존 Blob byte-identity 케이스는 unsupported-MSE 경로로 유지했고 native MSE 재생은 새 케이스에서 별도 검증했다.
- 격리 runner/fixture는 종료했고 14373 listener가 없음을 확인했다. 남은 worktree Node 프로세스는 도구 소유 TypeScript LSP 계열뿐이며 테스트 runner가 아니다 (`cleanup.log`).
- 실제 Android 기기/물리 USB/스피커 및 유료 공급자 호출은 미실행이다. 다른 브라우저의 실제 MSE parser와 외부 배포 proxy도 미실행이다.
- commit/push/merge, 서비스 restart, production dist 작성은 하지 않았다. Coordinator의 최종 frozen union 독립 검증은 완료됐으며 대기 항목이 아니다. 남은 실기기/유료 공급자 검증은 별도 승인 범위다.

최종 소스 18개 및 빌드 산출물 SHA-256은 `tts-streaming-logs/source-freeze.json`에 있다. 문서 조정 전후 source/dist 해시가 동결 manifest와 일치하며 manifest 자체도 변경하지 않는다. Worker 원 실행과 coordinator 최신 실행의 기록을 구분하는 문서 두 개만 조정한다. Source freeze 및 Android/유료 공급자 미검증 범위는 그대로 유지한다. 인계 요약: `tts-streaming-handoff.md`.
