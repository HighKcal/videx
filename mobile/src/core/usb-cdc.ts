// Structural WebUSB subset: no Web Serial dependency (unavailable on Android).
export interface UsbAlternate {
  alternateSetting: number;
  interfaceClass: number;
  interfaceSubclass: number;
  endpoints: { direction: string; type: string; endpointNumber: number }[];
}
export interface UsbDevice {
  vendorId: number;
  productId: number;
  configuration?: {
    configurationValue: number;
    interfaces: { interfaceNumber: number; alternates: UsbAlternate[] }[];
  } | null;
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(n: number): Promise<void>;
  claimInterface(n: number): Promise<void>;
  selectAlternateInterface(n: number, alternate: number): Promise<void>;
  controlTransferOut(
    setup: {
      requestType: "class";
      recipient: "interface";
      request: number;
      value: number;
      index: number;
    },
    data?: Uint8Array<ArrayBuffer>,
  ): Promise<{ status: string }>;
  transferIn(
    endpoint: number,
    length: number,
  ): Promise<{ status: string; data?: DataView }>;
  transferOut(
    endpoint: number,
    data: Uint8Array<ArrayBuffer>,
  ): Promise<{ status: string; bytesWritten: number }>;
}
export interface UsbApi {
  requestDevice(options: {
    filters: { vendorId: number; productId: number }[];
  }): Promise<UsbDevice>;
  addEventListener(
    type: "disconnect",
    listener: (event: { device: UsbDevice }) => void,
  ): void;
  removeEventListener(
    type: "disconnect",
    listener: (event: { device: UsbDevice }) => void,
  ): void;
}
export function browserUsb(): UsbApi | undefined {
  return typeof navigator !== "undefined" && globalThis.isSecureContext
    ? (navigator as Navigator & { usb?: UsbApi }).usb
    : undefined;
}
export class UsbCdc {
  private input = 0;
  private output = 0;
  private cancelled = false;
  constructor(readonly device: UsbDevice) {}
  async open() {
    try {
      if (this.device.vendorId !== 0x303a || this.device.productId !== 0x1001)
        throw Error("S3 USB Serial/JTAG (303a:1001) 필요");
      await this.step(this.device.open());
      if (!this.device.configuration)
        await this.step(this.device.selectConfiguration(1));
      const interfaces = this.device.configuration?.interfaces ?? [];
      const control = interfaces.find((i) =>
        i.alternates.some(
          (a) => a.interfaceClass === 2 && a.interfaceSubclass === 2,
        ),
      );
      const data = interfaces.find((i) =>
        i.alternates.some(
          (a) =>
            a.interfaceClass === 10 &&
            a.endpoints.some(
              (e) => e.type === "bulk" && e.direction === "in",
            ) &&
            a.endpoints.some((e) => e.type === "bulk" && e.direction === "out"),
        ),
      );
      if (!control || !data)
        throw Error("CDC ACM 인터페이스 없음 (JTAG는 사용하지 않음)");
      const ca = control.alternates.find(
        (a) => a.interfaceClass === 2 && a.interfaceSubclass === 2,
      )!;
      const da = data.alternates.find(
        (a) =>
          a.interfaceClass === 10 &&
          a.endpoints.some((e) => e.type === "bulk" && e.direction === "in") &&
          a.endpoints.some((e) => e.type === "bulk" && e.direction === "out"),
      )!;
      for (const [iface, alt] of [
        [control, ca],
        [data, da],
      ] as const) {
        await this.step(this.device.claimInterface(iface.interfaceNumber));
        await this.step(
          this.device.selectAlternateInterface(
            iface.interfaceNumber,
            alt.alternateSetting,
          ),
        );
      }
      this.input = da.endpoints.find(
        (e) => e.type === "bulk" && e.direction === "in",
      )!.endpointNumber;
      this.output = da.endpoints.find(
        (e) => e.type === "bulk" && e.direction === "out",
      )!.endpointNumber;
      const setup = {
        requestType: "class" as const,
        recipient: "interface" as const,
        index: control.interfaceNumber,
      };
      const coding = await this.step(
        this.device.controlTransferOut(
          { ...setup, request: 0x20, value: 0 },
          Uint8Array.of(0, 194, 1, 0, 0, 0, 8),
        ),
      );
      if (coding.status !== "ok") throw Error("CDC line coding 실패");
      // DTR on, RTS off. Never run a bootloader/reset handshake.
      const line = await this.step(
        this.device.controlTransferOut({ ...setup, request: 0x22, value: 1 }),
      );
      if (line.status !== "ok") throw Error("CDC DTR 실패");
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  private async step<T>(promise: Promise<T>): Promise<T> {
    const value = await promise;
    if (this.cancelled) throw Error("USB 연결 취소");
    return value;
  }
  async read() {
    const result = await this.step(this.device.transferIn(this.input, 16384));
    if (result.status !== "ok" || !result.data) throw Error("USB 읽기 실패");
    return new Uint8Array(
      result.data.buffer,
      result.data.byteOffset,
      result.data.byteLength,
    );
  }
  async write(bytes: Uint8Array<ArrayBuffer>) {
    const result = await this.step(this.device.transferOut(this.output, bytes));
    if (result.status !== "ok" || result.bytesWritten !== bytes.length)
      throw Error("USB 명령 전송 실패");
  }
  async close() {
    this.cancelled = true;
    // close releases claims and cancels pending transfers, even on unplug.
    await this.device.close().catch(() => {});
  }
}
