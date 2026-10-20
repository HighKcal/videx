# UI handoff — DONE

## 범위와 산출물

- 작업: UI. main 작업 트리에서 UI 파일만 구현. 커밋/푸시, 의존성 설치, package/lock 변경 없음. 다른 담당자 파일 수정 없음.
- `mobile/src/ui/VidexScreen.tsx`: named export `VidexScreen`, exported type `VidexScreenProps`.
- `mobile/src/ui/videx.css`: 컴포넌트에서 직접 import. 모든 선택자는 `videx-` 범위이며 body/root/global reset을 덮어쓰지 않음.
- 이 문서: `docs/v2/ui-handoff.md`.
- 공유 계약과 첨부 HTML/MD를 읽고 구현. PDF 이미지는 별도 검토하지 않았으며, 공유 계약의 HTML 막대 눈 우선 규칙을 따름.

## 고정 인터페이스 / CORE 연결

Props는 계약 그대로 `{ color: string; caption: string; onActivate?: () => void; onDiagnostics?: () => void }`.

- `color`: 신뢰된 모듈 manifest의 CSS 색상. 원형 캐릭터는 전달값 그대로 적용. 기본 CSS 토큰은 `#ff5033`; CORE는 보행 `#FF5033`, OCR `#3978F6`, 물체 `#865CEB` 전달.
- `caption`: React 텍스트로 렌더링하며 HTML 주입 없음. 줄바꿈 보존. 긴 한국어/공백 없는 문자열은 줄바꿈되고 영역이 세로로 확장됨. 빈 문자열도 회색 컨테이너 유지. 내용 생성·중복 억제·오류 해석은 CORE 담당.
- `onActivate`: 원 전체가 native `button type="button"`; 접근 가능한 이름은 “현재 기능 실행”. 클릭/터치/Enter/Space로 호출. 별도 버튼 외형을 추가하지 않음.
- `onDiagnostics`: 로고가 native button으로 바뀌며 이름은 “VIDEX 진단 및 설정 열기”. Tab 순서: 로고 → 캐릭터. 진단 내용/내비게이션/복귀 시 포커스 복원은 CORE 담당.
- 콜백을 생략하면 각각 텍스트 로고와 장식용 원으로 표시. 동작 없는 버튼이나 불필요한 Tab 정지점 없음.
- 화면 자체는 상태·타이머·카메라·통신·TTS·로컬 저장을 소유하지 않음. 모듈 전환 제스처를 임의로 구현하지 않음.

CORE의 호스트 페이지는 body 기본 margin을 0으로 설정하고, viewport에 `width=device-width, initial-scale=1, viewport-fit=cover`를 제공할 것. 컴포넌트는 자체 `main` landmark를 가지므로 다른 main 안에 중첩하지 말 것. 호스트가 고정 높이/overflow:hidden으로 UI 스크롤을 막지 않아야 함.

## 디자인 / 접근성 결정

- 왼쪽 검정 VIDEX 로고, 최대 292px 단색 원, 흰 캡슐 막대 눈 두 개, `#eeeeee` 둥근 자막만 상시 표시.
- 원의 눈 비율/위치, glance 12.5초 / blink 4.3초는 HTML 기준. 눈 자체가 함께 이동하며 동공·별·추가 도형 없음.
- 원형/자막 색상 전환 0.3초. `prefers-reduced-motion: reduce`에서 눈 애니메이션과 색상 전환 모두 제거.
- 원본 주황 자막은 회색 배경 대비가 2.81:1로 큰 글자 기준 3:1 미달. 원의 모듈 색은 유지하고 자막만 `color-mix(in srgb, var(--videx-accent) 90%, #000)`으로 소폭 어둡게 보정. 자막은 최소 24px / 700으로 큰 글자 기준 유지. 실제 브라우저 픽셀값으로 대비: 주황 3.40:1, 파랑 4.18:1, 보라 4.52:1. 임의의 매우 밝은 color에 대한 대비까지 보장하지는 않음.
- 로고 최소 터치 높이 44px. 버튼의 키보드 포커스는 검정 3px 외곽선. 기본 화면에서 추가 컨트롤을 늘리지 않음.
- 장식 눈은 접근성 트리에서 숨김. 안내는 atomic/polite `role=status`로 업데이트. 위험도 prop이 없으므로 화면이 자의적으로 assertive 경고를 생성하지 않음. 긴급 음성 우선순위/취소는 CORE 담당.
- safe-area inset 패딩, 100svh 최소 높이. 절대 위치/고정 자막 높이/overflow:hidden을 피해서 작은 화면·확대·긴 문구 시 문서 세로 스크롤 허용. 높이 570px 이하는 원 크기/간격 축소. 최대 화면 폭 480px.
- forced-colors에서는 시스템 색상으로 원/눈/자막 테두리/포커스 대응.

