/**
 * RFC 6455 helpers — handshake derivation, server-side text frame encoder,
 * client-side (masked) frame parser. The full {@link attachWebSocket}
 * integration is exercised by `WebSocket.smoke.test.ts`.
 */

import { describe, expect, it } from "vitest";

import {
  computeAcceptKey,
  encodeTextFrame,
  parseClientFrame,
  WS_MAGIC,
} from "./WebSocket.js";

describe("WebSocket pure helpers", () => {
  it("computeAcceptKey matches the RFC 6455 example", () => {
    // RFC 6455 §1.3 worked example.
    expect(computeAcceptKey("dGhlIHNhbXBsZSBub25jZQ==")).toBe(
      "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
    );
  });

  it("WS_MAGIC matches the RFC 6455 GUID", () => {
    expect(WS_MAGIC).toBe("258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
  });

  it("encodeTextFrame produces an unmasked single text frame for short payloads", () => {
    const buf = encodeTextFrame("hi");
    // FIN=1, RSV=0, opcode=1 → 0x81; mask=0, len=2 → 0x02; "hi" = 0x68 0x69
    expect(Array.from(buf)).toEqual([0x81, 0x02, 0x68, 0x69]);
  });

  it("encodeTextFrame uses 16-bit extended length for 126..65535-byte payloads", () => {
    const payload = "x".repeat(200);
    const buf = encodeTextFrame(payload);
    // First byte 0x81, second 0x7e (126 → 16-bit length), then 0x00 0xC8 = 200
    expect(buf[0]).toBe(0x81);
    expect(buf[1]).toBe(0x7e);
    expect(buf[2]).toBe(0x00);
    expect(buf[3]).toBe(0xc8);
    expect(buf.length).toBe(4 + 200);
  });

  it("parseClientFrame parses a masked text frame", () => {
    // Manually craft a masked text frame for "hello".
    const mask = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);
    const payload = Buffer.from("hello");
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) {
      masked[i] = payload[i]! ^ mask[i % 4]!;
    }
    const frame = Buffer.concat([
      Buffer.from([0x81, 0x80 | payload.length]),
      mask,
      masked,
    ]);

    const result = parseClientFrame(frame);
    expect(result).not.toBeNull();
    if (!result || result.kind !== "frame") throw new Error("expected frame");
    expect(result.opcode).toBe(0x1);
    expect(result.payload.toString("utf8")).toBe("hello");
    expect(result.consumed).toBe(frame.length);
  });

  it("parseClientFrame rejects an unmasked frame from a client", () => {
    // Per RFC 6455 §5.1 — every client frame MUST be masked.
    const frame = Buffer.from([0x81, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f]);
    expect(() => parseClientFrame(frame)).toThrow(/masked/i);
  });

  it("parseClientFrame returns null when the buffer is too short", () => {
    // Header alone, no length byte.
    expect(parseClientFrame(Buffer.from([0x81]))).toBeNull();
  });
});
