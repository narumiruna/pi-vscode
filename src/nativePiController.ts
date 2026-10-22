import path from "node:path";
import * as vscode from "vscode";
import { piConfiguration } from "./configuration";
import { checkNativeMcp, type McpDiagnostic } from "./nativeMcpDiagnostics";
import { type NativeFilePair, NativePiAccess } from "./nativePiAccess";
import { type NativeFileSnapshot, type NativeScope, readNativeFile } from "./nativePiFiles";
import { nativeObject } from "./nativePiJson";
import {
  effectiveMcpMetadata,
  mcpExposures,
  mcpMetadata,
  type NativeSettingControl,
  nativeMcpCommandOwner,
  nativeSettingControls,
  nativeSettingValue,
  validateMcpEntry,
  validateNativeSetting,
  validMcpName,
} from "./nativePiModel";
import { NativeRuntimeControlAppliedError, type PiRuntimeManager } from "./piRuntime";
import { readPiInvocationOptions } from "./vscodePi";

interface Choice extends vscode.QuickPickItem {
  readonly action: string;
}
async function choose(items: readonly Choice[], title: string): Promise<string | undefined> {
  return (await vscode.window.showQuickPick(items, { title, matchOnDetail: true, ignoreFocusOut: true }))?.action;
}
async function confirm(message: string, label = "Save only"): Promise<boolean> {
  return (await vscode.window.showWarningMessage(message, { modal: true }, label)) === label;
}
function visibleValue(value: unknown): string {
  if (value === undefined) return "not set";
  if (typeof value === "string")
    return [...value.slice(0, 256)]
      .map((character) => (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? " " : character))
      .join("");
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value) && value.every((item) => typeof item === "string"))
    return `${value.length} ordered patterns`;
  return "invalid value; use advanced native editor";
}

function nativeScope(value: unknown): NativeScope | undefined {
  if (value === undefined || value === "global" || value === "project") return value;
  throw new Error("Invalid native configuration scope.");
}
function scopeLabel(scope: NativeScope): string {
  return scope === "global" ? "Global Pi" : "Project Pi";
}

