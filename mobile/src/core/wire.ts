export interface Frame {
  epoch: number;
  sequence: number;
  frameId: number;
  width: number;
  height: number;
  cameraUs: bigint;
  s3Us: bigint;
  receivedAt: number;
  jpeg: Uint8Array<ArrayBuffer>;
}

export class LatestQueue<T> {
  private latest?: T;
  push(item: T) {
    this.latest = item;
  }
  take() {
    const item = this.latest;
    this.latest = undefined;
    return item;
  }
  clear() {
    this.latest = undefined;
  }
}
