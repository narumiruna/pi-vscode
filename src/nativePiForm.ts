import { createHash } from "node:crypto";
import * as vscode from "vscode";
import { type NativeFilePair, NativePiAccess } from "./nativePiAccess";
import type { NativeScope } from "./nativePiFiles";
import {
  maxNativeProjectionBytes,
  type NativeFormSnapshot,
  projectNativeMcp,
  projectNativeSettings,
} from "./nativePiFormModel";
import { nativeObject } from "./nativePiJson";
import {
  mcpExposures,
  nativeSettingControls,
  validateMcpEntry,
  validateNativeSetting,
  validMcpName,
} from "./nativePiModel";
import type { PiRuntimeManager } from "./piRuntime";
import { serializedSize } from "./settingsModel";

interface FormState {
  settings: NativeFilePair;
  mcp: NativeFilePair;
  snapshot: NativeFormSnapshot;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const unavailable =
  "Native configuration could not be read or saved. Reload before retrying; inspect the file after a write error.";
const conflict = "Native configuration changed. Draft retained; reload this row before saving.";
class NativeFormConflict extends Error {}

/** Full file snapshots and guards never leave this host-owned controller. */
export class NativePiForm {
  private readonly access: NativePiAccess;
  private readonly states = new Map<NativeScope, FormState>();
  private generation = 0;

  public constructor(
    private readonly runtime: PiRuntimeManager,
    private readonly active: () => boolean,
  ) {
    this.access = new NativePiAccess(runtime, () => !active());
  }

  public supersede(): number {
    return ++this.generation;
  }

  public get currentGeneration(): number {
    return this.generation;
  }

  public invalidate(): void {
    this.generation++;
    this.states.clear();
  }

  private async capture(scope: NativeScope, id: string): Promise<FormState> {
    const settings = await this.access.files("settings");
    const mcp = await this.access.files("mcp");
    await settings.assertOrigin();
    await settings.assertEditors(vscode.workspace.textDocuments);
    const origin = hash([
      vscode.workspace.workspaceFolders?.[0]?.uri.toString(),
      settings.root,
      settings.agentDir,
      settings.approved,
      process.env.PI_CODING_AGENT_DIR,
    ]);
    const revision = hash([
      origin,
      scope,
      settings.global.revision,
      settings.project.revision,
      mcp.global.revision,
      mcp.project.revision,
    ]);
    const snapshot: NativeFormSnapshot = {
      type: "nativeSnapshot",
      id,
      scope,
      origin,
      revision,
      approved: settings.approved,
      entries: projectNativeSettings(settings.global.value, settings.project.value, scope),
      servers: projectNativeMcp(mcp.global.value, mcp.project.value, scope),
    };
    if (serializedSize(snapshot) > maxNativeProjectionBytes) throw new Error("Native projection exceeds its limit.");
    return { settings, mcp, snapshot };
  }

  public async handle(
    message: Record<string, unknown>,
    generation: number,
    post: (message: unknown) => void,
  ): Promise<void> {
    const id = message.id;
    if (typeof id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) return;
    const current = () => this.active() && generation === this.generation;
    const result = (ok: boolean, error?: string) => {
      if (current()) post({ type: "nativeResult", id, ok, ...(error ? { error } : {}) });
    };
    try {
      const allowed =
        message.type === "nativeLoad"
          ? ["type", "id", "scope"]
          : ["type", "id", "scope", "revision", "key", "server", ...(message.type === "nativeSave" ? ["value"] : [])];
      if (Object.keys(message).some((key) => !allowed.includes(key))) throw new Error("Invalid request fields.");
      if (message.scope !== "global" && message.scope !== "project") throw new Error("Invalid scope.");
      const scope = message.scope;
      await this.runtime.withWorkspaceOperation("editing native Pi configuration", async (assertCurrent) => {
        const guard = async () => {
          if (!current()) throw new Error("Expired native form.");
          await assertCurrent();
          if (!current()) throw new Error("Expired native form.");
        };
        await guard();
        const fresh = await this.capture(scope, id);
        await guard();
        if (message.type !== "nativeLoad") {
          if (message.type !== "nativeSave" && message.type !== "nativeReset") throw new Error("Invalid action.");
          const previous = this.states.get(scope);
          if (
            !previous ||
            message.revision !== previous.snapshot.revision ||
            fresh.snapshot.revision !== previous.snapshot.revision
          )
            throw new NativeFormConflict();
          for (const pair of [previous.settings, previous.mcp]) {
            await pair.assertOrigin();
            await pair.assertEditors(vscode.workspace.textDocuments);
          }
          const reset = message.type === "nativeReset";
          const value = reset ? undefined : message.value;
          if (message.server === undefined) {
            const control = nativeSettingControls.find((entry) => entry.key === message.key);
            if (!control || (!reset && value === undefined)) throw new Error("Invalid native setting.");
            validateNativeSetting(control, value);
            await this.access.write(previous.settings, previous.settings[scope], control.path, value, guard);
          } else {
            const name = message.server;
            const key = message.key;
            if (
              typeof name !== "string" ||
              !validMcpName(name) ||
              (key !== "enabled" && key !== "exposure") ||
              !previous.snapshot.servers.some((server) => server.name === name && server.fields.length > 0)
            )
              throw new Error("Invalid MCP field.");
            if (
              !reset &&
              (key === "enabled"
                ? typeof value !== "boolean"
                : typeof value !== "string" || !mcpExposures.includes(value as (typeof mcpExposures)[number]))
            )
              throw new Error("Invalid MCP value.");
            const pair = previous.mcp;
            const servers = pair[scope].value.mcpServers;
            const own = nativeObject(servers) && nativeObject(servers[name]) ? servers[name] : {};
            const next = { ...own };
            if (reset) delete next[key];
            else next[key] = value;
            // Removing the last metadata override must restore inheritance, not leave an invalid empty entry.
            const remove = reset && Object.keys(next).length === 0;
            if (!remove) validateMcpEntry(name, next, scope);
            if (remove) await this.access.write(pair, pair[scope], ["mcpServers", name], undefined, guard);
            else await this.access.write(pair, pair[scope], ["mcpServers", name, key], value, guard);
          }
        }
        await guard();
        const loaded = message.type === "nativeLoad" ? fresh : await this.capture(scope, id);
        await guard();
        this.states.set(scope, loaded);
        post(loaded.snapshot);
        result(true);
      });
    } catch (error) {
      result(false, error instanceof NativeFormConflict ? conflict : unavailable);
    }
  }
}
