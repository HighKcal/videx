# Main client parity

기준: GitHub kimssammwu/videx main의 정확한 SHA `f7f0ea496dc4a06bf15a98eee14e08dea186f071`. `git show <SHA>:<path>`로 읽었으며 dirty working tree를 main으로 간주하지 않았다. 구현 위치는 `/home/minwoo/.superset/projects/videx`, 브랜치 `feat/videx-v2-android-cdc-demo`다. 기존 dirty 변경을 보존했다.

## 비교 및 적용 범위

- `proxy/runtime.py`: `MODE_RESOLUTIONS={0:0,1:1,2:1}`. 글씨/물체 모두 LEFT 640×480. 모바일 builtins의 mode 2/1280 조건을 mode 1/640×480으로 복원했다. 실제 해상도 관찰 ACK, 2초 freshness, decoding/header size 검증, 취소/generation 및 동의 검사는 유지한다.
- `proxy/runtime.py:Runtime.action`, `app/text_recognition/service.py`, `config.py`, `vision.py`: OCR은 한 장, 화질 점수 차단 없음, text 문자열 한 개(빈 문자열 포함). runtime은 OpenCV 기본 JPEG95를 사용한다. 모바일 수동 OCR은 JPEG quality 0.95와 같은 회전을 사용하며 밝기/분산/edge 기반 차단을 적용하지 않는다. 빈 OCR은 main과 같이 `인식된 글자가 없습니다.`로 안내한다. 브라우저 Canvas JPEG와 OpenCV의 바이트/압축 결과가 같다고 주장하지 않는다.
- `app/object_recognition/recognizer.py:_manual_capture`, `models.py`: 자동 촬영은 sharpness>=45, brightness22..238 및 stability/motion 조건을 사용하지만 수동 확정은 quality_ok를 강제하지 않는다. 단, 앞/뒷면 normalized difference <0.055는 수동에서도 거부한다. 모바일은 기존 명시적 앞/뒷면 수동 확정을 유지하고 이 정책에 맞춰 수동 화질 차단은 하지 않으며 160px grayscale analysis의 0.055 중복 보호를 적용한다. main의 자동 stability/candidate 선택 엔진 전체를 새로 이식한 것은 아니다. 테스트에 남은 assessQuality utility는 수동 인식 실행 경로에서 호출하지 않는다.
- `app/object_recognition/image_ops.py`, `models.py`: object JPEG90, 앞왼쪽/뒤오른쪽 병합, 최대 높이1200/폭1800, 비율 유지로 맞췄다. Canvas grayscale/보간은 OpenCV와 픽셀 단위 동일성이 검증되지 않았다. `인식 실패`는 실패 처리하며 성공 안내는 main의 `인식된 제품은 ...입니다.` 형식을 사용한다.
- `proxy/desktop.py`, `proxy/local_speech.py`: main은 기본 pyttsx3 로컬 음성(한국어 voice 선택, rate175), mute는 명시적 선택이다. 웹의 가까운 대응으로 `localService=true` 한국어 SpeechSynthesis를 기본 사용한다. 초기 getVoices()가 빈 경우에만 voiceschanged를 최대1500ms 기다린다. 성공/취소/timeout 시 timer와 abort/voice listener를 제거한다. 로컬 음성 부재 시 오류/자막만 표시하며 cloud voice나 OpenAI로 몰래 전환하지 않는다. 목소리·속도·음질·지연이 main과 같거나 개선됐다고 측정/주장하지 않는다.
- 기존 OpenAI 음성 checkbox는 명시적 원격 opt-in으로 유지한다. controller.configure의 speechConsent만 remoteSpeech를 켜고 세션 종료 시 끈다. 기존 원격 실패 시 로컬 fallback 선택 및 재생/취소/우선순위 보호는 유지한다. 전체 자막은 잘라내지 않으며 로컬1000자/원격4000자 이하 조각을 순차 재생한다. UTF-16 surrogate pair 중간을 자르지 않는다. 재생 실패/취소는 나머지를 성공으로 오인시키지 않는다.

## 서버 소유자와의 계약

`docs/v2/main-server-parity.md`를 읽어 frontend/fixture를 정렬했다. 이 작업은 mobile/server를 수정/재시작하지 않았다.

- 브라우저 POST `/api/vision {image,kind}` -> `{text}` 그대로 유지.
- OCR 최대65536 UTF-16 code units, 응답 JSON envelope 최대1048576 bytes; 넘으면 명시적 오류, silent slicing 없음. OCR 빈 문자열 허용. object는 최대100 Unicode code points 및 비어 있지 않은 결과만 수락한다. provider 상세 object 파싱은 서버 담당.
- 클라이언트 vision deadline45000ms, builtins action cancellation50000ms. 서버 OCR30000/object20000ms와 upload/read 여유를 확보하며 사용자 취소는 즉시 전달한다.
- Speech API는 여전히 요청당4000자이고 독립된 전송 동의가 필요하다. 긴 OCR을 4000자로 조용히 자르지 않는다.
- 통합 provider mock은 Chat Completions `choices[0].message.content`: OCR은 내부 JSON `{"text":...}`, object는 plain 제품명. Responses envelope에 의존하지 않는다. endpoint/prompt/model/token은 서버 담당이며 여기서 유료 API 결과를 만들거나 검증하지 않았다.

