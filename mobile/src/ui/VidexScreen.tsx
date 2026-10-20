import type { CSSProperties } from 'react';
import './videx.css';

export interface VidexScreenProps {
  color: string;
  caption: string;
  onActivate?: () => void;
  onDiagnostics?: () => void;
}

/** Presentation only: module state, speech and diagnostics are owned by CORE. */
export function VidexScreen({
  color,
  caption,
  onActivate,
  onDiagnostics,
}: VidexScreenProps) {
  const style = { '--videx-accent': color } as CSSProperties;
  const eyes = (
    <span className="videx-eyes" aria-hidden="true">
      <span className="videx-eye" />
      <span className="videx-eye" />
    </span>
  );

  return (
    <main className="videx-screen" style={style} aria-label="VIDEX 모바일 화면" lang="ko">
      <h1 className="videx-brand">
        {onDiagnostics ? (
          <button
            className="videx-brand-button"
            type="button"
            onClick={onDiagnostics}
            aria-label="VIDEX 진단 및 설정 열기"
          >
            VIDEX
          </button>
        ) : (
          'VIDEX'
        )}
      </h1>

      {onActivate ? (
        <button
          className="videx-friend videx-activate"
          type="button"
          onClick={onActivate}
          aria-label="현재 기능 실행"
        >
          {eyes}
        </button>
      ) : (
        <div className="videx-friend" aria-hidden="true">{eyes}</div>
      )}

      <section className="videx-caption" aria-label="안내 문구">
        <p className="videx-caption-text" role="status" aria-live="polite" aria-atomic="true">
          {caption}
        </p>
      </section>
    </main>
  );
}
