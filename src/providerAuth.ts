import { realpath } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import { type HelperInteraction, IsolatedPiError, runIsolatedPi } from "./isolatedPi";
import { resolveNativeAgentDirectory } from "./nativePiFiles";
import type { PiRuntimeManager } from "./piRuntime";
import { readPiInvocationOptions } from "./vscodePi";

const stores = new Set<string>();

/** Native, user-initiated auth only. Settings and catalog browsing do not call this controller. */
export function registerProviderAuthentication(context: vscode.ExtensionContext, runtime: PiRuntimeManager): void {
  const controllers = new Set<AbortController>();
  context.subscriptions.push({
    dispose: () => {
      for (const controller of controllers) controller.abort();
      controllers.clear();
    },
  });
  for (const operation of ["login", "logout"] as const) {
    context.subscriptions.push(
      vscode.commands.registerCommand(operation === "login" ? "pi.signInProvider" : "pi.signOutProvider", async () => {
        try {
          await runtime.withWorkspaceOperation(`provider ${operation}`, async (assertCurrent) => {
            const configuredDir = process.env.PI_CODING_AGENT_DIR;
            const agentDir = await canonicalStore(resolveNativeAgentDirectory(runtime.currentCwd));
            if (stores.has(agentDir)) throw new Error("Another authentication operation owns this Pi store.");
            stores.add(agentDir);
            const controller = new AbortController();
            controllers.add(controller);
            const check = async (): Promise<void> => {
              await assertCurrent();
              if (
                controller.signal.aborted ||
                configuredDir !== process.env.PI_CODING_AGENT_DIR ||
                (await canonicalStore(resolveNativeAgentDirectory(runtime.currentCwd))) !== agentDir
              )
                throw new IsolatedPiError("cancelled");
            };
            try {
              const invocation = readPiInvocationOptions(vscode.Uri.file(runtime.currentCwd));
              const helperPath = path.join(context.extensionUri.fsPath, "resources", "pi-isolated-helper.ts");
              const catalog = await vscode.window.withProgress(
                {
                  location: vscode.ProgressLocation.Notification,
                  title: "Read built-in Pi authentication methods (no credentials)",
                  cancellable: true,
                },
                async (_progress, token) => {
                  const cancellation = token.onCancellationRequested(() => controller.abort());
                  if (token.isCancellationRequested) controller.abort();
                  try {
                    return await runIsolatedPi(
                      invocation,
                      helperPath,
                      { operation: "discover", agentDir },
                      undefined,
                      controller.signal,
                    );
                  } finally {
                    cancellation.dispose();
                  }
                },
              );
              await check();
              const provider = await vscode.window.showQuickPick(
                (catalog.providers ?? [])
                  .filter((provider) => operation === "logout" || provider.methods.length > 0)
                  .map((provider) => ({ label: provider.id, provider })),
                {
                  title:
                    operation === "login"
                      ? "Sign In to Pi Provider (Built-in Providers)"
                      : "Remove Pi Provider Credential",
                },
              );
              if (!provider) return;
              await check();
              const method =
                operation === "login"
                  ? await vscode.window.showQuickPick(
                      provider.provider.methods.map((method) => ({
                        label: method === "oauth" ? "Browser / device sign-in" : "API key",
                        method,
                      })),
                      { title: `Pi: ${provider.label}` },
                    )
                  : undefined;
              if (operation === "login" && !method) return;
              const authMethod = method?.method;
              await check();
              const approval = await vscode.window.showWarningMessage(
                `${operation === "login" ? "Sign in to" : "Remove the stored credential for"} ${provider.label} on ${vscode.env.remoteName ? `remote Extension Host (${vscode.env.remoteName})` : "this Extension Host"}? Pi store: ${agentDir}. ${operation === "logout" ? "This does not revoke provider access or remove environment/configuration credentials." : "Pi owns credentials; VS Code does not store them. Provider authorization can use the network."}`,
                { modal: true },
                operation === "login" ? "Sign In" : "Remove Credential",
              );
              if (approval !== (operation === "login" ? "Sign In" : "Remove Credential")) return;
              await check();
              const interaction: HelperInteraction = {
                prompt: async (prompt, signal) => {
                  await check();
                  const cancellation = new vscode.CancellationTokenSource();
                  const abort = (): void => cancellation.cancel();
                  signal.addEventListener("abort", abort, { once: true });
                  controller.signal.addEventListener("abort", abort, { once: true });
                  if (signal.aborted || controller.signal.aborted) cancellation.cancel();
                  try {
                    if (prompt.kind === "select") {
                      const selected = await vscode.window.showQuickPick(
                        (prompt.options ?? []).map((option) => ({ label: option.label, id: option.id })),
                        { title: `Pi authentication: ${provider.label}` },
                        cancellation.token,
                      );
                      await check();
                      return selected?.id;
                    }
                    const value = await vscode.window.showInputBox(
                      {
                        title: `Pi authentication: ${provider.label}`,
                        prompt:
                          prompt.kind === "manual_code"
                            ? "Paste the complete final redirect URI or authorization code requested by Pi. It stays private."
                            : prompt.kind === "secret"
                              ? "Enter the credential requested by Pi."
                              : "Enter the private configuration value requested by Pi.",
                        password: true,
                        ignoreFocusOut: true,
                        validateInput: (value) => (value.length > 8_192 ? "Use at most 8,192 characters." : undefined),
                      },
                      cancellation.token,
                    );
                    await check();
                    return value;
                  } finally {
                    signal.removeEventListener("abort", abort);
                    controller.signal.removeEventListener("abort", abort);
                    cancellation.dispose();
                  }
                },
                openUrl: async (url, code, signal) => {
                  await check();
                  const cancellation = new vscode.CancellationTokenSource();
                  const abort = (): void => cancellation.cancel();
                  signal.addEventListener("abort", abort, { once: true });
                  if (signal.aborted) cancellation.cancel();
                  try {
                    const approval = await vscode.window.showQuickPick(
                      ["Open Sign-in Page"],
                      {
                        title: code ? `Pi device code: ${code}` : "Pi provider sign-in",
                        placeHolder: `Open ${new URL(url).origin} in your local browser?`,
                      },
                      cancellation.token,
                    );
                    if (approval !== "Open Sign-in Page" || signal.aborted) return false;
                    await check();
                    // Preserve the complete provider URL; Pi owns callback/state validation.
                    if (signal.aborted) return false;
                    return vscode.env.openExternal(vscode.Uri.parse(url, true));
                  } finally {
                    signal.removeEventListener("abort", abort);
                    cancellation.dispose();
                  }
                },
              };
              const result = await vscode.window.withProgress(
                {
                  location: vscode.ProgressLocation.Notification,
                  title: `Pi provider ${operation === "login" ? "sign-in" : "sign-out"}: ${provider.label}`,
                  cancellable: true,
                },
                async (_progress, token) => {
                  const cancellation = token.onCancellationRequested(() => controller.abort());
                  if (token.isCancellationRequested) controller.abort();
                  try {
                    if (operation === "login") {
                      if (!authMethod) throw new IsolatedPiError("failed");
                      return await runIsolatedPi(
                        invocation,
                        helperPath,
                        { operation, agentDir, provider: provider.label, method: authMethod },
                        interaction,
                        controller.signal,
                      );
                    }
                    return await runIsolatedPi(
                      invocation,
                      helperPath,
                      { operation, agentDir, provider: provider.label },
                      interaction,
                      controller.signal,
                    );
                  } finally {
                    cancellation.dispose();
                  }
                },
              );
              // Store changes cannot be rolled back if the origin changed while the provider finished.
              await check().catch(() => {
                throw new Error(
                  "The Pi credential may have changed after the operation origin changed. Verify Pi authentication before retrying.",
                );
              });
              void vscode.window.showInformationMessage(
                `${result.status === "changed-refresh-failed" ? "Pi changed the credential, but its model catalog refresh failed." : "Pi updated its stored credential."} Restart a running Pi explicitly to refresh model availability. The conversation and selected model were not changed. Environment/configuration credentials can remain effective.${result.cleanupWarning ? " Process descendant cleanup is unverified." : ""}`,
              );
            } finally {
              controller.abort();
              controllers.delete(controller);
              stores.delete(agentDir);
            }
          });
        } catch (error) {
          await vscode.window.showWarningMessage(
            error instanceof IsolatedPiError
              ? error.message
              : error instanceof Error && /^(Another authentication|The Pi credential may)/.test(error.message)
                ? error.message
                : "Pi authentication did not complete. No authentication was retried; check the Pi store before retrying.",
          );
        }
      }),
    );
  }
}
async function canonicalStore(value: string): Promise<string> {
  try {
    return await realpath(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(value);
    if (parent === value) throw error;
    return path.join(await canonicalStore(parent), path.basename(value));
  }
}
