/**
 * Minimal RFC 6455 WebSocket server adapter.
 *
 * Hand-rolled rather than pulling in `ws` — sandcastle's UI server only needs
 * to push small JSON messages from server to client, accept close frames, and
 * answer pings. The pure helpers below ({@link computeAcceptKey},
 * {@link encodeTextFrame}, {@link parseClientFrame}) are unit-tested in
 * `WebSocket.test.ts`. {@link attachWebSocket} wires them onto a
 * {@link Socket} returned by Node's `http` `upgrade` event.
 *
 * Limitations (deliberate)
 * - Server never sends fragmented frames.
 * - Server never sends payloads >= 2^32 bytes (text frames are JSON; we cap at
 *   16 MiB and throw if a caller tries to send larger).
 * - Inbound frames longer than 64 MiB are rejected with a 1009 close — defends
 *   the local UI server from a misbehaving / malicious local client.
 * - No permessage-deflate. Local-only traffic; not worth the complexity.
 */

import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const MAX_INBOUND_PAYLOAD_BYTES = 64 * 1024 * 1024;
const MAX_OUTBOUND_PAYLOAD_BYTES = 16 * 1024 * 1024;

export const computeAcceptKey = (clientKey: string): string =>
  createHash("sha1").update(`${clientKey}${WS_MAGIC}`).digest("base64");

export const encodeTextFrame = (text: string): Buffer => {
  const payload = Buffer.from(text, "utf8");
  if (payload.length > MAX_OUTBOUND_PAYLOAD_BYTES) {
    throw new Error(
      `WebSocket text frame too large: ${payload.length} bytes (max ${MAX_OUTBOUND_PAYLOAD_BYTES})`,
    );
  }

  const fin = 0x80;
  const opcode = 0x1; // text
  const first = fin | opcode;

  if (payload.length < 126) {
    const buf = Buffer.alloc(2 + payload.length);
    buf[0] = first;
    buf[1] = payload.length;
    payload.copy(buf, 2);
    return buf;
  }
  if (payload.length < 65536) {
    const buf = Buffer.alloc(4 + payload.length);
    buf[0] = first;
    buf[1] = 126;
    buf.writeUInt16BE(payload.length, 2);
    payload.copy(buf, 4);
    return buf;
  }
  const buf = Buffer.alloc(10 + payload.length);
  buf[0] = first;
  buf[1] = 127;
  // Hi 32 bits are 0 (we capped at 16 MiB), low 32 bits are length.
  buf.writeUInt32BE(0, 2);
  buf.writeUInt32BE(payload.length, 6);
  payload.copy(buf, 10);
  return buf;
};

const encodeCloseFrame = (code: number, reason = ""): Buffer => {
  const reasonBuf = Buffer.from(reason, "utf8");
  const payload = Buffer.alloc(2 + reasonBuf.length);
  payload.writeUInt16BE(code, 0);
  reasonBuf.copy(payload, 2);
  // FIN=1, opcode=8 close, unmasked, length<126.
  const buf = Buffer.alloc(2 + payload.length);
  buf[0] = 0x88;
  buf[1] = payload.length;
  payload.copy(buf, 2);
  return buf;
};

const encodePongFrame = (payload: Buffer): Buffer => {
  const buf = Buffer.alloc(2 + payload.length);
  buf[0] = 0x8a; // FIN=1, opcode=0xA pong
  buf[1] = payload.length;
  payload.copy(buf, 2);
  return buf;
};

export type ParsedFrame = {
  readonly kind: "frame";
  readonly fin: boolean;
  readonly opcode: number;
  readonly payload: Buffer;
  readonly consumed: number;
};

/**
 * Parse a single masked client → server frame from the head of `buffer`.
 * Returns:
 * - `null` when the buffer doesn't yet contain a complete frame.
 * - A `ParsedFrame` with `consumed` bytes (caller advances).
 *
 * Throws on protocol violations (unmasked client frame, oversize payload).
 */