/** Native host dialogs only. No browser receives native file text, env, headers, OAuth or commands. */
export function registerNativePiManagement(context: vscode.ExtensionContext, runtime: PiRuntimeManager): void {
  let disposed = false;
  let lastDiagnostic: McpDiagnostic | undefined;
  let lastDiagnosticOrigin: string | undefined;
  const controllers = new Set<AbortController>();
  const register = (id: string, action: (scope?: unknown) => Promise<void>) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (scope?: unknown) => {
        if (disposed) return;
        try {
          await action(scope);
        } catch (error) {
          if (error instanceof NativeRuntimeControlAppliedError) {
            void vscode.window.showErrorMessage(
              "Pi acknowledged the runtime change, but current-state verification failed. Global persistence is unverified. Check the active runtime and file before retrying.",
            );
            return;
          }
          // Do not display filesystem, JSON-parser, server or credential-command output.
          void vscode.window.showErrorMessage(
            "Native Pi operation did not complete. The target may have changed, be read-only, or be unsupported. Reload the native surface before retrying; check the file after a write error.",
          );
        }
      }),
    );
  context.subscriptions.push({
    dispose: () => {
      disposed = true;
      for (const controller of controllers) controller.abort();
      controllers.clear();
      lastDiagnostic = undefined;
      lastDiagnosticOrigin = undefined;
    },
  });

  const access = new NativePiAccess(runtime, () => disposed);
  const files = (kind: "settings" | "mcp") => access.files(kind);
  const selectScope = () =>
    choose(
      [
        {
          label: "Global Pi",
          detail: "Agent-directory file on the Extension Host (remote host in remote windows).",
          action: "global",
        },
        {
          label: "Project Pi",
          detail: "Current workspace .pi file. Save does not approve project resources.",
          action: "project",
        },
      ],
      "Native Pi file target — not VS Code pi.* settings",
    ) as Promise<NativeScope | undefined>;

  const write = async (
    state: NativeFilePair,
    snapshot: NativeFileSnapshot,
    keys: readonly string[],
    value: unknown,
    guard: () => Promise<void>,
  ) => {
    await access.write(state, snapshot, keys, value, guard);
    void vscode.window.showInformationMessage(
      "Native file saved. Active foreground and background runtimes are unchanged. Apply is a separate command; startup model preferences require restart.",
    );
  };

  const openAdvanced = async (target: NativeFileSnapshot, assertCurrent: () => Promise<void>) => {
    if (!target.exists) {
      void vscode.window.showInformationMessage(
        "Create an override with a validated control first, then open the native editor.",
      );
      return;
    }
    if (
      !(await confirm(
        "Open the native configuration file in VS Code? It may contain secrets or executable resource definitions. Native editor Save does not use the bounded controls. No Pi process starts.",
        "Open native file",
      ))
    )
      return;
    await assertCurrent();
    if ((await readNativeFile(target.target)).revision !== target.revision) throw new Error("Native file changed.");
    await assertCurrent();
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(target.target.root, target.target.relative)));
  };

  register("pi.openNativeSettings", async (input) => {
    const requestedScope = nativeScope(input);
    await runtime.withWorkspaceOperation("editing native Pi settings", async (assertCurrent) => {
      const state = await files("settings");
      const scope = requestedScope ?? (await selectScope());
      if (!scope) return;
      const target = state[scope];
      const action = await choose(
        [
          ...nativeSettingControls.map((control) => {
            const own = nativeSettingValue(target.value, control);
            const inherited = scope === "project" ? nativeSettingValue(state.global.value, control) : undefined;
            return {
              label: control.label,
              description: visibleValue(own),
              detail: `${scope} override: ${visibleValue(own)}; inherited/default: ${visibleValue(inherited ?? control.defaultValue)}. ${scope === "project" && !state.approved ? "Project resources are NOT approved; values are inactive. " : ""}${control.effect}`,
              action: control.key,
            };
          }),
          {
            label: "Advanced native configuration editor…",
            detail:
              "Explicit native file editor; may contain secrets and executable resources. Normal editor Save is independent of these validated controls.",
            action: "advanced",
          },
        ],
        `Native Pi settings — ${scopeLabel(scope)} — saved defaults, not current runtime state`,
      );
      if (!action) return;
      if (action === "advanced") {
        await openAdvanced(target, assertCurrent);
        return;
      }
      const control = nativeSettingControls.find((item) => item.key === action);
      if (!control) return;
      const operation = await choose(
        [
          { label: "Edit selected override", action: "edit" },
          {
            label: "Reset selected override only",
            detail: "Keep inherited values and all other keys.",
            action: "reset",
          },
        ],
        control.label,
      );
      if (!operation) return;
      let value: unknown;
      if (operation === "edit") {
        const input = await inputSetting(control, nativeSettingValue(target.value, control));
        if (input === undefined) return;
        value = input;
      }
      validateNativeSetting(control, value);
      if (
        !(await confirm(
          `Save only ${control.label} in ${scopeLabel(scope)} settings? No reload, process, installation or project approval is performed.`,
        ))
      )
        return;
      await assertCurrent();
      await write(state, target, control.path, value, assertCurrent);
    });
  });

  register("pi.openNativeMcp", async (input) => {
    const requestedScope = nativeScope(input);
    let terminalOrigin: (() => Promise<void>) | undefined;
    await runtime.withWorkspaceOperation("managing native MCP configuration", async (assertCurrent) => {
      const state = await files("mcp");
      const diagnosticOrigin = JSON.stringify([
        state.root,
        state.agentDir,
        state.global.revision,
        state.project.revision,
        state.approved,
      ]);
      const diagnosticIsCurrent = lastDiagnosticOrigin === diagnosticOrigin;
      // A scoped project editor must also show saved, inactive project entries.
      const metadata =
        requestedScope === "global"
          ? mcpMetadata(state.global.value, "global")
          : effectiveMcpMetadata(
              state.global.value,
              state.project.value,
              requestedScope === "project" || state.approved,
            );
      const action = await choose(
        [
          ...metadata.map((server) => ({
            label: server.name,
            description: `${server.type} · ${server.source} · ${server.enabled ? "enabled" : "disabled"} · ${server.exposure}`,
            detail:
              "Configured only. Current connection: unknown. Server annotations are unverified; Pi and installed extensions control tool permissions.",
            action: `server:${server.name}`,
          })),
          {
            label: "Add server…",
            detail: "Passive file edit. Secret entry stays in Pi; no connection is started.",
            action: "add",
          },
          {
            label: "Advanced native configuration editor…",
            detail:
              "Open the selected scope's mcp.json in VS Code. It may contain secrets; normal editor Save applies.",
            action: "advanced",
          },
          {
            label: "Explicit CLI connection diagnostic…",
            detail:
              "Connects all enabled file-configured servers; may execute local servers and credential commands or access the network. Separate from the current session.",
            action: "check",
          },
          {
            label: "Last explicit CLI diagnostic",
            detail: lastDiagnostic
              ? `${lastDiagnostic.checkedAt}: ${lastDiagnostic.outcome}. ${diagnosticIsCurrent ? "Matching captured file revisions." : "Stale: workspace/configuration changed."} Not current-session evidence.`
              : "No diagnostic has run.",
            action: "last",
          },
          {
            label: "Interactive MCP management / sign-in / sign-out in Pi Terminal…",
            detail: `Current /mcp owner: ${nativeMcpCommandOwner(runtime.currentState.commands)}. No terminal command is injected.`,
            action: "terminal",
          },
        ],
        `Native MCP — ${requestedScope ? scopeLabel(requestedScope) : "effective"} — passive configured overview${state.approved ? "" : "; project configuration not approved"}`,
      );
      if (!action) return;
      if (action === "terminal") {
        if (nativeMcpCommandOwner(runtime.currentState.commands) !== "native") {
          void vscode.window.showInformationMessage(
            "Native /mcp ownership is not verified. Start Pi explicitly and refresh command discovery first. Replacement commands are not treated as native MCP.",
          );
          return;
        }
        if (
          await confirm(
            "Transfer control to Pi Terminal? Type /mcp there for native management, login or logout. Pi owns OAuth and redirect handling; logout deletes stored Pi credentials, not provider-side revocation.",
            "Open Pi Terminal",
          )
        ) {
          await assertCurrent();
          terminalOrigin = async () => {
            await assertCurrent();
            if (disposed || nativeMcpCommandOwner(runtime.currentState.commands) !== "native")
              throw new Error("Native MCP origin changed.");
          };
        }
        return;
      }
      if (action === "last") {
        if (lastDiagnostic && !diagnosticIsCurrent) {
          void vscode.window.showInformationMessage(
            "The last MCP CLI diagnostic belongs to a different workspace or file revision. Run a fresh explicit diagnostic; current-session state is still unknown.",
          );
          return;
        }
        const diagnostic = lastDiagnostic;
        if (diagnostic)
          await vscode.window.showQuickPick(
            diagnostic.servers.map((server) => ({
              label: server.name,
              description: `${server.state}, ${server.toolCount} tools`,
              detail: `${diagnostic.checkedAt}; separate CLI only. ${diagnostic.cleanup}`,
            })),
            { title: "Last CLI diagnostic — not current-session state" },
          );
        return;
      }
      if (action === "check") {
        if (state.project.exists && !state.approved) {
          void vscode.window.showInformationMessage(
            "The CLI uses saved native Pi trust, not the VS Code project-resource switch. Diagnostics are blocked while a project MCP file exists without explicit project-resource approval.",
          );
          return;
        }
        if (
          !(await confirm(
            "Run pi mcp list --json on this Extension Host? This connects EVERY enabled file-configured server, can execute server/credential commands and access networks. Native saved Pi trust decides whether project entries load. The current Pi session is unchanged.",
            "Run connection diagnostic",
          ))
        )
          return;
        await assertCurrent();
        if (
          (await readNativeFile(state.global.target)).revision !== state.global.revision ||
          (await readNativeFile(state.project.target)).revision !== state.project.revision ||
          state.approved !== piConfiguration().get<boolean>("approveProjectResources", false)
        )
          throw new Error("Configuration changed.");
        const controller = new AbortController();
        controllers.add(controller);
        try {
          const result = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: "Pi MCP: separate CLI connection diagnostic (30-second deadline)",
              cancellable: true,
            },
            async (_progress, token) => {
              const cancellation = token.onCancellationRequested(() => controller.abort());
              try {
                return await checkNativeMcp(readPiInvocationOptions().executablePath, state.cwd, controller.signal);
              } finally {
                cancellation.dispose();
              }
            },
          );
          await assertCurrent();
          if (
            (await readNativeFile(state.global.target)).revision !== state.global.revision ||
            (await readNativeFile(state.project.target)).revision !== state.project.revision
          )
            throw new Error("MCP files changed during diagnostic.");
          if (!disposed) {
            lastDiagnostic = result;
            lastDiagnosticOrigin = diagnosticOrigin;
          }
          void vscode.window.showInformationMessage(
            `Separate MCP CLI diagnostic: ${result.outcome}; ${result.servers.length} servers reported. Current-session state remains unknown. ${result.cleanup}`,
          );
        } finally {
          controllers.delete(controller);
        }
        return;
      }
      const scope = requestedScope ?? (await selectScope());
      if (!scope) return;
      const target = state[scope];
      if (action === "advanced") {
        await openAdvanced(target, assertCurrent);
        return;
      }
      const name =
        action === "add"
          ? await vscode.window.showInputBox({
              title: "Native MCP server name",
              prompt: "Letters, digits, _ and - only (maximum 128).",
              validateInput: (value) => (validMcpName(value) ? undefined : "Invalid server name."),
            })
          : action.slice(7);
      if (!name || !validMcpName(name)) return;
      const entries = nativeObject(target.value.mcpServers) ? target.value.mcpServers : {};
      if (
        Object.keys(entries).some((other) => other !== name && other.replaceAll("-", "_") === name.replaceAll("-", "_"))
      )
        throw new Error("Server name collision.");
      const current = entries[name];
      const operation =
        action === "add"
          ? "edit"
          : await choose(
              [
                { label: "Enable", action: "enable" },
                { label: "Disable", action: "disable" },
                { label: "Set tool exposure", action: "exposure" },
                { label: "Edit transport (keep secret values unchanged)", action: "edit" },
                {
                  label: "Remove this scope's override only",
                  detail: "Global servers and stored auth are retained when removing a project override.",
                  action: "remove",
                },
              ],
              `${name} — ${scopeLabel(scope)} file`,
            );
      if (!operation) return;
      let value: unknown = nativeObject(current) ? { ...current } : {};
      if (operation === "remove") value = undefined;
      else if (operation === "edit") {
        const transport = await choose(
          [
            { label: "stdio executable", action: "stdio" },
            { label: "Streamable HTTP URL", action: "http" },
          ],
          "MCP transport — saving never connects",
        );
        if (!transport) return;
        if (transport === "stdio") {
          const command = await vscode.window.showInputBox({
            title: "MCP executable (not a shell expression)",
            value: nativeObject(current) && typeof current.command === "string" ? current.command : "",
            prompt: "No credentials. Use native Pi workflows for secret entry.",
          });
          if (!command) return;
          const args = await vscode.window.showInputBox({
            title: "MCP argument array (JSON)",
            value: "[]",
            prompt:
              "No literal credentials. Existing env and authentication fields are kept when transport is unchanged.",
          });
          if (args === undefined || args.length > 16 * 1024) return;
          value = { ...(nativeObject(current) && current.command ? current : {}), command, args: JSON.parse(args) };
        } else {
          const url = await vscode.window.showInputBox({
            title: "MCP HTTP URL",
            prompt: "No user info, query, fragment or credentials. Secret entry stays in Pi.",
          });
          if (!url) return;
          const parsed = new URL(url);
          if (parsed.username || parsed.password || parsed.search || parsed.hash)
            throw new Error("Use a credential-free URL.");
          value = { ...(nativeObject(current) && current.url ? current : {}), url };
        }
      } else if (nativeObject(value)) {
        if (operation === "enable" || operation === "disable") value.enabled = operation === "enable";
        else {
          const exposure = await vscode.window.showQuickPick([...mcpExposures], {
            title: "MCP server tool exposure (not tool permission)",
          });
          if (!exposure) return;
          value.exposure = exposure;
        }
      }
      if (value !== undefined) validateMcpEntry(name, value, scope);
      if (
        !(await confirm(
          `${operation === "remove" ? "Remove only" : "Save only"} ${name} in ${scopeLabel(scope)} MCP configuration? ${scope === "project" ? "This can override or reveal an inherited global server; project approval is unchanged. " : ""}No server connects and stored authentication is unchanged.`,
        ))
      )
        return;
      await assertCurrent();
      await write(state, target, ["mcpServers", name], value, assertCurrent);
    });
    if (terminalOrigin) await runtime.openInTerminal(terminalOrigin);
  });

  register("pi.applyNativeConfiguration", async () => {
    try {
      // reloadResources owns its approval and generation guard. false means cancelled.
      if (!(await runtime.reloadResources())) return;
      void vscode.window.showInformationMessage(
        "Resource reload completed. Startup defaults and scoped-model patterns are not live-applied.",
      );
    } catch {
      void vscode.window.showErrorMessage(
        "Saved files are retained, but runtime apply failed. The active configuration is not verified. Retry Apply explicitly; do not restore old files over newer edits.",
      );
    }
  });

  register("pi.nativeRuntimeControls", async () => {
    if (!runtime.currentState.connected) {
      void vscode.window.showInformationMessage(
        "Start Pi explicitly before opening native runtime controls. Native file settings remain available without starting Pi.",
      );
      return;
    }
    const applied = await runtime.configureNativeRuntimeControl(async (assertCurrent) => {
      const controls = nativeSettingControls.filter((control) =>
        ["steeringMode", "followUpMode", "compaction.enabled", "retry.enabled"].includes(control.key),
      );
      const key = await choose(
        controls.map((control) => ({
          label: control.label,
          detail:
            "Apply now to idle foreground Pi AND request GLOBAL Pi defaults save. Disk persistence is not verified by RPC. Not session-only.",
          action: control.key,
        })),
        "Native runtime controls — global persistence requested",
      );
      if (!key) return;
      const control = controls.find((item) => item.key === key);
      if (!control) return;
      const value = await inputSetting(control, undefined);
      if (
        value === undefined ||
        !(await confirm(
          "Change the idle foreground runtime and request a GLOBAL Pi settings save? RPC does not confirm disk durability. Project overrides can take precedence after restart.",
          "Apply runtime control",
        ))
      )
        return;
      await assertCurrent();
      if (key !== "steeringMode" && key !== "followUpMode" && key !== "compaction.enabled" && key !== "retry.enabled")
        throw new Error("Unsupported native runtime control.");
      if (typeof value !== "boolean" && value !== "all" && value !== "one-at-a-time")
        throw new Error("Invalid native runtime control.");
      return { key, value };
    });
    if (applied) {
      void vscode.window.showInformationMessage(
        "Runtime control acknowledged. Global persistence was requested, not verified. Retry state cannot be read through Pi 1.3 RPC.",
      );
    }
  });
}

async function inputSetting(control: NativeSettingControl, current: unknown): Promise<unknown> {
  if (control.choices) {
    const value = await vscode.window.showQuickPick([...control.choices], {
      title: control.label,
      placeHolder: control.effect,
    });
    return value === undefined ? undefined : typeof control.defaultValue === "boolean" ? value === "true" : value;
  }
  const text = await vscode.window.showInputBox({
    title: control.label,
    value: Array.isArray(current) ? current.join(",") : typeof current === "string" ? current : "",
    prompt:
      control.key === "enabledModels"
        ? "Comma-separated ordered Pi patterns; no available-model discovery occurs. Empty means an empty scope preference, not an access restriction."
        : control.effect,
    validateInput: (input) => {
      try {
        validateNativeSetting(
          control,
          control.key === "enabledModels" ? (input ? input.split(",").map((item) => item.trim()) : []) : input,
        );
        return undefined;
      } catch {
        return "Invalid or oversized native setting value.";
      }
    },
  });
  return text === undefined
    ? undefined
    : control.key === "enabledModels"
      ? text
        ? text.split(",").map((item) => item.trim())
        : []
      : text;
}
