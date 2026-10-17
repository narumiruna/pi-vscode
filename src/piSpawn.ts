import { existsSync } from "node:fs";
import path from "node:path";

const executableExtensions = [".exe", ".cmd", ".bat"];

export interface PiSpawnPlan {
  readonly command: string;
  readonly args: string[];
  readonly shell: boolean;
}

export interface PiSpawnEnvironment {
  platform?: string;
  pathEnv?: string;
}

export function quoteWindowsCommandArgument(value: string): string {
  if (!value) {
    return '""';
  }
  const escaped = value.replace(/(\\+)(?="|$)/g, "$1$1").replace(/"/g, '""');
  return `"${escaped}"`;
}

export function buildWindowsShellCommand(command: string, args: string[]): string {
  return [command, ...args].map(quoteWindowsCommandArgument).join(" ");
}

function isExecutableExtension(name: string): boolean {
  return /\.(exe|cmd|bat)$/i.test(name);
}

function windowsCandidates(executablePath: string): string[] {
  if (isExecutableExtension(executablePath)) {
    return [executablePath];
  }
  return executableExtensions.map((extension) => `${executablePath}${extension}`);
}

export function findWindowsExecutable(executablePath: string, pathEnv: string): string | undefined {
  if (path.win32.isAbsolute(executablePath)) {
    for (const candidate of windowsCandidates(executablePath)) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }
  for (const directory of pathEnv.split(";")) {
    if (!directory) {
      continue;
    }
    for (const candidate of windowsCandidates(path.win32.join(directory, executablePath))) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

export function planPiSpawn(
  executablePath: string,
  args: readonly string[] = [],
  environment: PiSpawnEnvironment = {},
): PiSpawnPlan {
  const platform = environment.platform ?? process.platform;
  if (platform === "win32") {
    const resolved = findWindowsExecutable(executablePath, environment.pathEnv ?? process.env.PATH ?? "");
    if (resolved) {
      if (/\.(cmd|bat)$/i.test(resolved)) {
        return {
          command: buildWindowsShellCommand(resolved, [...args]),
          args: [],
          shell: true,
        };
      }
      return { command: resolved, args: [...args], shell: false };
    }
  }
  return { command: executablePath, args: [...args], shell: false };
}
