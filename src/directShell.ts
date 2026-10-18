import { stripVTControlCharacters } from "node:util";

export const shellCapabilityName = "vscode-pi-permission-ready";
export const shellPolicyTitle = "PI_VSCODE_DIRECT_SHELL_V1";
export const maxShellCommandCharacters = 8_000;
export const maxShellOutputCharacters = 64_000;
export const maxShellPolicyMessageCharacters = 40_000;
export const shellExecutionDeadlineMs = 60_000;
export const shellAbortDeadlineMs = 5_000;

export type ComposerInput =
  | { readonly kind: "prompt"; readonly text: string }
  | { readonly kind: "shell"; readonly command: string; readonly excludeFromContext: boolean };

/** Only column-one ! is executable. A leading backslash escapes exactly one !. */
export function parseComposerInput(text: string): ComposerInput {
  if (text.startsWith("\\!")) return { kind: "prompt", text: text.slice(1) };
  if (!text.startsWith("!")) return { kind: "prompt", text };
  const excludeFromContext = text.startsWith("!!");
  const command = text.slice(excludeFromContext ? 2 : 1);
  validateShellCommand(command);
  return { kind: "shell", command, excludeFromContext };
}

export function validateShellCommand(command: string): void {
  if (!command.trim()) throw new Error("Enter a command after ! or !!.");
  if (command.length > maxShellCommandCharacters)
    throw new Error(`Shell commands are limited to ${maxShellCommandCharacters} characters.`);
  if (/[\p{Cc}\p{Cf}]/u.test(command.replace(/[\n\r\t]/g, "")))
    throw new Error("Shell commands cannot contain terminal or hidden formatting controls.");
}

export interface ShellResult {
  readonly output: string;
  readonly exitCode?: number;
  readonly cancelled: boolean;
  readonly truncated: boolean;
}

/** Discard terminal controls, including bidi controls; output never becomes Markdown. */
export function cleanShellText(text: string): string {
  return stripVTControlCharacters(text).replace(/[\p{Cc}\p{Cf}]/gu, (character) =>
    character === "\n" || character === "\t" ? character : "",
  );
}

export function parseShellResult(value: unknown): ShellResult {
  if (
    !isRecord(value) ||
    typeof value.output !== "string" ||
    typeof value.cancelled !== "boolean" ||
    typeof value.truncated !== "boolean" ||
    (value.exitCode !== undefined && !Number.isSafeInteger(value.exitCode))
  )
    throw new Error("Invalid Pi shell result; execution may have occurred. Do not repeat the command.");
  return {
    output: cleanShellText(value.output).slice(-maxShellOutputCharacters),
    ...(typeof value.exitCode === "number" ? { exitCode: value.exitCode } : {}),
    cancelled: value.cancelled,
    truncated: value.truncated || value.output.length > maxShellOutputCharacters,
  };
}

export function shellMessageText(
  command: string,
  excludeFromContext: boolean,
  result: ShellResult,
  state: "running" | "finished" | "uncertain" = "finished",
): string {
  const status =
    state === "uncertain"
      ? "Execution uncertain. Inspect processes and effects; do not retry automatically."
      : state === "running"
        ? "Running"
        : result.cancelled
          ? "Cancelled"
          : `Exit: ${result.exitCode ?? "unknown"}`;
  return `Command: ${cleanShellText(command).slice(0, maxShellCommandCharacters)}\n${status}${result.truncated ? " · Output truncated" : ""}\n${excludeFromContext ? "Excluded from model context; retained in Pi history" : "Included in model context on the next prompt"}\nShell effects cannot be restored by request checkpoints.\n\n${result.output}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
