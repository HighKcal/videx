import React, {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createRoot } from "react-dom/client";
import { VidexScreen } from "./ui/VidexScreen";
import { AppController } from "./core/controller";
import type { AIMode } from "./core/openai";
import type { UsbProfile } from "./core/usb-source";
import { browserUsb } from "./core/usb-cdc";
import deployment from "../deployment.config.json";
import "./diagnostics.css";
const controller = new AppController();
function App() {
  useSyncExternalStore(controller.subscribe, controller.snapshot);
  const [diagnostics, setDiagnostics] = useState(false);
  const [error, setError] = useState("");
  const [transport, setTransport] = useState("wss");
  const [aiMode, setAiMode] = useState<AIMode>("server");
  const [authRequired, setAuthRequired] = useState(true);
  const healthStarted = useRef(false);
  const [usbProfile, setUsbProfile] = useState<UsbProfile>("v2-mirror");
  const state = controller.state;
  useEffect(() => {
    if (!diagnostics && healthStarted.current) return;
    healthStarted.current = true;
    const abort = new AbortController();
    setAuthRequired(true);
    void controller.ai.refreshHealth(abort.signal).then((required) => {
      if (!abort.signal.aborted) setAuthRequired(required);
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
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const data = new FormData(form);
          try {
            controller.configure(
              transport === "usb"
                ? { transport: "usb", profile: usbProfile }
                : {
                    host: deployment.deviceHost,
                    url: `wss://${deployment.deviceHost}/ws`,
                    token: String(data.get("pairing") ?? ""),
                  },
              String(data.get("apiKey") ?? ""),
              data.has("imageConsent"),
              data.has("speechConsent"),
              data.has("fallback"),
              aiMode,
            );
            form.reset();
            setError("");
          } catch (err) {
            setError(err instanceof Error ? err.message : "설정 실패");
          }
        }}
      >
        <h2>세션 페어링</h2>
        <label>
          연결 방식
          <select
            value={transport}
            onChange={(e) => setTransport(e.target.value)}
          >
            <option value="wss">로컬 Wi-Fi WSS</option>
            <option value="usb">Android USB-C · S3 CDC (WebUSB)</option>
          </select>
        </label>
        {transport === "usb" && (
          <>
            <p>
              USB 영상은 이 휴대폰에서만 처리합니다. Python 브리지나 Cloudflare
              영상 중계는 사용하지 않습니다. HTTPS의 Android Chrome에서
              OTG/데이터 케이블로 S3 USB Serial/JTAG 포트에 연결한 후 아래 USB
              버튼을 누르세요.
            </p>
            <p role="status">
              {browserUsb()
                ? "WebUSB API 사용 가능 · 실제 CDC 권한/연결은 장치 선택 후 확인"
                : "WebUSB 미지원 · HTTPS Android Chrome에서 여세요 (iOS 미지원)"}
            </p>
            <label>
              S3 USB 펌웨어
              <select
                value={usbProfile}
                onChange={(e) => setUsbProfile(e.target.value as UsbProfile)}
              >
                <option value="v2-mirror">v2 gateway · 읽기 전용 미러</option>
                <option value="legacy">
                  기존 Python용 CAM2 · 모드 명령/버튼 메타데이터
                </option>
              </select>
            </label>
            <p>
              v2 USB 미러는 읽기 전용입니다. usb_diag 활성화가 필요하며 320×240
              수신만 보행에 사용합니다. USB 해상도 명령/물리 버튼은 펌웨어에
              없습니다. 고해상도 촬영은 WSS를 사용하세요. 기존 Python용 펌웨어가
              설치된 경우에만 기존 CAM2를 선택하세요. 펌웨어는 자동 판별할 수
              없습니다.
            </p>
            <p>
              선택 창에 없거나 열기 실패: OTG 전원/데이터 케이블, Android USB
              권한, 다른 앱/OS CDC 드라이버 점유를 확인하세요. 일부 Android
              기종은 WebUSB CDC를 허용하지 않습니다. 앱은 연결 실패를 우회하거나
              자동 재시도하지 않습니다.
            </p>
          </>
        )}
        {transport === "wss" && (
          <>
            <p>
              허용 장치: wss://{deployment.deviceHost}/ws. 유효한 TLS 인증서와
              S3의 정확한 앱 Origin 허용 설정이 필요합니다. 장치 주소 변경은
              운영자가 deployment.config.json과 CSP를 함께 재빌드해야 합니다.
            </p>
            <label>
              장치 페어링 토큰
              <input
                name="pairing"
                type="password"
                required
                autoComplete="off"
              />
            </label>
          </>
        )}
        <label>
          AI 전송 경로
          <select
            value={aiMode}
            onChange={(e) => {
              controller.disconnect();
              setAiMode(e.target.value as AIMode);
            }}
          >
            <option value="server">자체 서버 (기본)</option>
            <option value="direct">OpenAI 직접 BYOK (고급)</option>
          </select>
        </label>
        {(aiMode === "direct" || authRequired) && (
          <label key={aiMode}>
            {aiMode === "server" ? "서버 접근 토큰" : "OpenAI 세션 API 키"}
            <input name="apiKey" type="password" autoComplete="off" />
          </label>
        )}
        <p>
          {aiMode === "server"
            ? authRequired
              ? "서버 접근 토큰은 운영자가 발급한 VIDEX_ACCESS_TOKEN입니다. OpenAI API 키가 아닙니다. OpenAI 키는 서버에만 설정합니다. 선택한 사진/텍스트는 자체 서버를 거쳐 OpenAI로 전송합니다. 서버 실패 시 직접 전송으로 전환하지 않습니다."
              : "데모 모드 · 서버가 토큰 없는 사용을 명시적으로 허용했습니다. 접근 토큰을 입력하지 않습니다. OpenAI 키는 서버에만 있습니다. 동의한 선택 사진/텍스트는 자체 서버를 거쳐 OpenAI로 전송되며 서버 운영자에게 API 비용이 발생할 수 있습니다."
            : "고급 BYOK는 OpenAI로 직접 전송합니다. 일반 API 키의 브라우저 노출은 권장되지 않습니다. 신뢰하는 개인 앱에서 제한된 프로젝트 키만 사용하세요. Realtime 임시 키는 사용할 수 없습니다."}
          토큰/키는 이 탭 메모리에만 유지하고 저장·빌드하지 않습니다.
        </p>
        <label className="check">
          <input name="imageConsent" type="checkbox" />
          선택 사진 전송 동의
        </label>
        <p>
          짧게 누른 시점에 선택한 OCR 1장 또는 앞뒷면 병합 사진만 기본
          모드에서는 자체 서버를 거쳐 OpenAI로 보냅니다 (BYOK는 직접 전송). 연속
          영상 전송은 하지 않습니다. 사진에 개인정보가 포함될 수 있습니다.
          store:false는 무보관/ZDR 보장이 아닙니다.
        </p>
        <label className="check">
          <input name="speechConsent" type="checkbox" />
          텍스트 OpenAI AI 음성 전송 동의
        </label>
        <p>
          동의한 자막/인식 텍스트만 기본 모드에서는 자체 서버를 거쳐 OpenAI로
          보내 합성합니다 (BYOK는 직접 전송). 들리는 음성은 사람이 아닌 AI
          음성입니다. TTS에는 사진을 보내지 않습니다. 텍스트와 음성은 메모리만
          사용합니다.
        </p>
        <label className="check">
          <input name="fallback" type="checkbox" />
          OpenAI 음성 장애 시 기기 음성 대체 허용 (기기/OS 음성 서비스 정책
          적용)
        </label>
        <button type="submit">
          {transport === "usb" ? "USB 장치 선택 및 연결" : "설정 적용 및 연결"}
        </button>
      </form>
      <h2>기능과 제어</h2>
      <p>
        WSS 또는 기존 CAM2 USB에서 S3 짧은 누름: 현재 기능 촬영/실행. 긴 누름:
        보행 → 글씨 → 물체 순환. v2 USB 미러에는 물리 버튼 이벤트가 없습니다.
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
        연결 종료 및 메모리 키 삭제
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
        네트워크나 하드웨어 연결이 끊기면 UNKNOWN으로 전환합니다. 연결
        토큰·사진·인식 텍스트·음성·진단 로그는 영구 저장하지 않습니다. 서버 운영
        정책을 확인하세요. 브라우저/OS 자체 진단과 OpenAI 데이터 보관은 앱에서
        통제할 수 없습니다.
      </p>
      <p>
        화면 복귀 후 USB 장치 선택 또는 WSS 페어링으로 다시 연결하세요. 필요한
        서버 접근 토큰 (BYOK는 API 키)도 다시 입력하세요. 이동통신 병행, 로컬
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
