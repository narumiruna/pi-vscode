import path from "node:path";
import { digest } from "./gitSnapshots";
import type { ProcessResult } from "./boundedProcess";

export interface TestCommand { readonly executable: string; readonly args: readonly string[] }
export interface FailureSnapshot {
  readonly repository: string; readonly command: TestCommand; readonly exitCode: number | null;
  readonly output: string; readonly truncated: boolean; readonly capturedAt: number;
  readonly sources: readonly { readonly path: string; readonly hash: string }[];
  readonly status: ProcessResult["status"] | "supplied-log";
}
export function validateTestCommand(value: unknown): TestCommand {
  if (!value || typeof value !== "object") throw new Error("Enter a JSON executable/argument vector.");
  const command = value as TestCommand;
  if (typeof command.executable !== "string" || !command.executable || command.executable.length > 2_000 || command.executable.includes("\0")
    || (!path.isAbsolute(command.executable) && !/^[\w.-]+$/.test(command.executable))
    || /^(?:ba|da|z|fi|c|k)?sh(?:\.exe)?$|^(?:cmd|powershell|pwsh)(?:\.exe)?$/i.test(path.basename(command.executable))
    || !Array.isArray(command.args) || command.args.length > 100 || command.args.some(arg => typeof arg !== "string" || arg.includes("\0") || arg.length > 10_000)
    || JSON.stringify(command.args).length > 20_000) throw new Error("Use an explicit executable and bounded string arguments, not a shell expression.");
  return { executable: command.executable, args: [...command.args] };
}
export function boundedFailure(output: string, maxCharacters = 100_000): { output: string; truncated: boolean } {
  return { output: output.slice(0, maxCharacters), truncated: output.length > maxCharacters };
}
export function redactRecognizableSecrets(text: string): string {
  return text.replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g, "[REDACTED]")
    .replace(/((?:api[_-]?key|password|token)\s*[:=]\s*)["']?[^\s"']{8,}["']?/gi, "$1[REDACTED]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]");
}
export function noTestsMatched(output: string): boolean { return /no tests? (?:found|matched)|\b0 tests?\b/i.test(output); }
export class RepairAttempts {
  public attempts = 0;
  public stopped: string | undefined;
  private previous: string;
  public constructor(initialFailure: string) { this.previous = digest(initialFailure); }
  public approve(): void {
    if (this.stopped || this.attempts >= 2) throw new Error("Test repair is stopped or its two-attempt limit is exhausted.");
    this.attempts++;
  }
  public observe(exitCode: number | null, output: string, status: ProcessResult["status"]): void {
    if (status !== "exited") { this.stopped = status; return; }
    if (noTestsMatched(output)) { this.stopped = "No tests matched"; return; }
    if (exitCode === 0) { this.stopped = "Passed"; return; }
    const hash = digest(output);
    if (hash === this.previous) this.stopped = "Unchanged failure";
    else if (this.attempts >= 2) this.stopped = "Two repair attempts exhausted";
    this.previous = hash;
  }
  public stop(reason: string): void { this.stopped = reason; }
}
