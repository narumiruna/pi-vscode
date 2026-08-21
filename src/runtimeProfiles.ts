export type PiAgentMode = "ask" | "edit" | "plan" | "agent";

export interface PiRuntimeProfile {
  readonly tools: readonly string[];
  readonly systemPrompt: string;
}

const profiles: Record<PiAgentMode, PiRuntimeProfile> = {
  ask: {
    tools: ["read", "grep", "find", "ls"],
    systemPrompt: "You are in Ask mode inside VS Code. Explore with read-only tools when useful. Never modify files or run shell commands.",
  },
  edit: {
    tools: ["read", "edit", "write", "grep", "find", "ls"],
    systemPrompt: "You are in Edit mode inside VS Code. Make requested file changes, but do not run shell commands. Keep edits focused and explain the result.",
  },
  plan: {
    tools: ["read", "grep", "find", "ls"],
    systemPrompt: "You are in Plan mode inside VS Code. Investigate with read-only tools, ask needed questions, and produce an executable plan. Do not modify files or run shell commands.",
  },
  agent: {
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    systemPrompt: "You are in Agent mode inside VS Code. Complete the task end to end, using tools to inspect, edit, execute, and verify the workspace. Report the completed outcome and checks.",
  },
};

export function getRuntimeProfile(mode: PiAgentMode): PiRuntimeProfile {
  return profiles[mode];
}

export function normalizeMode(value: string): PiAgentMode {
  return value === "agent" || value === "edit" || value === "plan" ? value : "ask";
}