## 회귀와 검증

실제 도구 실행 RED:

- main-capture-parity: fixture fillRect 보완 후 의미 있는 실패4/통과1 (flat0/128/255 품질 차단과 병합2560폭 vs1800).
- recognition mode 변경 회귀: 실패2/통과5(main-capture 포함). 이후 mode/empty/44초 cancellation 보존 GREEN.
- server-transport: 실패2/통과9(recognition 포함): 빈 OCR 거부와 4000자 slicing을 실제 확인.
- main-local-speech: 최초 실패4/다른 관련 테스트 통과11. 이후 명시적 remote, 로컬 기본, 긴 조각, 취소가 GREEN.
- object 결과 안내/실패 marker: 실패2/통과2 후 수정.
- 초기 voice loading 추가: 실패3/통과4 후 bounded wait 수정.

중간 전체 `npm test`: 23개 파일/146개 통과. 최종 voice-loading 변경 및 scoped format 이후 이 워커의 `npm test`: 23개 파일/149개 통과. `npx tsc --noEmit` 및 소유 범위 `git diff --check` 통과. 소스 동결 유지.

최종 coordinator/lead 독립 검증 결과 (리드 보고; 이 워커의 재실행 아님):

- `npm test`: 149/149 PASS.
- `npm run test:server`: 34/34 PASS.
- system Chrome E2E: 23/23 PASS. 아래 browser 회귀를 포함한 최종 통합 검증 완료.
- 명시적 `npm run build` (tsc + Vite): PASS. 생성 asset: `index-BzhxLPXm.js`.
- `git diff --check`: PASS.

`mobile/tests/e2e/main-client-parity.spec.ts`는 단색(기존 heuristic이면 거부되는) synthetic JPEG의 OCR 요청 수락,640×480,4000자 초과 원문 보존,빈 OCR 안내,기본 로컬 음성 및 `/api/speech` 요청0을 함께 검증하도록 작성했다. 기존 CDC/button/preview/browser acceptance는 새 resolution 및 Chat Completions 계약에 맞춰 수정했다. 앞뒷면 fixture는 별도 표면으로 구분되도록 background를 바꿔 중복 방지를 우회하지 않게 했다.

이 워커는 E2E/build/server/shared port를 실행하지 않았다. E2E/build는 위 coordinator/lead 결과로 소프트웨어 통합 검증이 완료됐다. 실물 하드웨어/카메라 초점·흔들림, 유료 실제 API 호출 및 실서비스 인식 정확도, 실제 한국어 로컬 voice availability·음성 지연/성능은 여전히 미검증이다. 기본 연결의 legacy-safe raw commands, 버튼 진단, preview, consent, CSP/no-store/secret 경계는 보존한다. 이미지/결과/음성을 영구 저장하거나 진단 외부 로그를 추가하지 않았다.

운영 반영 주의: 공유 실행 서버는 재시작하지 않았다. API 변경을 실행 서비스에 적용하려면 운영자가 해당 서버를 재시작해야 한다. 통과한 소스/빌드/테스트 결과를 현재 실행 서버에 API 변경이 이미 반영됐다는 증거로 간주하지 않는다.

## 이 작업에서 변경한 파일

Production:

- mobile/src/core/capture.ts
- mobile/src/core/openai.ts
- mobile/src/core/feedback.ts
- mobile/src/core/controller.ts
- mobile/src/modules/builtins.ts
- mobile/src/main.tsx

Unit:

- mobile/tests/capture.test.ts
- mobile/tests/main-capture-parity.test.ts (new)
- mobile/tests/main-local-speech.test.ts (new)
- mobile/tests/recognition.test.ts
- mobile/tests/server-transport.test.ts
- mobile/tests/feedback.test.ts
- mobile/tests/walking-feedback.test.ts

Browser (authored/updated by this worker; coordinator/lead final E2E 23/23 PASS):

- mobile/tests/e2e/cdc-integration.spec.ts
- mobile/tests/e2e/cdc-events.spec.ts
- mobile/tests/e2e/cdc-privacy.spec.ts
- mobile/tests/e2e/legacy-cdc.spec.ts
- mobile/tests/e2e/button-diagnostics.spec.ts
- mobile/tests/e2e/usb.spec.ts
- mobile/tests/e2e/camera-preview.spec.ts
- mobile/tests/e2e/cdc-fixtures.ts
- mobile/tests/e2e/main-client-parity.spec.ts (new)

Evidence: docs/v2/main-client-parity.md (new).

No firmware edits, flash, reset, commit, push, secret-file reads, paid real provider calls or running-server restarts.
