import { expect, it, vi } from "vitest";
import { UsbCdc } from "../src/core/usb-cdc";
import { device } from "./usb-fixtures";
it("claims only CDC, configures 115200 8N1 and DTR (not reset RTS), uses discovered endpoints", async () => {
  const d = device(),
    c = new UsbCdc(d as any);
  await c.open();
  expect(d.claimInterface.mock.calls).toEqual([[0], [1]]);
  expect(d.controlTransferOut).toHaveBeenCalledWith(
    {
      requestType: "class",
      recipient: "interface",
      request: 0x20,
      value: 0,
      index: 0,
    },
    Uint8Array.of(0, 194, 1, 0, 0, 0, 8),
  );
  expect(d.controlTransferOut).toHaveBeenCalledWith({
    requestType: "class",
    recipient: "interface",
    request: 0x22,
    value: 1,
    index: 0,
  });
  expect([...(await c.read())]).toEqual([1, 2]);
  expect(d.transferIn).toHaveBeenCalledWith(3, 16384);
  await c.write(Uint8Array.of(2));
  expect(d.transferOut).toHaveBeenCalledWith(4, Uint8Array.of(2));
  await c.close();
  expect(d.close).toHaveBeenCalled();
});
it("refuses wrong devices and reports claim / transfer failures, closes partial opens", async () => {
  const wrong = device();
  wrong.productId = 123;
  await expect(new UsbCdc(wrong as any).open()).rejects.toThrow(/S3/);
  const d = device();
  d.claimInterface.mockRejectedValueOnce(new Error("busy"));
  await expect(new UsbCdc(d as any).open()).rejects.toThrow(/busy/);
  expect(d.close).toHaveBeenCalled();
  const bad = device(),
    c = new UsbCdc(bad as any);
  await c.open();
  bad.transferOut.mockResolvedValueOnce({ status: "stall", bytesWritten: 0 });
  await expect(c.write(Uint8Array.of(1))).rejects.toThrow();
  bad.transferIn.mockResolvedValueOnce({
    status: "stall",
    data: new DataView(new ArrayBuffer(0)),
  });
  await expect(c.read()).rejects.toThrow();
  await c.close();
});