export const parseClientFrame = (buffer: Buffer): ParsedFrame | null => {
  if (buffer.length < 2) return null;
  const b0 = buffer[0]!;
  const b1 = buffer[1]!;
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  if (!masked) {
    throw new Error("WebSocket client frame must be masked (RFC 6455 §5.1)");
  }
  let payloadLen = b1 & 0x7f;
  let offset = 2;
  if (payloadLen === 126) {
    if (buffer.length < offset + 2) return null;
    payloadLen = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLen === 127) {
    if (buffer.length < offset + 8) return null;
    const hi = buffer.readUInt32BE(offset);
    const lo = buffer.readUInt32BE(offset + 4);
    if (hi !== 0 || lo > MAX_INBOUND_PAYLOAD_BYTES) {
      throw new Error(`WebSocket inbound frame too large`);
    }
    payloadLen = lo;
    offset += 8;
  }
  if (buffer.length < offset + 4) return null;
  const mask = buffer.subarray(offset, offset + 4);
  offset += 4;
  if (buffer.length < offset + payloadLen) return null;
  const masked4 = buffer.subarray(offset, offset + payloadLen);
  const payload = Buffer.alloc(payloadLen);
  for (let i = 0; i < payloadLen; i++) {
    payload[i] = masked4[i]! ^ mask[i % 4]!;
  }
  offset += payloadLen;
  return { kind: "frame", fin, opcode, payload, consumed: offset };
};

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface WebSocketConnection {
  readonly send: (text: string) => void;
  readonly close: (code?: number, reason?: string) => void;
  readonly onMessage: (sink: (text: string) => void) => () => void;
  readonly onClose: (sink: () => void) => () => void;
}

/** Verify the upgrade request and write the 101 handshake. */
export const completeHandshake = (
  req: IncomingMessage,
  socket: Duplex,
): boolean => {
  const key = req.headers["sec-websocket-key"];
  const upgrade = req.headers.upgrade;
  const version = req.headers["sec-websocket-version"];
  if (
    typeof key !== "string" ||
    typeof upgrade !== "string" ||
    upgrade.toLowerCase() !== "websocket" ||
    version !== "13"
  ) {
    socket.write(
      "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
    socket.destroy();
    return false;
  }
  const accept = computeAcceptKey(key);
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n",
    ].join("\r\n"),
  );
  return true;
};

/**
 * Attach to an upgraded socket. Performs the handshake; returns a
 * {@link WebSocketConnection} or `null` if the request was rejected.
 */
export const attachWebSocket = (
  req: IncomingMessage,
  socket: Duplex,
): WebSocketConnection | null => {
  if (!completeHandshake(req, socket)) return null;

  const messageSinks = new Set<(text: string) => void>();
  const closeSinks = new Set<() => void>();
  let closed = false;

  const writeRaw = (frame: Buffer): void => {
    if (closed) return;
    socket.write(frame);
  };

  const send = (text: string): void => {
    writeRaw(encodeTextFrame(text));
  };

  const finishClose = (code: number, reason = ""): void => {
    if (closed) return;
    closed = true;
    try {
      socket.write(encodeCloseFrame(code, reason));
    } catch {
      // socket may already be torn down; ignore.
    }
    socket.end();
    for (const sink of closeSinks) {
      try {
        sink();
      } catch {
        // closure callback errors must not prevent other cleanup.
      }
    }
  };

  let inbound: Buffer = Buffer.alloc(0);
  socket.on("data", (chunk: unknown) => {
    const buf: Buffer = Buffer.isBuffer(chunk)
      ? Buffer.from(chunk)
      : Buffer.from(chunk as string, "utf8");
    inbound = inbound.length === 0 ? buf : Buffer.concat([inbound, buf]);
    while (inbound.length > 0) {
      let parsed: ParsedFrame | null;
      try {
        parsed = parseClientFrame(inbound);
      } catch {
        finishClose(1002, "protocol error");
        return;
      }
      if (!parsed) return;
      inbound = inbound.subarray(parsed.consumed);

      switch (parsed.opcode) {
        case 0x1: {
          const text = parsed.payload.toString("utf8");
          for (const sink of messageSinks) {
            try {
              sink(text);
            } catch {
              // a buggy message sink must not break the connection.
            }
          }
          break;
        }
        case 0x8: // close
          finishClose(1000, "");
          return;
        case 0x9: // ping → pong
          writeRaw(encodePongFrame(parsed.payload));
          break;
        case 0xa: // pong — ignore
          break;
        default:
          // We don't accept binary or continuation frames from the client.
          finishClose(1003, "unsupported opcode");
          return;
      }
    }
  });

  socket.on("close", () => {
    if (closed) return;
    closed = true;
    for (const sink of closeSinks) {
      try {
        sink();
      } catch {
        // Same rationale as in finishClose — never let a sink mask cleanup.
      }
    }
  });

  socket.on("error", () => {
    finishClose(1011, "internal error");
  });

  return {
    send,
    close: (code = 1000, reason = "") => finishClose(code, reason),
    onMessage: (sink) => {
      messageSinks.add(sink);
      return () => {
        messageSinks.delete(sink);
      };
    },
    onClose: (sink) => {
      closeSinks.add(sink);
      return () => {
        closeSinks.delete(sink);
      };
    },
  };
};
