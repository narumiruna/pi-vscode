import { nativeObject } from "./nativePiJson";

export interface NativeSettingControl {
  readonly key: string;
  readonly label: string;
  readonly path: readonly string[];
  readonly defaultValue: unknown;
  readonly choices?: readonly string[];
  readonly effect: string;
}
const startup = "Saved for next controlled restart; resumed sessions and VS Code launch overrides can take precedence.";
export const nativeSettingControls: readonly NativeSettingControl[] = [
  { key: "defaultProvider", label: "Startup provider", path: ["defaultProvider"], defaultValue: "", effect: startup },
  { key: "defaultModel", label: "Startup model", path: ["defaultModel"], defaultValue: "", effect: startup },
  {
    key: "defaultThinkingLevel",
    label: "Startup thinking",
    path: ["defaultThinkingLevel"],
    defaultValue: "medium",
    choices: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    effect: startup,
  },
  {
    key: "enabledModels",
    label: "Startup/cycling model patterns (ordered; not access control)",
    path: ["enabledModels"],
    defaultValue: [],
    effect: `${startup} Exact IDs, fuzzy names, case-insensitive globs, provider/id and :thinking suffixes use Pi semantics. Zero matches are not validated here.`,
  },
  {
    key: "steeringMode",
    label: "Next instruction grouping",
    path: ["steeringMode"],
    defaultValue: "one-at-a-time",
    choices: ["one-at-a-time", "all"],
    effect: "File save applies on restart. Runtime setter also requests global persistence.",
  },
  {
    key: "followUpMode",
    label: "After this instruction grouping",
    path: ["followUpMode"],
    defaultValue: "one-at-a-time",
    choices: ["one-at-a-time", "all"],
    effect: "File save applies on restart. Runtime setter also requests global persistence.",
  },
  {
    key: "compaction.enabled",
    label: "Automatic compaction",
    path: ["compaction", "enabled"],
    defaultValue: true,
    choices: ["true", "false"],
    effect: "File save applies on restart. Runtime setter also requests global persistence.",
  },
  {
    key: "retry.enabled",
    label: "Automatic retry",
    path: ["retry", "enabled"],
    defaultValue: true,
    choices: ["true", "false"],
    effect:
      "File save applies on restart. Runtime setter also requests global persistence; RPC has no retry-state read.",
  },
];

