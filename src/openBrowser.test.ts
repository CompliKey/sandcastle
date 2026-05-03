import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

import { openBrowser } from "./openBrowser.js";

const fakeChild = (): EventEmitter & { unref: () => void } => {
  const ee = new EventEmitter() as EventEmitter & { unref: () => void };
  ee.unref = (): void => {};
  return ee;
};

describe("openBrowser", () => {
  it("uses xdg-open on linux", () => {
    const spawnImpl = vi.fn(() => fakeChild()) as never;
    openBrowser("http://localhost:4321", {
      platformOverride: "linux",
      spawnImpl,
    });
    expect(spawnImpl).toHaveBeenCalledWith(
      "xdg-open",
      ["http://localhost:4321"],
      expect.objectContaining({ detached: true, stdio: "ignore" }),
    );
  });

  it("uses open on darwin", () => {
    const spawnImpl = vi.fn(() => fakeChild()) as never;
    openBrowser("http://localhost:4321", {
      platformOverride: "darwin",
      spawnImpl,
    });
    expect(spawnImpl).toHaveBeenCalledWith(
      "open",
      ["http://localhost:4321"],
      expect.anything(),
    );
  });

  it("uses cmd /c start on win32", () => {
    const spawnImpl = vi.fn(() => fakeChild()) as never;
    openBrowser("http://localhost:4321", {
      platformOverride: "win32",
      spawnImpl,
    });
    expect(spawnImpl).toHaveBeenCalledWith(
      "cmd",
      ["/c", "start", "", "http://localhost:4321"],
      expect.anything(),
    );
  });

  it("swallows spawn errors", () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => child) as never;
    openBrowser("http://localhost:4321", {
      platformOverride: "linux",
      spawnImpl,
    });
    // Emit an error after the call returned. The handler must absorb it
    // without throwing.
    expect(() => child.emit("error", new Error("boom"))).not.toThrow();
  });
});
