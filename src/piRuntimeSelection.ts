import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export const bundledPiVersion = "1.3.0";
const packageName = "@earendil-works/pi-coding-agent";

/** Runtime fields only. Feature arguments, credentials and isolation belong to the caller. */
export interface PiLaunchDescription {
  readonly executablePath: string;
  readonly executableArgs?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly unsetEnv?: readonly string[];
}

interface HostRuntime {
  readonly execPath: string;
  readonly nodeVersion: string;
  readonly electron?: string;
}

export function supportsBundledPi(nodeVersion: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(nodeVersion);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 19);
}

/** Resolve only at process creation, never while opening Settings or reading the launch policy. */
export function resolvePiRuntime(
  configured: string,
  extensionRoot: string | undefined,
  host: HostRuntime = {
    execPath: process.execPath,
    nodeVersion: process.versions.node,
    electron: process.versions.electron,
  },
): PiLaunchDescription {
  const external = configured.trim();
  if (external) return { executablePath: external };
  if (!supportsBundledPi(host.nodeVersion)) {
    throw new Error(
      "Packaged Pi requires an Extension Host with Node.js 22.19 or newer. Update VS Code or select external Pi.",
    );
  }
  try {
    if (!extensionRoot || !path.isAbsolute(extensionRoot) || !path.isAbsolute(host.execPath)) throw new Error();
    const root = realpathSync(extensionRoot);
    const packageRoot = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent");
    const metadata = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    if (
      metadata.name !== packageName ||
      metadata.version !== bundledPiVersion ||
      metadata.bin?.pi !== "dist/bundle/cli.js" ||
      metadata.exports?.["."]?.import !== "./dist/index.js"
    )
      throw new Error();
    const bootstrap = path.join(root, "resources", "pi-runtime-bootstrap.cjs");
    const cli = path.join(packageRoot, "dist", "bundle", "cli.js");
    for (const file of [bootstrap, cli, path.join(packageRoot, "dist", "index.js")]) {
      const canonical = realpathSync(file);
      const relative = path.relative(root, canonical);
      if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !statSync(canonical).isFile()) {
        throw new Error();
      }
    }
    return {
      executablePath: host.execPath,
      executableArgs: [bootstrap, cli],
      env: {
        ...(host.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        PI_SKIP_VERSION_CHECK: "1",
      },
      unsetEnv: ["PI_PACKAGE_DIR", "PI_MANAGED_INSTALL_ROOT", ...(!host.electron ? ["ELECTRON_RUN_AS_NODE"] : [])],
    };
  } catch {
    throw new Error(
      "Packaged Pi is missing or invalid. Reinstall the extension or select an external Pi executable. No PATH fallback was attempted.",
    );
  }
}
