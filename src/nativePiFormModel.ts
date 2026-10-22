import { nativeObject } from "./nativePiJson";
import type { NativeScope } from "./nativePiModel";
import {
  effectiveMcpMetadata,
  type McpMetadata,
  mcpExposures,
  nativeSettingControls,
  nativeSettingValue,
  validateNativeSetting,
  validMcpName,
} from "./nativePiModel";

// Native reads can project more than one bounded file; browser requests remain capped at 32 KiB.
export const maxNativeProjectionBytes = 512 * 1024;
export type NativeFormValue = string | boolean | string[];
export interface NativeFormEntry {
  key: string;
  own?: NativeFormValue;
  inherited: NativeFormValue;
  value: NativeFormValue;
  source: "global" | "project" | "default";
  hasOverride: boolean;
  invalid: boolean;
  inheritedInvalid: boolean;
}
export interface NativeMcpFormEntry extends McpMetadata {
  fields: NativeFormEntry[];
}
export interface NativeFormSnapshot {
  type: "nativeSnapshot";
  id: string;
  scope: NativeScope;
  revision: string;
  origin: string;
  approved: boolean;
  entries: NativeFormEntry[];
  servers: NativeMcpFormEntry[];
}
export function projectNativeMcp(
  global: Record<string, unknown>,
  project: Record<string, unknown>,
  scope: NativeScope,
): NativeMcpFormEntry[] {
  const ownServers = scope === "global" ? global.mcpServers : project.mcpServers;
  const globalServers = global.mcpServers;
  return effectiveMcpMetadata(global, project, scope === "project").map((metadata) => {
    if (!validMcpName(metadata.name) || metadata.type === "invalid") return { ...metadata, fields: [] };
    const ownValue = nativeObject(ownServers) ? ownServers[metadata.name] : undefined;
    const own = nativeObject(ownValue) ? ownValue : {};
    const baseValue = scope === "project" && nativeObject(globalServers) ? globalServers[metadata.name] : undefined;
    const base = nativeObject(baseValue) ? baseValue : {};
    // A project transport replaces the global transport and all its metadata.
    const replaces =
      scope === "project" && (own.command !== undefined || own.url !== undefined || own.type !== undefined);
    const fields = ["enabled", "exposure"].map((key): NativeFormEntry => {
      const defaultValue = key === "enabled" ? true : "codemode";
      const valid = (value: unknown) =>
        value === undefined ||
        (key === "enabled"
          ? typeof value === "boolean"
          : typeof value === "string" && mcpExposures.includes(value as (typeof mcpExposures)[number]));
      const baseValue = !replaces && scope === "project" ? base[key] : undefined;
      const inheritedInvalid = !valid(baseValue);
      const inherited = baseValue !== undefined && !inheritedInvalid ? baseValue : defaultValue;
      const value = own[key];
      const invalid = !valid(value);
      return {
        key,
        ...(value !== undefined && !invalid ? { own: value as NativeFormValue } : {}),
        inherited: inherited as NativeFormValue,
        value: value !== undefined && !invalid ? (value as NativeFormValue) : (inherited as NativeFormValue),
        source: value !== undefined ? scope : baseValue !== undefined ? "global" : "default",
        hasOverride: value !== undefined,
        invalid,
        inheritedInvalid,
      };
    });
    return { ...metadata, fields };
  });
}

export type NativeFormRequest =
  | { type: "nativeLoad"; id: string; scope: NativeScope }
  | {
      type: "nativeSave" | "nativeReset";
      id: string;
      scope: NativeScope;
      revision: string;
      key: string;
      server?: string;
      value?: NativeFormValue;
    };

/** Project only validated common values; never return raw objects or invalid input. */
export function projectNativeSettings(
  global: Record<string, unknown>,
  project: Record<string, unknown>,
  scope: NativeScope,
): NativeFormEntry[] {
  return nativeSettingControls.map((control) => {
    const selected = scope === "global" ? global : project;
    const own = nativeSettingValue(selected, control);
    const base = scope === "project" ? nativeSettingValue(global, control) : undefined;
    const invalidParent = (object: Record<string, unknown>) => {
      let parent: unknown = object;
      for (const key of control.path.slice(0, -1)) {
        if (!nativeObject(parent)) return true;
        parent = parent[key];
        if (parent === undefined) return false;
      }
      return !nativeObject(parent);
    };
    const ownParentInvalid = invalidParent(selected);
    const baseParentInvalid = scope === "project" && invalidParent(global);
    const valid = (value: unknown) => {
      try {
        validateNativeSetting(control, value);
        return true;
      } catch {
        return false;
      }
    };
    const invalid = ownParentInvalid || !valid(own);
    const inheritedInvalid = baseParentInvalid || !valid(base);
    const inherited = (base !== undefined && !inheritedInvalid ? base : control.defaultValue) as NativeFormValue;
    return {
      key: control.key,
      ...(own !== undefined && !invalid ? { own: own as NativeFormValue } : {}),
      inherited,
      value: own !== undefined && !invalid ? (own as NativeFormValue) : inherited,
      source:
        own !== undefined || ownParentInvalid ? scope : base !== undefined || baseParentInvalid ? "global" : "default",
      hasOverride: own !== undefined || ownParentInvalid,
      invalid,
      inheritedInvalid,
    };
  });
}
