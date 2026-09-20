export interface DebugFrame {
  readonly id: number;
  readonly name: string;
  readonly line: number;
  readonly source?: string;
}
export interface DebugVariable {
  readonly name: string;
  readonly value: string;
}
export interface DebugSnapshot {
  readonly sessionId: string;
  readonly frameId: number;
  readonly capturedAt: number;
  readonly frames: readonly DebugFrame[];
  readonly variables: readonly DebugVariable[];
  readonly omitted: string[];
}
export class DebugPauseTracker {
  private states = new Map<string, { generation: number; paused: boolean }>();
  public observe(id: string, message: unknown): void {
    if (!record(message)) return;
    if (message.type === "event" && message.event === "stopped") {
      this.change(id, true);
      return;
    }
    if (
      (message.type === "event" && ["continued", "terminated", "exited"].includes(String(message.event))) ||
      (message.type === "request" &&
        [
          "continue",
          "next",
          "stepIn",
          "stepOut",
          "stepBack",
          "reverseContinue",
          "restart",
          "restartFrame",
          "disconnect",
          "terminate",
        ].includes(String(message.command)))
    )
      this.change(id, false);
  }
  public change(id: string, paused: boolean): void {
    this.states.set(id, { generation: (this.states.get(id)?.generation ?? 0) + 1, paused });
  }
  public token(id: string): number {
    const state = this.states.get(id);
    if (!state?.paused)
      throw new Error("Debugger is not in an observed paused generation. Pause again before capturing.");
    return state.generation;
  }
  public assert(id: string, generation: number): void {
    if (this.token(id) !== generation) throw new Error("Debug pause changed; discard this snapshot.");
  }
  public remove(id: string): void {
    this.states.delete(id);
  }
}
export function supportedDebugAdapter(type: string): boolean {
  return type === "pwa-node" || type === "node";
}
export async function captureDebug(options: {
  sessionId: string;
  frameId: number;
  threadId: number;
  assertCurrent: () => void;
  request: (command: "stackTrace" | "scopes" | "variables", args: Record<string, unknown>) => Promise<unknown>;
  timeoutMs?: number;
}): Promise<DebugSnapshot> {
  const deadline = Date.now() + (options.timeoutMs ?? 5_000);
  const request = async (command: "stackTrace" | "scopes" | "variables", args: Record<string, unknown>) => {
    options.assertCurrent();
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        options.request(command, args),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Debug capture exceeded its five-second deadline.")),
            Math.max(0, deadline - Date.now()),
          );
        }),
      ]);
      options.assertCurrent();
      if (!record(result)) throw new Error("Malformed debug adapter response.");
      return result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const stack = await request("stackTrace", { threadId: options.threadId, startFrame: 0, levels: 20 });
  if (!Array.isArray(stack.stackFrames)) throw new Error("Stack trace unavailable.");
  const frames: DebugFrame[] = stack.stackFrames.slice(0, 20).map((frame: unknown) => {
    if (
      !record(frame) ||
      !Number.isSafeInteger(frame.id) ||
      typeof frame.name !== "string" ||
      !Number.isSafeInteger(frame.line) ||
      Number(frame.line) < 1
    )
      throw new Error("Malformed debug stack frame.");
    return {
      id: Number(frame.id),
      name: frame.name.slice(0, 200),
      line: Number(frame.line),
      source:
        record(frame.source) && typeof frame.source.path === "string" ? frame.source.path.slice(0, 1000) : undefined,
    };
  });
  if (!frames.some((frame) => frame.id === options.frameId))
    throw new Error("Selected frame is outside the bounded stack snapshot.");
  const scopes = await request("scopes", { frameId: options.frameId });
  if (!Array.isArray(scopes.scopes)) throw new Error("Debug scopes unavailable.");
  const local = scopes.scopes
    .slice(0, 20)
    .find(
      (scope: unknown) =>
        record(scope) &&
        (scope.presentationHint === "locals" || scope.name === "Local") &&
        scope.expensive !== true &&
        Number.isSafeInteger(scope.variablesReference) &&
        Number(scope.variablesReference) > 0,
    );
  const variables: DebugVariable[] = [];
  const omitted: string[] = [
    "Only the selected frame's non-expensive local scope; no recursive expansion, lazy values, environment, launch configuration, or evaluate requests.",
  ];
  if (record(local)) {
    const result = await request("variables", { variablesReference: local.variablesReference, start: 0, count: 50 });
    if (!Array.isArray(result.variables)) throw new Error("Variables unavailable.");
    for (const item of result.variables.slice(0, 50)) {
      if (!record(item) || typeof item.name !== "string" || typeof item.value !== "string") {
        omitted.push("Malformed variable omitted");
        continue;
      }
      if (
        record(item.presentationHint) &&
        (item.presentationHint.lazy === true || item.presentationHint.kind === "virtual")
      ) {
        omitted.push("Lazy/virtual variable omitted");
        continue;
      }
      if (item.name === "process" || item.name === "env") {
        omitted.push("Environment container omitted");
        continue;
      }
      variables.push({ name: item.name.slice(0, 200), value: item.value.slice(0, 1000) });
    }
    if (result.variables.length > 50) omitted.push("Variable count limit");
  } else omitted.push("No supported local scope available");
  if (stack.stackFrames.length > 20 || Number(stack.totalFrames) > 20) omitted.push("Frame count limit");
  const snapshot = {
    sessionId: options.sessionId,
    frameId: options.frameId,
    capturedAt: Date.now(),
    frames,
    variables,
    omitted,
  };
  while (JSON.stringify(snapshot).length > 20_000 && variables.length) {
    variables.pop();
    if (!omitted.includes("Total character limit")) omitted.push("Total character limit");
  }
  while (JSON.stringify(snapshot).length > 20_000 && frames.length > 1) {
    const removable = frames.findIndex((frame) => frame.id !== options.frameId);
    frames.splice(removable, 1);
  }
  if (JSON.stringify(snapshot).length > 20_000) throw new Error("Debug snapshot exceeds its total character bound.");
  options.assertCurrent();
  return snapshot;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