## 상태 매핑 (CORE 담당)

- 연결 대기/로딩: 현재 색 + 진행 사실을 설명하는 caption. UI 자체 spinner/가짜 진행률 없음.
- 입력 없음: 실제 상황을 알려주는 caption을 전달. 빈 caption은 빈 회색 패널로 유지하며 임의의 성공 문구를 만들지 않음.
- 연결 끊김/UNKNOWN/오류: CORE가 정확한 오류·재시도 안내를 caption에 전달. 활성화 콜백 연결 여부도 CORE가 결정.
- 인식 완료/경고: caption을 전체 문자열로 갱신. UI는 별도 타이핑 효과를 넣어 스크린리더 안내를 분절하지 않음.
- OpenAI AI 음성 및 텍스트 전송 고지/개인정보 화면은 CORE 진단 화면 담당. UI가 로컬 전용 음성이라고 주장하지 않음.

## 실제 검증

작업 디렉터리 `/home/minwoo/.superset/projects/videx/mobile`.

1. `./node_modules/.bin/tsc --noEmit --strict --skipLibCheck --target ES2022 --lib ES2022,DOM,DOM.Iterable --module ESNext --moduleResolution Bundler --jsx react-jsx --types vite/client src/ui/VidexScreen.tsx`
   - exit 0. UI 단독 strict 타입 검사 통과.
2. `node /home/minwoo/.hermes/profiles/coop-design/cache/scratch/videx-ui-check.mjs`
   - 최종 exit 0. 기존 Vite/React/Playwright 패키지로 UI를 실제 마운트한 임시 하네스. `/usr/bin/google-chrome` headless 사용. 실행 종료 시 서버/브라우저 정리.
   - 처음 실행은 Playwright 기본 Chromium 실행 파일이 없어 exit 1. 설치 없이 기존 Chrome으로 전환하여 재검증 통과.
   - 실제 눈 이동 transform / blink 압축, native Tab/Enter/Space 및 콜백 호출 횟수, focus-visible 외곽선 검증.
   - 세 모듈 원형 색상 및 자막 큰 글자 대비 검증.
   - 320×480, 280×320, 480×800, 844×390, 1280×900에서 짧은/긴/빈 caption 각각 검증: 가로 넘침 없음, 로고/원/자막 겹침 없음, 원 비율 유지, 문구 잘림 없음.
   - reduced motion 애니메이션/전환 제거, optional callback 생략 시 버튼 없음, polite/atomic status 속성, 런타임 오류 없음 확인.
3. `node /home/minwoo/.hermes/profiles/coop-design/cache/scratch/videx-ui-contrast.mjs`
   - exit 0. 원본/보정 색상 대비 계산. 브라우저 테스트에서도 실제 렌더링 색의 픽셀값으로 별도 확인.
4. 루트에서 `git diff --check`: exit 0 (untracked 파일은 Git diff 대상이 아니므로 소유 파일 whitespace 별도 검사도 수행).

실제 스크린샷:
- `/home/minwoo/.hermes/profiles/coop-design/cache/scratch/videx-ui-mobile.png`
- `/home/minwoo/.hermes/profiles/coop-design/cache/scratch/videx-ui-long-caption.png`
첫 모바일 캡처를 직접 열어 로고/원/막대 눈/자막 및 겹침 없는 화면 확인. 테스트 하네스/캡처는 임시 scratch에만 두고 저장소에 테스트 설정이나 의존성을 추가하지 않음.

## 남은 검증 / 위험

- CORE가 앱에 연결하고 전체 build/통합 E2E 실행 필요. 이 작업은 독립 UI 타입 검사와 실제 UI 브라우저 검증에 한정하며 전체 앱 완료를 주장하지 않음.
- 실제 iOS Safari/Android PWA, 노치 safe-area 실측, VoiceOver/TalkBack 읽기, OS 고대비 모드는 미실행. reduced-motion은 Chrome 에뮬레이션으로 검증.
- 하드웨어/S3 연결, OpenAI 유료 호출, TTS 중재/개인정보 화면은 이 범위에서 실행하지 않음.
- 매우 긴 결과는 페이지 세로 스크롤이 필요. 비동기 완료 후 사용자 스크롤/포커스를 강제 이동하지 않음.
- color-mix 미지원 구형 브라우저에서는 원본 accent로 폴백하므로 주황 자막 대비 개선은 적용되지 않음. 최신 대상 브라우저 사용 또는 CORE 단계에서 지원 범위 확인 필요.
