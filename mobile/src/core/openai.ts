const OPERATOR_ERROR =
  "운영자 설정 오류 · VIDEX_DEMO_MODE=true 및 서버 설정을 확인하세요";
export class OpenAITransport {
  private authRequired = true;
  private ready = false;
  private healthRevision = 0;
  private imageConsent = false;
  private speechConsent = false;
  constructor(
    private fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}
  async refreshHealth(signal: AbortSignal): Promise<boolean> {
    const revision = ++this.healthRevision;
    this.authRequired = true;
    this.ready = false;
    try {
      const response = await this.fetcher("/api/health", {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "same-origin",
        signal,
      });
      const health =
        response.ok &&
        response.headers
          .get("content-type")
          ?.split(";")[0]
          .trim()
          .toLowerCase() === "application/json"
          ? await response.json()
          : null;
      if (revision === this.healthRevision && !signal.aborted) {
        this.authRequired = !(
          typeof health?.ready === "boolean" && health?.authRequired === false
        );
        this.ready = !this.authRequired && health.ready === true;
      }
    } catch {
      // Unknown/old/unavailable health must never opt into unauthenticated use.
    }
    return this.authRequired || !this.ready;
  }
  configure(imageConsent: boolean, speechConsent: boolean) {
    this.imageConsent = imageConsent;
    this.speechConsent = speechConsent;
  }
  clear() {
    this.imageConsent = false;
    this.speechConsent = false;
  }
  private async request(
    endpoint: "vision" | "speech",
    body: unknown,
    signal: AbortSignal,
  ) {
    if (this.authRequired || !this.ready) throw Error(OPERATOR_ERROR);
    if (!(endpoint === "vision" ? this.imageConsent : this.speechConsent))
      throw Error("전송 동의가 필요합니다");
    signal.throwIfAborted();
    const r = await this.fetcher(`/api/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "same-origin",
    }).catch(() => {
      signal.throwIfAborted();
      throw Error("서버 사용 불가");
    });
    signal.throwIfAborted();
    if (!r.ok) throw Error(`서버 사용 불가 (${r.status})`);
    return r;
  }
  async vision(image: string, kind: "ocr" | "object", signal: AbortSignal) {
    if (
      !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(image) ||
      image.length > 8_000_000
    )
      throw Error("선택한 JPEG가 올바르지 않습니다");
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(45000)]);
    const r = await this.request("vision", { image, kind }, requestSignal);
    const reader = r.body?.getReader();
    if (!reader) throw Error("인식 응답 형식이 올바르지 않습니다");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        requestSignal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1048576) {
          void reader.cancel().catch(() => {});
          throw Error("인식 응답이 너무 큽니다");
        }
        chunks.push(value);
      }
    } catch (error) {
      requestSignal.throwIfAborted();
      if (error instanceof Error && error.message === "인식 응답이 너무 큽니다")
        throw error;
      throw Error("인식 응답 형식이 올바르지 않습니다");
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    let body;
    try {
      body = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      requestSignal.throwIfAborted();
      throw Error("인식 응답 형식이 올바르지 않습니다");
    }
    requestSignal.throwIfAborted();
    const text = body?.text;
    if (
      typeof text !== "string" ||
      Object.keys(body).length !== 1 ||
      (kind === "object" && (!text.trim() || [...text].length > 100))
    )
      throw Error("인식 결과가 비어 있습니다");
    if (text.length > 65536) throw Error("인식 응답이 너무 큽니다");
    return text;
  }
  async speech(text: string, signal: AbortSignal) {
    if (typeof text !== "string" || !text.trim() || text.length > 4000)
      throw Error("음성 요청은 비어 있지 않은 4000자 이하여야 합니다");
    const r = await this.request("speech", { text }, signal);
    if (
      r.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
      "audio/mpeg"
    )
      throw Error("음성 응답 형식이 올바르지 않습니다");
    const blob = await r.blob().catch(() => {
      signal.throwIfAborted();
      throw Error("음성 응답 형식이 올바르지 않습니다");
    });
    signal.throwIfAborted();
    if (blob.size > 10_000_000) throw Error("음성 응답이 너무 큽니다");
    return blob;
  }
}
