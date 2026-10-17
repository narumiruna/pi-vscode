import { closeSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";

const executableExtensions = [".exe", ".cmd", ".bat"];

export interface PiSpawnPlan {
  readonly command: string;
  readonly args: string[];
  readonly shell: false;
}

export interface PiSpawnEnvironment {
  platform?: NodeJS.Platform;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export function buildPiProcessEnvironment(
  base: NodeJS.ProcessEnv,
  overrides?: NodeJS.ProcessEnv,
  unset?: readonly string[],
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const keyOf = (key: string): string => (platform === "win32" ? key.toUpperCase() : key);
  for (const source of [base, overrides ?? {}, { NO_COLOR: "1" }]) {
    for (const [key, value] of Object.entries(source)) environment[keyOf(key)] = value;
  }
  for (const key of unset ?? []) delete environment[keyOf(key)];
  return environment;
}

function isFile(filename: string): boolean {
  try {
    return statSync(filename).isFile();
  } catch {
    return false;
  }
}

function windowsCandidates(filename: string): string[] {
  return path.win32.extname(filename) ? [filename] : executableExtensions.map((extension) => `${filename}${extension}`);
}

export function findWindowsExecutable(
  executablePath: string,
  pathEnv: string,
  cwd: string = process.cwd(),
): string | undefined {
  // C:foo and \\foo depend on drive state outside the launch contract.
  if (/^[a-z]:(?:[^\\/]|$)/i.test(executablePath) || /^[\\/](?![\\/])/.test(executablePath)) {
    throw new Error("Use a drive-qualified absolute path or a workspace-relative executable path.");
  }
  const qualified = /[\\/]/.test(executablePath) || /^[a-z]:/i.test(executablePath);
  const locations = qualified
    ? [path.win32.resolve(cwd, executablePath)]
    : pathEnv
        .split(";")
        .map((entry) => (entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry))
        .filter((directory) => directory.trim() !== "")
        .map((directory) => {
          if (/^[a-z]:(?:[^\\/]|$)/i.test(directory) || /^[\\/](?![\\/])/.test(directory)) {
            throw new Error("Use drive-qualified absolute or workspace-relative PATH directories.");
          }
          return path.win32.resolve(cwd, directory, executablePath);
        });
  for (const location of locations) {
    for (const candidate of windowsCandidates(location)) {
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

// Match the entire npm cmd-shim Node template. Never evaluate or partly interpret batch text.
// Shebang flags, variable assignments, and custom wrappers need an explicit native executable instead.
function npmShimTarget(filename: string): string {
  const fd = openSync(filename, "r");
  let text: string;
  try {
    const buffer = Buffer.alloc(16_385);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, bytes);
      if (count === 0) break;
      bytes += count;
    }
    if (bytes > 16_384) throw new Error("Batch shim exceeds the supported template size.");
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(buffer.subarray(0, bytes))
      .replace(/\r\n/g, "\n");
  } finally {
    closeSync(fd);
  }
  const target = /"%_prog%" {2}"%dp0%\\([^"\r\n%]+)" %\*\n$/.exec(text)?.[1];
  const expected = `@ECHO off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT /b\n:start\nSETLOCAL\nCALL :find_dp0\n\nIF EXIST "%dp0%\\node.exe" (\n  SET "_prog=%dp0%\\node.exe"\n) ELSE (\n  SET "_prog=node"\n  SET PATHEXT=%PATHEXT:;.JS;=;%\n)\n\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*\n`;
  if (!target || text !== expected || path.win32.isAbsolute(target) || /^[a-z]:/i.test(target)) {
    throw new Error("Unsupported Windows batch wrapper. Use a standard npm Node shim or a native .exe path.");
  }
  const script = path.win32.resolve(path.win32.dirname(filename), target);
  if (!isFile(script)) throw new Error("The npm shim's JavaScript entry point is missing.");
  return script;
}

export function planPiSpawn(
  executablePath: string,
  args: readonly string[] = [],
  environment: PiSpawnEnvironment = {},
): PiSpawnPlan {
  if ((environment.platform ?? process.platform) !== "win32") {
    return { command: executablePath, args: [...args], shell: false };
  }
  const cwd = environment.cwd ?? process.cwd();
  const env = buildPiProcessEnvironment(environment.env ?? process.env, undefined, undefined, "win32");
  const pathEnv = env.PATH ?? "";
  const resolved = findWindowsExecutable(executablePath, pathEnv, cwd);
  if (!resolved) throw new Error("Pi executable was not found in the child PATH or at the configured path.");
  if (/\.exe$/i.test(resolved)) return { command: resolved, args: [...args], shell: false };
  if (!/\.(cmd|bat)$/i.test(resolved)) throw new Error("Use a native .exe path or a standard npm Node shim.");
  const script = npmShimTarget(resolved);
  const adjacentNode = path.win32.join(path.win32.dirname(resolved), "node.exe");
  const node = isFile(adjacentNode) ? adjacentNode : findWindowsExecutable("node.exe", pathEnv, cwd);
  if (!node) throw new Error("The npm shim requires node.exe beside the shim or in the child PATH.");
  return { command: node, args: [script, ...args], shell: false };
}
