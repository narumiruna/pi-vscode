import { readFileSync } from "node:fs";

// All browser launches, including headless automation, use Wayland on WSL.
export function browserPlatformArgs() {
  let wsl = Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
  if (!wsl && process.platform === "linux") {
    try {
      wsl = /microsoft/i.test(readFileSync("/proc/sys/kernel/osrelease", "utf8"));
    } catch {
      // Other platforms and restricted proc mounts need no Linux-specific argument.
    }
  }
  return wsl ? ["--ozone-platform=wayland"] : [];
}