export function nativeSettingValue(object: Record<string, unknown>, control: NativeSettingControl): unknown {
  let value: unknown = object;
  for (const key of control.path) value = nativeObject(value) ? value[key] : undefined;
  return value;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

export function validateNativeSetting(control: NativeSettingControl, value: unknown): void {
  if (value === undefined) return;
  if (control.key === "enabledModels") {
    if (
      !Array.isArray(value) ||
      value.length > 100 ||
      value.some(
        (item) =>
          typeof item !== "string" ||
          !item.trim() ||
          item.length > 256 ||
          hasControlCharacters(item) ||
          item.includes(","),
      )
    )
      throw new Error(
        "Use at most 100 nonempty model patterns, each at most 256 characters, without commas or control characters.",
      );
  } else if (typeof control.defaultValue === "boolean") {
    if (typeof value !== "boolean") throw new Error("Use true or false.");
  } else if (
    typeof value !== "string" ||
    value.length > 256 ||
    hasControlCharacters(value) ||
    (control.choices && !control.choices.includes(value))
  ) {
    throw new Error("Invalid native setting value.");
  }
}

export const mcpExposures = ["codemode", "deferred", "direct", "hidden", "codemode-deferred"] as const;
export function validMcpName(name: string): boolean {
  return /^[a-zA-Z0-9_-]{1,128}$/.test(name) && !["__proto__", "constructor", "prototype"].includes(name);
}
export interface McpMetadata {
  readonly name: string;
  readonly type: "stdio" | "http" | "override" | "invalid";
  readonly source: "global" | "project";
  readonly enabled: boolean;
  readonly exposure: string;
  readonly state: "unknown";
}
export function mcpMetadata(object: Record<string, unknown>, source: "global" | "project"): McpMetadata[] {
  if (object.mcpServers === undefined) return [];
  if (!nativeObject(object.mcpServers) || Object.keys(object.mcpServers).length > 100)
    throw new Error("MCP configuration must contain at most 100 servers.");
  return Object.entries(object.mcpServers).map(([name, value]) => {
    let valid = true;
    try {
      validateMcpEntry(name, value, source);
    } catch {
      valid = false;
    }
    const entry = nativeObject(value) ? value : {};
    return {
      name: validMcpName(name) ? name : "[invalid server name]",
      type: !valid ? "invalid" : entry.command ? "stdio" : entry.url ? "http" : "override",
      source,
      enabled: entry.enabled !== false,
      exposure:
        typeof entry.exposure === "string" && mcpExposures.includes(entry.exposure as (typeof mcpExposures)[number])
          ? entry.exposure
          : "codemode",
      state: "unknown",
    };
  });
}

/** Only metadata is returned. env, headers, URLs, commands and OAuth stay in the host. */
export function effectiveMcpMetadata(
  global: Record<string, unknown>,
  project: Record<string, unknown>,
  approved: boolean,
): McpMetadata[] {
  const result = new Map(mcpMetadata(global, "global").map((entry) => [entry.name, entry]));
  if (approved)
    for (const entry of mcpMetadata(project, "project")) {
      const raw = nativeObject(project.mcpServers) ? project.mcpServers[entry.name] : undefined;
      const base = result.get(entry.name);
      const override = nativeObject(raw) && !raw.command && !raw.url && !raw.type;
      result.set(
        entry.name,
        override && base
          ? {
              ...base,
              source: "project",
              enabled: typeof raw.enabled === "boolean" ? raw.enabled : base.enabled,
              exposure: typeof raw.exposure === "string" ? entry.exposure : base.exposure,
            }
          : entry,
      );
    }
  return [...result.values()];
}

export function validateMcpEntry(name: string, value: unknown, scope: "global" | "project"): void {
  if (!validMcpName(name) || !nativeObject(value)) throw new Error("Invalid MCP entry.");
  if (value.enabled !== undefined && typeof value.enabled !== "boolean")
    throw new Error("MCP enabled must be boolean.");
  const exposureValid = (item: unknown) =>
    typeof item === "string" && mcpExposures.includes(item as (typeof mcpExposures)[number]);
  if (value.exposure !== undefined && !exposureValid(value.exposure)) throw new Error("Unsupported MCP exposure.");
  if (
    value.toolExposure !== undefined &&
    (!nativeObject(value.toolExposure) ||
      Object.entries(value.toolExposure).length > 100 ||
      Object.entries(value.toolExposure).some(([key, item]) => key.length > 256 || !exposureValid(item)))
  )
    throw new Error("Invalid per-tool MCP exposure.");
  if (
    value.timeout !== undefined &&
    (typeof value.timeout !== "number" || !Number.isFinite(value.timeout) || value.timeout <= 0 || value.timeout > 3600)
  )
    throw new Error("Invalid MCP timeout.");
  if (value.command !== undefined) {
    if (
      typeof value.command !== "string" ||
      !value.command ||
      value.command.length > 4096 ||
      hasControlCharacters(value.command) ||
      value.url !== undefined ||
      (value.type !== undefined && value.type !== "stdio")
    )
      throw new Error("Invalid MCP stdio transport.");
    if (
      value.args !== undefined &&
      (!Array.isArray(value.args) ||
        value.args.length > 100 ||
        value.args.some((arg) => typeof arg !== "string" || arg.length > 4096 || arg.includes("\0")))
    )
      throw new Error("Invalid MCP arguments.");
  } else if (value.url !== undefined) {
    if (
      typeof value.url !== "string" ||
      value.url.length > 4096 ||
      (value.type !== undefined && value.type !== "http" && value.type !== "streamable-http")
    )
      throw new Error("Invalid MCP HTTP transport.");
    let url: URL;
    try {
      url = new URL(value.url);
    } catch {
      throw new Error("Invalid MCP HTTP URL.");
    }
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Invalid MCP HTTP URL.");
  } else if (
    scope !== "project" ||
    value.type !== undefined ||
    Object.keys(value).some((key) => !["enabled", "exposure", "toolExposure"].includes(key))
  )
    throw new Error("Only project metadata overrides can omit a transport.");
  for (const field of ["env", "headers"] as const)
    if (
      value[field] !== undefined &&
      (!nativeObject(value[field]) ||
        Object.entries(value[field]).length > 100 ||
        Object.entries(value[field]).some(
          ([key, item]) => key.length > 256 || typeof item !== "string" || item.length > 4096,
        ))
    )
      throw new Error("Invalid MCP environment/header map.");
  if (value.oauth !== undefined && !nativeObject(value.oauth)) throw new Error("Invalid MCP OAuth configuration.");
}

/** Public discovery proves ownership only with the built-in resource identity, never description text. */
export function nativeMcpCommandOwner(
  commands: readonly Record<string, unknown>[],
): "native" | "replacement" | "absent" {
  const found = commands.filter((command) => command.name === "mcp");
  if (!found.length) return "absent";
  if (found.length !== 1) return "replacement";
  const info = found[0].sourceInfo;
  return found[0].source === "extension" && nativeObject(info) && info.path === "builtin:mcp"
    ? "native"
    : "replacement";
}
