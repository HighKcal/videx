export interface ModuleManifest {
  id: string;
  label: string;
  color: string;
  kind: "continuous" | "on-demand" | "composite";
  source: "s3";
  permissions: Array<"s3-frames" | "network:openai-image" | "speech">;
  priority: "critical" | "normal" | "background";
  frame?: { preferredFps?: number; resolutionMode?: 0 | 1 | 2 };
}
import type { Frame } from "./wire";
export interface VidexModule {
  manifest: ModuleManifest;
  init(ctx: object): Promise<void>;
  activate(): Promise<void>;
  deactivate(): Promise<void>;
  dispose(): Promise<void>;
  onShort?(): Promise<void>;
  onFrame?(frame: Frame): void;
  cancel?(): void;
  getStage?(): string;
  activationCaption?: string;
}
export class ModuleRegistry {
  private modules = new Map<string, VidexModule>();
  private active = new Set<string>();
  private selected?: string;
  private initialized = false;
  register(module: VidexModule) {
    const m = module.manifest;
    if (
      this.initialized ||
      this.modules.has(m.id) ||
      m.source !== "s3" ||
      !/^#[0-9a-f]{6}$/i.test(m.color) ||
      !m.id ||
      m.permissions.some(
        (p) => !["s3-frames", "network:openai-image", "speech"].includes(p),
      )
    )
      throw Error("검토된 고유 S3 모듈만 등록할 수 있습니다");
    this.modules.set(m.id, module);
  }
  list() {
    return [...this.modules.values()].map((m) => m.manifest);
  }
  get(id: string) {
    return this.modules.get(id);
  }
  frame(frame: Frame) {
    for (const id of this.active) this.modules.get(id)?.onFrame?.(frame);
  }
  cancel() {
    for (const id of this.active) this.modules.get(id)?.cancel?.();
  }
  async init(ctx: object) {
    if (this.initialized) return;
    for (const m of this.modules.values()) await m.init(ctx);
    this.initialized = true;
    for (const m of this.modules.values())
      if (m.manifest.kind === "continuous") {
        await m.activate();
        this.active.add(m.manifest.id);
      }
  }
  async select(id: string) {
    const next = this.modules.get(id);
    if (!next || !this.initialized) throw Error("모듈 사용 불가");
    if (this.selected === id) return;
    const previous = this.modules.get(this.selected ?? "");
    if (previous && previous.manifest.kind !== "continuous") {
      await previous.deactivate();
      this.active.delete(previous.manifest.id);
    }
    if (!this.active.has(id)) {
      await next.activate();
      this.active.add(id);
    }
    this.selected = id;
  }
  async dispose() {
    for (const m of this.modules.values()) {
      if (this.active.has(m.manifest.id)) await m.deactivate();
      await m.dispose();
    }
    this.active.clear();
    this.initialized = false;
  }
}
