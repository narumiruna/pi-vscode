export type SettingsTarget = "user" | "workspace";
export type SettingValue = string | number | boolean | string[];
export interface SettingDescriptor {
  key: string;
  category: "General" | "Permissions" | "Editor";
  label: string;
  description: string;
  type: "string" | "number" | "boolean" | "array";
  default: SettingValue;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  launch?: boolean;
}

export const settingsDescriptors: SettingDescriptor[] = [
  {
    key: "executablePath",
    category: "General",
    label: "Pi executable",
    description: "Path or command in the extension host environment. Opening Settings does not validate or run it.",
    type: "string",
    default: "pi",
    launch: true,
  },
  {
    key: "provider",
    category: "General",
    label: "Provider override",
    description: "Leave empty to use Pi settings. This is a launch default, not the current session provider.",
    type: "string",
    default: "",
    launch: true,
  },
  {
    key: "model",
    category: "General",
    label: "Model override",
    description: "Leave empty to use Pi settings. A resumed session can restore its own model.",
    type: "string",
    default: "",
    launch: true,
  },
  {
    key: "thinkingLevel",
    category: "General",
    label: "Thinking level override",
    description: "Default uses Pi settings. The chat control changes the current session separately.",
    type: "string",
    default: "default",
    enum: ["default", "off", "minimal", "low", "medium", "high", "xhigh", "max"],
    launch: true,
  },
  {
    key: "approveProjectResources",
    category: "Permissions",
    label: "Approve project resources",
    description:
      "Allow project-local Pi settings, extensions, skills, and prompts. Extensions execute with your permissions. Enable only for trusted projects.",
    type: "boolean",
    default: false,
    launch: true,
  },
  {
    key: "sensitiveContextNames",
    category: "Permissions",
    label: "Sensitive context names",
    description:
      "One filename fragment per line. Best-effort warnings on later attachment checks; inspect and redact before sending.",
    type: "array",
    default: [".env", "credential", "secret", "id_rsa", "id_ed25519"],
  },
  {
    key: "annotations.initialState",
    category: "Editor",
    label: "Annotation initial state",
    description:
      "Collapsed uses the VS Code API default. Expanded opens new explanations below the marked text. Changes affect only new or replaced annotations, not existing threads or shared Comments settings.",
    type: "string",
    default: "collapsed",
    enum: ["collapsed", "expanded"],
  },
  {
    key: "inlineCompletions.enabled",
    category: "Editor",
    label: "Automatic inline completion",
    description:
      "Request completions after a typing pause. Can consume model usage. Manual trigger remains available when disabled.",
    type: "boolean",
    default: false,
  },
  {
    key: "inlineCompletions.debounceMilliseconds",
    category: "Editor",
    label: "Completion delay (ms)",
    description: "Delay before an automatic completion request.",
    type: "number",
    default: 650,
    minimum: 100,
    maximum: 5000,
  },
  {
    key: "inlineCompletions.minimumPrefixLength",
    category: "Editor",
    label: "Minimum prefix length",
    description: "Minimum non-whitespace characters on the current line for automatic completion.",
    type: "number",
    default: 3,
    minimum: 0,
    maximum: 100,
  },
  {
    key: "inlineCompletions.excludedLanguages",
    category: "Editor",
    label: "Excluded languages",
    description:
      "One VS Code language ID per line. Changes affect later completion requests; in-flight requests and cached results can remain unchanged.",
    type: "array",
    default: ["plaintext", "scminput"],
  },
];

// Bounds apply only to edits through this page, not to existing configuration reads.
export const maxSettingText = 4096;
export const maxSettingItems = 100;
export const maxSettingsMessage = 32768;
export function serializedSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
export function validSettingValue(descriptor: SettingDescriptor, value: unknown): value is SettingValue {
  if (descriptor.type === "array") {
    return (
      Array.isArray(value) &&
      value.length <= maxSettingItems &&
      value.every((item) => typeof item === "string" && item.length <= maxSettingText && !/[\r\n\0]/.test(item)) &&
      serializedSize(value) <= maxSettingsMessage / 2
    );
  }
  if (descriptor.type === "number") {
    return (
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= (descriptor.minimum ?? -Infinity) &&
      value <= (descriptor.maximum ?? Infinity)
    );
  }
  if (descriptor.type === "boolean") return typeof value === "boolean";
  return (
    typeof value === "string" &&
    value.length <= maxSettingText &&
    !/[\r\n\0]/.test(value) &&
    (!descriptor.enum || descriptor.enum.includes(value))
  );
}
export interface SettingEntry {
  key: string;
  defaultValue: SettingValue;
  user?: SettingValue;
  workspace?: SettingValue;
  effective: SettingValue;
}
export interface SettingsSnapshot {
  type: "snapshot";
  revision: number;
  workspace: boolean;
  trusted: boolean;
  nativeFilesAvailable: boolean;
  remote: boolean;
  entries: SettingEntry[];
}
export function targetValue(entry: SettingEntry, target: SettingsTarget): SettingValue {
  return target === "user" ? (entry.user ?? entry.defaultValue) : (entry.workspace ?? entry.user ?? entry.defaultValue);
}
export function entryFingerprint(entry: SettingEntry): string {
  return JSON.stringify(entry);
}
