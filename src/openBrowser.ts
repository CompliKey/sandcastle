/**
 * openBrowser — fire-and-forget cross-platform "open this URL in the user's
 * default browser". No third-party dep — `xdg-open`/`open`/`start` are
 * universally available on the platforms sandcastle supports.
 *
 * The spawned child is fully detached and its IO is ignored, so it cannot
 * keep the parent process alive once it exits.
 */

import { spawn } from "node:child_process";

export interface OpenBrowserOptions {
  /** Test seam — overrides the platform string used to pick a launcher. */
  readonly platformOverride?: NodeJS.Platform;
  /** Test seam — replaces the default `child_process.spawn` call. */
  readonly spawnImpl?: typeof spawn;
}

export const openBrowser = (
  url: string,
  options: OpenBrowserOptions = {},
): void => {
  const platform = options.platformOverride ?? process.platform;
  const launcher = launcherFor(platform);
  const spawner = options.spawnImpl ?? spawn;
  const child = spawner(launcher.cmd, [...launcher.args, url], {
    detached: true,
    stdio: "ignore",
  });
  // Don't keep the event loop alive waiting on the child.
  child.unref();
  // Swallow spawn errors — failing to open the browser is informational, not
  // fatal. The CLI should print the URL anyway.
  child.on("error", () => {});
};

interface Launcher {
  readonly cmd: string;
  readonly args: ReadonlyArray<string>;
}

const launcherFor = (platform: NodeJS.Platform): Launcher => {
  if (platform === "darwin") return { cmd: "open", args: [] };
  if (platform === "win32") return { cmd: "cmd", args: ["/c", "start", ""] };
  return { cmd: "xdg-open", args: [] };
};
