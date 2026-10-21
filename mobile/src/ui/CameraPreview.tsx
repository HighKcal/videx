import React, { useLayoutEffect, useRef, useState } from "react";
import type { AppController } from "../core/controller";
import { PreviewRenderer, type PreviewStatus } from "../core/preview-renderer";

export function CameraPreview({
  controller,
  renderer,
}: {
  controller: Pick<AppController, "preview" | "subscribe">;
  renderer: PreviewRenderer;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<PreviewStatus>({ kind: "no-frame" });
  useLayoutEffect(() => {
    renderer.attach(canvas.current!, setStatus);
    const update = () => renderer.update(controller.preview());
    const unsubscribe = controller.subscribe(update);
    update();
    // Age expiry must also clear a stalled image when no further frames arrive.
    const timer = setInterval(update, 250);
    return () => {
      unsubscribe();
      clearInterval(timer);
      renderer.detach();
    };
  }, [controller, renderer]);
  const input = controller.preview();
  const rotation = {
    none: "회전 없음",
    cw90: "시계 90도",
    ccw90: "반시계 90도",
    "180": "180도",
  }[input.rotation];
  return (
    <section
      className="camera-preview"
      aria-labelledby="camera-preview-heading"
      data-testid="camera-preview"
    >
      <h2 id="camera-preview-heading">실시간 LEFT 카메라 미리보기</h2>
      <p>
        현재 수신 영상이며 마지막 OCR 촬영 사진과는 다릅니다. 인식과 같은 회전을
        적용하며 선명도 보정이나 자동 전송은 하지 않습니다.
      </p>
      <p data-testid="camera-preview-status">
        {
          {
            "no-frame": "프레임 없음 · 새 LEFT 영상 대기",
            loading: "영상 디코딩 중",
            live: "실시간 영상 표시 중",
            stale: "수신 지연 · 오래된 영상 지움",
            disconnected: "연결 끊김 · 영상 없음",
            error: "영상 디코딩 실패 · JPEG 크기/브라우저 지원 확인",
          }[status.kind]
        }
      </p>
      <p data-testid="camera-preview-metadata">
        {input.frame
          ? `실제 수신 ${input.frame.width}×${input.frame.height} · frame ${input.frame.frameId}`
          : "수신 프레임 없음"}
        {` · 선택 회전: ${rotation}`}
        {status.kind === "live" &&
          ` · 표시 frame ${status.frameId} (원본 ${status.width}×${status.height})`}
      </p>
      <div className="camera-preview-image">
        <canvas
          ref={canvas}
          aria-label="회전 적용된 현재 LEFT 영상"
          data-testid="camera-preview-canvas"
          hidden={status.kind !== "live"}
        />
      </div>
      <p>
        화면에 맞춰 비율을 유지합니다. 캔버스 내부 해상도는 회전한 원본 픽셀
        크기입니다. 글자가 흐리면 이 영상에서 초점·거리·조명·흔들림을
        확인하세요.
      </p>
    </section>
  );
}
