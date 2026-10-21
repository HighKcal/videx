import React, {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createRoot } from "react-dom/client";
import { VidexScreen } from "./ui/VidexScreen";
import { AppController } from "./core/controller";
import { CameraPreview } from "./ui/CameraPreview";
import { PreviewRenderer } from "./core/preview-renderer";

import { browserUsb } from "./core/usb-cdc";

import "./diagnostics.css";
const controller = new AppController();
function App() {
  useSyncExternalStore(controller.subscribe, controller.snapshot);
  const [diagnostics, setDiagnostics] = useState(false);
  // Retain one renderer across hide/reopen so an old decode cannot overlap a new one.
  const [previewRenderer] = useState(() => new PreviewRenderer());
  const [error, setError] = useState("");
  const [diagnosticNow, setDiagnosticNow] = useState(() => performance.now());
  useEffect(() => {
    if (!diagnostics) return;
    setDiagnosticNow(performance.now());
    const timer = setInterval(() => setDiagnosticNow(performance.now()), 500);
    return () => clearInterval(timer);
  }, [diagnostics]);

  const [serverStatus, setServerStatus] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const healthStarted = useRef(false);

  const state = controller.state;
  const button = state.button;
  const eventLabel = (type: string) =>
    type === "button_short" ? "SHORT" : "LONG";
  const age = (at: number) => Math.max(0, Math.round(diagnosticNow - at));
  useEffect(() => {
    if (!diagnostics && healthStarted.current) return;
    healthStarted.current = true;
    const abort = new AbortController();
    setServerStatus("loading");
    void controller.ai.refreshHealth(abort.signal).then((required) => {
      if (!abort.signal.aborted) setServerStatus(required ? "error" : "ready");
    });
    return () => abort.abort();
  }, [diagnostics]);
  useEffect(() => {
    const visibility = () => {
      if (document.hidden) controller.suspend();
    };
    document.addEventListener("visibilitychange", visibility);
    const key = (e: KeyboardEvent) => {
      if (diagnostics || e.repeat) return;
      if (e.key === "ArrowRight") void controller.cycle();
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("keydown", key);
    };
  }, [diagnostics]);
  if (!diagnostics)
    return (
      <VidexScreen
        color={
          controller.registry.list().find((m) => m.id === state.mode)?.color ??
          "#FF5033"
        }
        caption={state.caption}
        onActivate={() => {
          controller.feedback.enableAudio();
          void controller.capture();
        }}
        onDiagnostics={() => setDiagnostics(true)}
      />
    );
  return (
    <main className="diagnostics">
      <h1>VIDEX 진단 및 설정</h1>
      <button onClick={() => setDiagnostics(false)}>메인 화면으로</button>
      <CameraPreview controller={controller} renderer={previewRenderer} />
      <p role="alert">
        보행 보조 실험 앱입니다. 거리·안전 판단을 제공하지 않습니다. 화면
        잠금/백그라운드 감지는 지원하지 않습니다.
      </p>
      <dl>
        <dt>장치 연결</dt>
        <dd data-testid="connection">{state.connection}</dd>
        <dt>수신 영상 (실제 크기)</dt>
        <dd data-testid="input-frame">{state.input}</dd>
        <dt>보행 Worker</dt>
        <dd>
          {state.walking} · {state.reason}
        </dd>
        <dt>처리 프레임</dt>
        <dd data-testid="processed">{state.processed}</dd>
        <dt>최신 프레임 대체</dt>
        <dd>{state.dropped}</dd>
        <dt>촬영 단계</dt>
        <dd>{state.session}</dd>
        <dt>음성</dt>
        <dd data-testid="speech-state">{controller.feedback.status}</dd>
      </dl>
      <p role="status">{state.caption}</p>
      <p role="alert">{error || state.error}</p>
      <section
        aria-labelledby="button-diagnostics-heading"
        data-testid="button-diagnostics"
      >
        <h2 id="button-diagnostics-heading">물리 버튼 진단 (LEFT)</h2>
        <p>
          파싱된 CAM2 헤더 기준이며 실제 GPIO 측정은 아닙니다. 첫 상태는
          기준선으로 삼고, 관찰한 누름과 놓음 이후에만 이벤트를 수락합니다.
          마지막 펌웨어 결과는 반복될 수 있습니다. 진단은 현재 세션 메모리에만
          유지됩니다.
        </p>
        <dl>
          <dt>버튼 수신 상태</dt>
          <dd data-testid="button-availability">
            {button
              ? {
                  "no-frame": "LEFT 프레임 없음",
                  live: "LEFT 프레임 수신 중",
                  stale: "수신 지연 · 마지막 표본은 현재 상태가 아닙니다",
                  disconnected:
                    "연결 끊김 · 마지막 표본은 현재 상태가 아닙니다",
                }[button.availability]
              : "LEFT 프레임 없음 · 연결 대기"}
          </dd>
          <dt>최근 파싱한 LEFT 프레임 ID</dt>
          <dd data-testid="button-frame-id">{button?.frameId ?? "없음"}</dd>
          <dt>수신 시각 / 경과 (페이지 단조 시계)</dt>
          <dd data-testid="button-received">
            {button?.receivedAt != null
              ? `${Math.round(button.receivedAt)} ms · ${age(button.receivedAt)} ms 경과`
              : "없음"}
          </dd>
          <dt>최근 헤더 메타데이터 (지연/끊김 시 과거 표본)</dt>
          <dd data-testid="button-metadata">
            {button?.rawFlags != null
              ? `flags=${button.rawFlags} · valid=${Number(button.valid)} · classified=${Number(button.classified)}`
              : "없음"}
          </dd>
          <dt>헤더 원시 눌림 비트 (ID 필터 전, 현재 상태 아님)</dt>
          <dd data-testid="button-raw-level">
            {button?.rawFlags != null
              ? `bit0=${button.rawFlags & 1} (${button.rawFlags & 1 ? "눌림" : "놓음"})`
              : "없음"}
          </dd>
          <dt>해석한 버튼 상태</dt>
          <dd data-testid="button-level">
            {button?.availability === "live"
              ? { pressed: "눌림", released: "놓음", unknown: "알 수 없음" }[
                  button.pressed
                ]
              : "알 수 없음"}
          </dd>
          <dt>마지막 펌웨어 결과 (이벤트 횟수 아님)</dt>
          <dd data-testid="button-firmware-result">
            {button?.result != null
              ? `${["NONE", "SHORT", "LONG"][button.result] ?? "UNKNOWN"} (${button.result})`
              : "없음"}
          </dd>
          <dt>최근 표본 판정</dt>
          <dd data-testid="button-decision">
            {button?.frameId != null
              ? {
                  "no-metadata": "버튼 메타데이터 없음 (valid=0)",
                  baseline: "기준선 · 이벤트 무시",
                  repeat: "반복 상태 무시",
                  press: "누름 관찰 · 놓음 대기",
                  accepted: "이벤트 수락",
                  "unclassified-release": "놓음 관찰 · 펌웨어 결과 없음",
                  inactive: "CAM2 버튼 판정 비활성",
                  "frame-ignored": "중복/역행 프레임 ID 무시",
                }[button.decision]
              : "LEFT 프레임 대기"}
          </dd>
          <dt>수락한 SHORT 횟수 (현재 세션)</dt>
          <dd data-testid="button-short-count">{button?.shortCount ?? 0}</dd>
          <dt>수락한 LONG 횟수 (현재 세션)</dt>
          <dd data-testid="button-long-count">{button?.longCount ?? 0}</dd>
          <dt>최근 수락 이벤트</dt>
          <dd data-testid="button-last-event">
            {button?.lastEvent
              ? `${eventLabel(button.lastEvent.type)} · ${Math.round(button.lastEvent.at)} ms · ${age(button.lastEvent.at)} ms 경과`
              : "없음"}
          </dd>
          <dt>최근 물리 버튼 앱 전달 (완료 여부 아님)</dt>
          <dd data-testid="button-dispatch">
            {state.buttonDispatch
              ? `${eventLabel(state.buttonDispatch.type)} → ${state.buttonDispatch.type === "button_long" ? "모드 순환 요청" : "촬영/실행 요청"} · 전달 당시 모드: ${state.buttonDispatch.mode} · ${Math.round(state.buttonDispatch.at)} ms`
              : "없음"}
          </dd>
          <dt>현재 앱 상태 / 오류</dt>
          <dd data-testid="button-app-state">
            현재 모드: {state.mode} · 촬영 단계: {state.session} · 오류:{" "}
            {state.error || "없음"}
          </dd>
        </dl>
        <p>
          버튼 수락/전달은 촬영·인식·업로드 성공을 뜻하지 않습니다. 현재 앱
          상태와 오류를 확인하세요.
        </p>
      </section>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const data = new FormData(form);
          try {
            controller.configure(
              data.has("imageConsent"),
              data.has("speechConsent"),
              data.has("fallback"),
            );
            form.reset();
            setError("");
          } catch (err) {
            setError(err instanceof Error ? err.message : "설정 실패");
          }
        }}
      >
        <h2>Android USB-C · S3 CDC 연결</h2>
        <p>
          USB 영상은 이 휴대폰에서만 처리합니다. Python 브리지나 Cloudflare 영상
          중계는 사용하지 않습니다. HTTPS의 Android Chrome에서 OTG/데이터
          케이블로 S3 USB Serial/JTAG 포트에 연결한 후 아래 USB 버튼을 누르세요.
        </p>
        <p role="status">
          {browserUsb()
            ? "WebUSB API 사용 가능 · 실제 CDC 권한/연결은 장치 선택 후 확인"
            : "WebUSB 미지원 · HTTPS Android Chrome에서 여세요 (iOS 미지원)"}
        </p>
        <p>
          기존 CAM2 CDC 펌웨어를 기본으로 사용하며, 펌웨어 선택 없이 영상·해상도
          명령·버튼을 처리합니다. 글씨/물체 인식은 main과 같은 640×480 수신을
          확인한 뒤 실행합니다.
        </p>
        <p>
          선택 창에 없거나 열기 실패: OTG 전원/데이터 케이블, Android USB 권한,
          다른 앱/OS CDC 드라이버 점유를 확인하세요. 일부 Android 기종은 WebUSB
          CDC를 허용하지 않습니다. 앱은 연결 실패를 우회하거나 자동 재시도하지
          않습니다.
        </p>
        <p
          role={serverStatus === "error" ? "alert" : "status"}
          data-testid="server-setup"
        >
          {serverStatus === "loading"
            ? "서버 상태 확인 중"
            : serverStatus === "error"
              ? "운영자 설정 오류 · VIDEX_DEMO_MODE=true 및 서버 설정을 확인하세요. 이 앱에는 인증정보를 입력하지 않습니다. USB 보행 처리는 서버 없이 사용할 수 있습니다."
              : "데모 모드 · 동의한 선택 사진/텍스트만 자체 서버를 거쳐 OpenAI로 전송합니다. 서버 운영자에게 API 비용이 발생할 수 있습니다."}
        </p>
        <label className="check">
          <input name="imageConsent" type="checkbox" />
          선택 사진 전송 동의
        </label>
        <p>
          짧게 누른 시점에 선택한 OCR 1장 또는 앞뒷면 병합 사진만 자체 서버를
          거쳐 OpenAI로 보냅니다. 연속 영상 전송은 하지 않습니다. 사진에
          개인정보가 포함될 수 있습니다. store:false는 무보관/ZDR 보장이
          아닙니다.
        </p>
        <label className="check">
          <input name="speechConsent" type="checkbox" />
          텍스트 OpenAI AI 음성 전송 동의
        </label>
        <p>
          기본은 기기에 설치된 한국어 로컬 음성입니다. 사용 가능한 로컬 음성이
          없으면 자막과 오류를 표시하며 원격 음성으로 자동 전환하지 않습니다. 위
          항목을 선택하고 USB 연결을 누른 경우에만 텍스트를 자체 서버를 거쳐
          OpenAI로 보내 AI 음성을 합성합니다. TTS에는 사진을 보내지 않습니다.
          기기 음성과 pyttsx3의 목소리·속도가 같다는 뜻은 아닙니다.
        </p>
        <label className="check">
          <input name="fallback" type="checkbox" />
          OpenAI 음성 장애 시 기기 음성 대체 허용 (기기/OS 음성 서비스 정책
          적용)
        </label>
        <button type="submit">USB 장치 선택 및 연결</button>
      </form>
      <h2>기능과 제어</h2>
      <p>
        S3 짧은 누름: 현재 기능 촬영/실행. 긴 누름: 보행 → 글씨 → 물체 순환.
        메인 캐릭터 누름도 짧은 누름과 같습니다. 화살표 오른쪽은 기능
        순환입니다.
      </p>
      <label>
        카메라 회전
        <select
          value={state.rotation}
          onChange={(e) =>
            controller.setRotation(e.target.value as typeof state.rotation)
          }
        >
          <option value="cw90">시계 90도 (기본 LEFT)</option>
          <option value="none">회전 없음</option>
          <option value="ccw90">반시계 90도</option>
          <option value="180">180도</option>
        </select>
      </label>
      <p>
        보행과 선택 사진에 동일하게 적용됩니다. 안경 장착 방향을 확인하세요.
      </p>
      <p data-testid="vision-runtime">{controller.walking.runtime}</p>
      <button onClick={() => controller.feedback.enableAudio()}>
        음성 재생 활성화
      </button>
      <p>
        iOS 등은 물리 버튼만으로 브라우저 재생을 허용하지 않을 수 있습니다. 먼저
        화면의 이 버튼을 누르세요. 재생 실패는 음성 상태에 표시되며 안전 경고는
        자막으로도 확인하세요.
      </p>
      <nav aria-label="모듈 선택">
        {controller.registry.list().map((m) => (
          <button
            key={m.id}
            aria-pressed={state.mode === m.id}
            onClick={() => void controller.select(m.id)}
          >
            {m.label}
          </button>
        ))}
      </nav>
      <button onClick={() => controller.cancelCapture()}>
        촬영 취소 및 다시 시작
      </button>
      <button onClick={() => controller.disconnect()}>
        USB 연결 종료 및 세션 삭제
      </button>
      <button onClick={() => controller.disconnect()}>
        전송 동의 철회 및 세션 삭제
      </button>
      <h2>개인정보/배포 경계</h2>
      <p>
        휴대폰 카메라는 사용하지 않습니다. 원본 영상은 CAM → S3 → 이 기기 안에서
        보행 처리합니다. 동의한 선택 사진과 텍스트만 자체 API 서버를 거쳐
        OpenAI로 전송합니다. 연속 영상 전송, 분석 SDK, 앱의 이미지 영구 저장은
        없습니다. 서비스 워커는 빌드된 정적 코드만 캐시합니다. 이 앱은
        네트워크나 하드웨어 연결이 끊기면 UNKNOWN으로 전환합니다. 연결 사진·인식
        텍스트·음성·진단 로그는 영구 저장하지 않습니다. 서버 운영 정책을
        확인하세요. 브라우저/OS 자체 진단과 OpenAI 데이터 보관은 앱에서 통제할
        수 없습니다.
      </p>
      <p>
        화면 복귀 후 USB 장치를 다시 선택해 연결하세요. 이동통신 병행, 로컬
        네트워크 권한, iOS/Android 실기기는 별도 검증이 필요합니다.
      </p>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
if (import.meta.env.PROD && "serviceWorker" in navigator)
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => {
      /* offline installation unavailable; app remains online */
    });
  });
