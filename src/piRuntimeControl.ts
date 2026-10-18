import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import { piConfiguration } from "./configuration";
import { acquireOperation } from "./operationLocks";
import { controlCommand, controlResultPrefix, type PiSessionTree, verifyPackagedCommands } from "./piControl";
import { buildRpcArguments, type PiRpcClient, type PiRpcClientOptions, type PiRpcEvent } from "./piRpcClient";
import type { PiRuntimeState } from "./piRuntime";
import { assertSessionWorkspace, canonicalAssignedSessionPath } from "./sessionIdentity";
import { vscodeAnnotationTokenEnvironmentKey } from "./vscodeBridgeProtocol";
import { readPiInvocationOptions } from "./vscodePi";

export interface RuntimeControlHost {
  readonly context: vscode.ExtensionContext;
  readonly cwd: string;
  readonly resource: vscode.Uri | undefined;
  readonly state: PiRuntimeState;
  readonly client: PiRpcClient | undefined;
  readonly hasPendingDialogs: boolean;
  readonly queuePending: boolean;
  owned<T>(action: () => Promise<T>): Promise<T>;
  start(): Promise<void>;
  startSession(sessionFile: string | undefined, allowUnsaved?: boolean, root?: string): Promise<void>;
  stop(): Promise<void>;
  refresh(): Promise<void>;
  emit(event: PiRpcEvent): void;
  resetUi(): void;
  terminalOptions(): Promise<PiRpcClientOptions>;
}

const externalOwnershipKey = "pi.control.externalOwnership.v1";
interface ExternalOwnership {
  readonly version: 1;
  readonly root: string;
  readonly sessionFile?: string;
  readonly sessionId?: string;
}
function parseOwnership(value: unknown): ExternalOwnership | "invalid" {
  if (typeof value !== "object" || value === null) return "invalid";
  const marker = value as Record<string, unknown>;
  if (Object.keys(marker).some((key) => !["version", "root", "sessionFile", "sessionId"].includes(key)))
    return "invalid";
  if (
    marker.version !== 1 ||
    typeof marker.root !== "string" ||
    marker.root.length > 4_096 ||
    !path.isAbsolute(marker.root) ||
    (marker.sessionFile !== undefined &&
      (typeof marker.sessionFile !== "string" ||
        marker.sessionFile.length > 4_096 ||
        !path.isAbsolute(marker.sessionFile))) ||
    (marker.sessionId !== undefined && (typeof marker.sessionId !== "string" || marker.sessionId.length > 200))
  )
    return "invalid";
  return {
    version: 1,
    root: marker.root,
    sessionFile: marker.sessionFile as string | undefined,
    sessionId: marker.sessionId as string | undefined,
  };
}

export interface PiSessionTransferSnapshot {
  readonly sessionDir: string;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly leafId: string | null;
  readonly entriesHash: string;
}

/** Foreground control, origin validation, and terminal ownership share one lifecycle. */
export class PiRuntimeControl {
  private generation = 0;
  private launchPolicy: string | undefined;
  private ownershipLoaded = false;
  private persistedOwnership: ExternalOwnership | "invalid" | undefined;
  private disposed = false;
  private terminal: { readonly root: string; readonly release: () => void } | undefined;

  public constructor(private readonly host: RuntimeControlHost) {}

  public invalidate(): void {
    this.generation++;
  }
  public clientStarted(): void {
    this.generation++;
    this.launchPolicy = this.policyFingerprint();
  }
  public async initializeOwnership(): Promise<void> {
    if (this.disposed) return;
    if (!this.ownershipLoaded) {
      this.ownershipLoaded = true;
      const stored = this.host.context.workspaceState.get<unknown>(externalOwnershipKey);
      if (stored !== undefined) this.persistedOwnership = parseOwnership(stored);
    }
    if (!this.persistedOwnership || this.terminal) return;
    try {
      const root =
        this.persistedOwnership === "invalid"
          ? await this.workspaceRoot()
          : await realpath(this.persistedOwnership.root);
      if (this.persistedOwnership !== "invalid" && root !== this.persistedOwnership.root) {
        this.persistedOwnership = "invalid";
        return;
      }
      if (!this.disposed) this.terminal = { root, release: acquireOperation(root, "external Pi ownership recovery") };
    } catch {
      // Missing paths, trust, and conflicting operations do not authorize a new foreground writer.
    }
  }

  public assertSidebarOwnership(): void {
    if (this.disposed) throw new Error("Pi control is disposed.");
    if (this.terminal || this.persistedOwnership)
      throw new Error(
        "Pi is owned by the terminal or cleanup is uncertain. Use Return Pi from Terminal / Recover Ownership first.",
      );
  }
  private async persistOwnership(
    root: string,
    assertCurrent: () => Promise<void>,
    expectedOrigin?: () => Promise<void>,
  ): Promise<void> {
    const sessionFile = this.host.state.sessionFile;
    let sessionId = this.host.state.sessionId;
    if (sessionFile) {
      let saved = true;
      try {
        await lstat(sessionFile);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
        saved = false;
      }
      if (saved) await assertSessionWorkspace(sessionFile, root);
      else sessionId = undefined; // Pi can reopen an unsaved path; its pre-save ID is not durable.
    }
    const marker = parseOwnership({ version: 1, root, sessionFile, sessionId });
    if (marker === "invalid") throw new Error("Pi ownership metadata exceeds its bounds.");
    await this.host.context.workspaceState.update(externalOwnershipKey, marker);
    try {
      await expectedOrigin?.();
      await assertCurrent();
    } finally {
      this.persistedOwnership = marker;
      if (!this.disposed) this.terminal = { root, release: () => {} };
    }
  }

  private async assertSessionBinding(root: string, allowUnsaved = false): Promise<void> {
    const sessionFile = this.host.state.sessionFile;
    if (!sessionFile) return;
    try {
      await lstat(sessionFile);
    } catch (error) {
      if (allowUnsaved && error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    await assertSessionWorkspace(sessionFile, root);
  }

  private requireActiveClient(): PiRpcClient {
    const client = this.host.client;
    if (!client?.isRunning) throw new Error("Pi did not establish a running client.");
    return client;
  }

  private policyFingerprint(): string {
    const config = piConfiguration();
    return JSON.stringify({
      ...readPiInvocationOptions(this.host.resource),
      approveProjectResources: config.get<boolean>("approveProjectResources", false),
      permissionMode: config.get<string>("agent.confirmToolCalls", "dangerous"),
    });
  }
  private async workspaceRoot(): Promise<string> {
    if (!vscode.workspace.isTrusted) throw new Error("Pi controls require a trusted workspace.");
    if (this.host.resource && !["file", "untitled"].includes(this.host.resource.scheme))
      throw new Error("Pi controls require a file-backed workspace.");
    const folder =
      (this.host.resource ? vscode.workspace.getWorkspaceFolder(this.host.resource) : undefined) ??
      vscode.workspace.workspaceFolders?.[0];
    if (!folder || folder.uri.scheme !== "file") throw new Error("Pi controls require a file-backed workspace.");
    return realpath(this.host.cwd);
  }

  /** Cold operations do not start Pi. Approval callbacks must call assertCurrent after each dialog. */
  public async withWorkspaceOperation<T>(
    label: string,
    action: (assertCurrent: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    return this.withOperation(label, false, (_client, assertCurrent) => action(assertCurrent));
  }

  public async withForegroundOperation<T>(
    label: string,
    action: (client: PiRpcClient, assertCurrent: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    return this.withOperation(label, true, (client, assertCurrent) => {
      if (!client) throw new Error("Pi is not running.");
      return action(client, assertCurrent);
    });
  }

  private async withOperation<T>(
    label: string,
    foreground: boolean,
    action: (client: PiRpcClient | undefined, assertCurrent: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    return this.host.owned(async () => {
      await this.initializeOwnership();
      this.assertSidebarOwnership();
      const selectedRoot = await this.workspaceRoot();
      if (foreground) await this.host.start();
      if (this.host.state.busy || this.host.queuePending || this.host.hasPendingDialogs)
        throw new Error("Wait for foreground work, queues, and extension dialogs.");
      const root = await this.workspaceRoot();
      if (root !== selectedRoot) throw new Error("Workspace changed during Pi startup.");
      const client = this.host.client;
      const generation = this.generation;
      const origin = JSON.stringify([this.host.state.sessionId, this.host.state.sessionFile]);
      const policy = this.policyFingerprint();
      const release = acquireOperation(root, label);
      const assertOrigin = async () => {
        this.assertSidebarOwnership();
        if (
          root !== (await this.workspaceRoot()) ||
          client !== this.host.client ||
          generation !== this.generation ||
          origin !== JSON.stringify([this.host.state.sessionId, this.host.state.sessionFile]) ||
          policy !== this.policyFingerprint() ||
          this.host.state.busy ||
          this.host.queuePending ||
          this.host.hasPendingDialogs
        )
          throw new Error("Pi operation origin changed. Start again.");
        if (foreground && (!client?.isRunning || this.launchPolicy !== policy))
          throw new Error(
            "Pi launch policy changed or Pi stopped. Restart Pi explicitly before applying these changes.",
          );
      };
      const assertCurrent = async () => {
        await assertOrigin();
        if (foreground && client) {
          // Pi assigns a path before an empty session is saved. The captured canonical
          // launch binding remains authoritative until a header exists; other I/O errors fail.
          await this.assertSessionBinding(root, true);
          const actual = await client.getState();
          if (
            actual.isStreaming ||
            actual.isCompacting ||
            Number(actual.pendingMessageCount ?? 0) > 0 ||
            actual.sessionId !== this.host.state.sessionId ||
            actual.sessionFile !== this.host.state.sessionFile
          )
            throw new Error("Pi actual session is busy or changed. Refresh before this operation.");
          await assertOrigin();
        }
      };
      try {
        await assertCurrent();
        return await action(client, assertCurrent);
      } finally {
        // Ownership transfer retains this exact lock, with no unlock/relock gap.
        if (!this.disposed && this.terminal?.root === root) this.terminal = { root, release };
        else release();
      }
    });
  }

  public async reloadResources(): Promise<boolean> {
    return this.withForegroundOperation("reload Pi resources", async (client, assertCurrent) => {
      const approval = await vscode.window.showWarningMessage(
        "Reload approved Pi resources? This executes extension code. Launch policy remains unchanged.",
        { modal: true },
        "Reload Resources",
      );
      if (approval !== "Reload Resources") return false;
      await assertCurrent();
      const tree = await client.getTree();
      await this.runControl(client, assertCurrent, tree.leafId, "reload");
      return true;
    });
  }
  public async restartSessionProcess(): Promise<boolean> {
    return this.withWorkspaceOperation("restart Pi with current launch policy", async (assertCurrent) => {
      const approval = await vscode.window.showWarningMessage(
        "Restart Pi with the current launch settings and project-resource approval? This stops the foreground process, retains the session, and does not replay requests.",
        { modal: true },
        "Restart Pi",
      );
      if (approval !== "Restart Pi") return false;
      await assertCurrent();
      const client = this.host.client;
      const sessionId = this.host.state.sessionId;
      const sessionFile = this.host.state.sessionFile;
      const root = await this.workspaceRoot();
      const policy = this.policyFingerprint();
      if (client?.isRunning) {
        const state = await client.getState();
        if (state.isStreaming || state.isCompacting || Number(state.pendingMessageCount ?? 0) > 0)
          throw new Error("Wait for Pi before restarting.");
        if (state.sessionId !== sessionId || state.sessionFile !== sessionFile)
          throw new Error("Pi session changed before restart. Refresh before restarting.");
      }
      await assertCurrent();
      let uncertain = false;
      const subscription = client?.onEvent((event) => {
        if (event.type === "runtime_warning" && event.warningCode === "cleanup-unverified") uncertain = true;
      });
      try {
        await this.persistOwnership(root, assertCurrent);
        await this.host.stop();
      } finally {
        subscription?.dispose();
      }
      if (uncertain) {
        const inspected = await vscode.window.showWarningMessage(
          "Pi cleanup is unverified. Inspect and stop remaining Pi processes and tools before restarting.",
          { modal: true },
          "I Checked: Restart Pi",
        );
        if (inspected !== "I Checked: Restart Pi") return false;
      }
      if (
        this.disposed ||
        !this.terminal ||
        root !== (await this.workspaceRoot()) ||
        policy !== this.policyFingerprint() ||
        this.host.client
      )
        throw new Error("Pi restart origin changed. Recover ownership explicitly before retrying.");
      this.terminal = undefined;
      try {
        await this.host.startSession(
          sessionFile,
          this.persistedOwnership !== undefined &&
            this.persistedOwnership !== "invalid" &&
            this.persistedOwnership.sessionId === undefined,
          root,
        );
        await verifyPackagedCommands(
          await this.requireActiveClient().getCommands(),
          path.join(this.host.context.extensionUri.fsPath, "resources"),
        );
        const expectedId =
          this.persistedOwnership && this.persistedOwnership !== "invalid"
            ? this.persistedOwnership.sessionId
            : sessionId;
        if (
          sessionFile &&
          (this.host.state.sessionFile !== sessionFile ||
            (expectedId !== undefined && this.host.state.sessionId !== expectedId))
        )
          throw new Error("Pi restart changed the persistent session identity. Inspect Sessions before continuing.");
        await this.host.refresh();
        if (this.disposed) throw new Error("Pi control disposed during restart.");
        await this.host.context.workspaceState.update(externalOwnershipKey, undefined);
        this.persistedOwnership = undefined;
        this.host.emit({ type: "resources_reloaded", action: "restart" });
        return true;
      } catch (error) {
        this.terminal = { root, release: () => {} };
        await this.host.stop();
        throw new Error(`Pi restart failed after stopping the old process. No replay or rollback. ${String(error)}`);
      }
    });
  }

  public async getSessionTree(): Promise<PiSessionTree & { readonly origin: string }> {
    return this.withForegroundOperation("browse Pi session tree", async (client, assertCurrent) => {
      const tree = await client.getTree();
      await assertCurrent();
      return { ...tree, origin: this.branchOrigin(tree.leafId) };
    });
  }
  private branchOrigin(leafId: string | null): string {
    return JSON.stringify([this.generation, this.host.state.sessionId, this.host.state.sessionFile, leafId]);
  }
  public async branchSession(
    action: "fork" | "clone" | "navigate",
    origin: string,
    targetId?: string,
  ): Promise<{ cancelled: boolean; text?: string }> {
    return this.withForegroundOperation(`${action} Pi session`, (client, assertCurrent) =>
      this.applyBranch(client, assertCurrent, action, origin, targetId),
    );
  }

  public async chooseSessionBranch(
    select: (tree: PiSessionTree) => Promise<{ action: "fork" | "clone" | "navigate"; targetId?: string } | undefined>,
  ): Promise<{ cancelled: boolean; text?: string }> {
    return this.withForegroundOperation("choose Pi branch", async (client, assertCurrent) => {
      const tree = await client.getTree();
      await assertCurrent();
      const origin = this.branchOrigin(tree.leafId);
      const selected = await select(tree);
      if (!selected) return { cancelled: true };
      await assertCurrent();
      return this.applyBranch(client, assertCurrent, selected.action, origin, selected.targetId);
    });
  }

  private async applyBranch(
    client: PiRpcClient,
    assertCurrent: () => Promise<void>,
    action: "fork" | "clone" | "navigate",
    origin: string,
    targetId?: string,
  ): Promise<{ cancelled: boolean; text?: string }> {
    const tree = await client.getTree();
    await assertCurrent();
    if (origin !== this.branchOrigin(tree.leafId)) throw new Error("Session tree changed. Browse it again.");
    if (action !== "navigate" && this.host.state.sessionFile) {
      try {
        await this.assertSessionBinding(await this.workspaceRoot());
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT")
          throw new Error("Pi has not saved this session yet. Fork/clone requires saved history.");
        throw error;
      }
      await assertCurrent();
    }
    if (action === "clone" && tree.leafId === null)
      throw new Error("Cannot clone an empty active branch: no entry is selected.");
    const target = tree.entries.find((entry) => entry.id === targetId);
    if (action !== "clone" && !target) throw new Error("Select an existing session entry.");
    if (action === "fork" && target?.role !== "user")
      throw new Error("Fork requires a user message. Abandoned branches are also available.");
    if (action === "navigate") {
      const cancelled = await this.runControl(client, assertCurrent, tree.leafId, action, targetId);
      try {
        const actual = await client.getTree();
        const expectedLeaf = target?.role === "user" || target?.type === "custom_message" ? target.parentId : targetId;
        if (this.host.client !== client || (!cancelled && actual.leafId !== expectedLeaf && targetId !== tree.leafId))
          throw new Error("Navigation did not reach the expected leaf.");
        return { cancelled, text: !cancelled && target?.role === "user" ? target.text : undefined };
      } catch (error) {
        return this.uncertain(client, error);
      }
    }
    this.host.resetUi();
    this.generation++;
    const oldSessionId = this.host.state.sessionId;
    let extensionFailed = false;
    const subscription = client.onEvent((event) => {
      if (event.type === "extension_error") extensionFailed = true;
    });
    try {
      const result = action === "fork" ? await client.fork(targetId!) : await client.clone();
      if (extensionFailed) throw new Error("Pi extension failed during branching.");
      if (!result.cancelled) {
        await verifyPackagedCommands(
          await client.getCommands(),
          path.join(this.host.context.extensionUri.fsPath, "resources"),
        );
        await this.host.refresh();
        if (extensionFailed || this.host.client !== client || this.host.state.sessionId === oldSessionId)
          throw new Error("Pi did not establish a new branch session identity.");
      }
      return result;
    } catch (error) {
      return this.uncertain(client, error);
    } finally {
      subscription.dispose();
    }
  }
  private async uncertain(client: PiRpcClient, error: unknown): Promise<never> {
    await client.stop();
    throw new Error(`Pi control outcome is uncertain; disconnected without replay. ${String(error)}`);
  }
  /** Narrow read-only query inside an already-owned operation. No UI reset, reload, or generation change. */
  public async getSessionTransferSnapshot(
    client: PiRpcClient,
    assertCurrent: () => Promise<void>,
    expectedLeafId?: string | null,
  ): Promise<PiSessionTransferSnapshot> {
    await assertCurrent();
    this.assertSidebarOwnership();
    if (client !== this.host.client || !client.isRunning) throw new Error("The snapshot query has an expired client.");
    const resources = path.join(this.host.context.extensionUri.fsPath, "resources");
    await verifyPackagedCommands(await client.getCommands(), resources);
    const cwd = await realpath(this.host.cwd);
    await assertCurrent();
    const token = randomUUID();
    let result: PiSessionTransferSnapshot | undefined;
    let failure = false;
    const subscription = client.onEvent((event) => {
      if (
        ["extension_error", "agent_start", "protocol_error"].includes(event.type) ||
        (event.type === "extension_ui_request" && event.method === "notify" && event.notifyType === "error")
      )
        failure = true;
      if (
        event.type !== "extension_ui_request" ||
        event.method !== "notify" ||
        typeof event.message !== "string" ||
        !event.message.startsWith(controlResultPrefix)
      )
        return;
      try {
        if (Buffer.byteLength(event.message) > 16_384) throw new Error("oversize");
        const value: unknown = JSON.parse(event.message.slice(controlResultPrefix.length));
        if (!value || typeof value !== "object" || !("token" in value) || value.token !== token) return;
        const fields = value as Record<string, unknown>;
        if (
          result ||
          Object.keys(fields).some(
            (key) => !["token", "sessionDir", "sessionId", "sessionFile", "leafId", "entriesHash"].includes(key),
          ) ||
          [fields.sessionDir, fields.sessionFile].some(
            (value) =>
              typeof value !== "string" || value.length > 4_096 || !path.isAbsolute(value) || value.includes("\0"),
          ) ||
          typeof fields.sessionId !== "string" ||
          !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(fields.sessionId) ||
          (fields.leafId !== null &&
            (typeof fields.leafId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(fields.leafId))) ||
          typeof fields.entriesHash !== "string" ||
          !/^[a-f0-9]{64}$/.test(fields.entriesHash)
        )
          throw new Error("invalid");
        result = {
          sessionDir: fields.sessionDir as string,
          sessionId: fields.sessionId,
          sessionFile: fields.sessionFile as string,
          leafId: fields.leafId as string | null,
          entriesHash: fields.entriesHash,
        };
      } catch {
        failure = true;
      }
    });
    try {
      const disposition = await client.prompt(
        `/${controlCommand} ${JSON.stringify({
          action: "session-location",
          token,
          cwd,
          sessionId: this.host.state.sessionId,
          ...(expectedLeafId !== undefined ? { leafId: expectedLeafId } : {}),
        })}`,
      );
      if (disposition !== "handled" || failure || !result || this.host.client !== client)
        throw new Error("Missing verified session-location acknowledgement.");
      const snapshot: PiSessionTransferSnapshot = result;
      if (
        snapshot.sessionId !== this.host.state.sessionId ||
        !this.host.state.sessionFile ||
        snapshot.sessionFile !== (await canonicalAssignedSessionPath(this.host.state.sessionFile)) ||
        (expectedLeafId !== undefined && snapshot.leafId !== expectedLeafId) ||
        (await realpath(snapshot.sessionDir)) !== snapshot.sessionDir ||
        (await canonicalAssignedSessionPath(snapshot.sessionFile)) !== snapshot.sessionFile ||
        !(await lstat(snapshot.sessionDir)).isDirectory()
      )
        throw new Error("Stale session location.");
      await verifyPackagedCommands(await client.getCommands(), resources);
      await assertCurrent();
      if (failure) throw new Error("Session-location query failed.");
      return snapshot;
    } catch (error) {
      return this.uncertain(client, error);
    } finally {
      subscription.dispose();
    }
  }

  private async runControl(
    client: PiRpcClient,
    assertCurrent: () => Promise<void>,
    leafId: string | null,
    action: "reload" | "navigate",
    targetId?: string,
  ): Promise<boolean> {
    const resources = path.join(this.host.context.extensionUri.fsPath, "resources");
    await verifyPackagedCommands(await client.getCommands(), resources);
    const cwd = await realpath(this.host.cwd);
    await assertCurrent();
    const token = randomUUID();
    const sessionId = this.host.state.sessionId;
    const sessionFile = this.host.state.sessionFile;
    let failure: string | undefined;
    let cancelled: boolean | undefined;
    const subscription = client.onEvent((event) => {
      if (
        ["extension_error", "agent_start", "protocol_error"].includes(event.type) ||
        (event.type === "extension_ui_request" && event.method === "notify" && event.notifyType === "error")
      )
        failure = "Pi reported extension failure or unexpected model activity.";
      if (
        event.type === "extension_ui_request" &&
        event.method === "notify" &&
        typeof event.message === "string" &&
        event.message.startsWith(controlResultPrefix)
      ) {
        try {
          const result: unknown = JSON.parse(event.message.slice(controlResultPrefix.length));
          if (
            typeof result === "object" &&
            result !== null &&
            "token" in result &&
            result.token === token &&
            "cancelled" in result &&
            typeof result.cancelled === "boolean"
          )
            cancelled = result.cancelled;
        } catch {
          failure = "Invalid control result.";
        }
      }
    });
    try {
      this.host.resetUi();
      this.generation++;
      const disposition = await client.prompt(
        `/${controlCommand} ${JSON.stringify({
          action,
          token,
          cwd,
          sessionId: this.host.state.sessionId,
          leafId,
          targetId,
        })}`,
      );
      if (
        disposition !== "handled" ||
        failure ||
        this.host.client !== client ||
        (action === "navigate" && cancelled === undefined)
      )
        throw new Error(failure ?? "Missing handled control acknowledgement.");
      await verifyPackagedCommands(await client.getCommands(), resources);
      await this.host.refresh();
      if (
        failure ||
        this.host.client !== client ||
        !this.host.state.connected ||
        this.host.state.busy ||
        this.host.state.sessionId !== sessionId ||
        this.host.state.sessionFile !== sessionFile
      )
        throw new Error("Pi resource refresh did not establish a safe idle runtime.");
      this.host.emit({ type: "resources_reloaded", action });
      return cancelled ?? false;
    } catch (error) {
      return this.uncertain(client, error);
    } finally {
      subscription.dispose();
    }
  }
  public async openInTerminal(expectedOrigin?: () => Promise<void>): Promise<void> {
    await this.withForegroundOperation("hand Pi to terminal", async (client, assertCurrent) => {
      const approval = await vscode.window.showWarningMessage(
        "Hand this session to Pi in a terminal? The sidebar writer will stop. Return ownership explicitly before resuming here.",
        { modal: true },
        "Hand Off to Terminal",
      );
      if (approval !== "Hand Off to Terminal") return;
      await expectedOrigin?.();
      await assertCurrent();
      const options = await this.host.terminalOptions();
      await expectedOrigin?.();
      await assertCurrent();
      const root = await this.workspaceRoot();
      const policy = this.policyFingerprint();
      let cleanupUnverified = false;
      const subscription = client.onEvent((event) => {
        if (event.type === "runtime_warning" && event.warningCode === "cleanup-unverified") cleanupUnverified = true;
      });
      // Persist before stopping: integrated terminals can survive an Extension Host reload.
      try {
        await this.persistOwnership(root, assertCurrent, expectedOrigin);
        await this.host.stop();
      } finally {
        subscription.dispose();
      }
      if (cleanupUnverified) {
        const inspected = await vscode.window.showWarningMessage(
          "Pi cleanup is unverified. Inspect and stop remaining Pi processes and tools before another writer starts. Continue only after that check.",
          { modal: true },
          "I Checked: Continue Handoff",
        );
        if (inspected !== "I Checked: Continue Handoff") return;
      }
      if (
        this.disposed ||
        !this.terminal ||
        root !== (await this.workspaceRoot()) ||
        policy !== this.policyFingerprint() ||
        this.host.client
      )
        throw new Error("Terminal launch origin changed. Return ownership explicitly before retrying.");
      // createTerminal takes an argument array, not shell text: paths with spaces stay single arguments.
      const terminal = vscode.window.createTerminal({
        name: "Pi",
        cwd: options.cwd,
        shellPath: options.executablePath,
        shellArgs: buildRpcArguments(options).slice(2),
        env: { ...options.env, [vscodeAnnotationTokenEnvironmentKey]: null },
      });
      terminal.show();
    });
  }
  public async returnFromTerminal(): Promise<boolean> {
    if (this.disposed) throw new Error("Pi control is disposed.");
    return this.host.owned(async () => {
      await this.initializeOwnership();
      if (!this.terminal && !this.persistedOwnership) return false;
      const marker = this.persistedOwnership;
      const root = await this.workspaceRoot();
      if (marker && marker !== "invalid" && marker.root !== root)
        throw new Error("Open the original canonical workspace before returning Pi ownership.");
      const ownership = this.terminal ?? { root, release: acquireOperation(root, "Pi ownership recovery") };
      this.terminal = ownership;
      const policy = this.policyFingerprint();
      const sessionFile = marker && marker !== "invalid" ? marker.sessionFile : this.host.state.sessionFile;
      const sessionId = marker && marker !== "invalid" ? marker.sessionId : this.host.state.sessionId;
      const approval = await vscode.window.showWarningMessage(
        marker === "invalid"
          ? "The saved Pi ownership record is invalid. Inspect and stop all Pi terminal processes and tools before clearing it. This does not resume an unverifiable session."
          : "Confirm Pi and its tools stopped. Closure does not prove descendants stopped. Resume sidebar ownership with the current launch settings and project-resource approval despite this uncertainty?",
        { modal: true },
        "Return Ownership",
      );
      if (approval !== "Return Ownership") return false;
      if (
        this.disposed ||
        ownership !== this.terminal ||
        (await this.workspaceRoot()) !== ownership.root ||
        policy !== this.policyFingerprint()
      )
        throw new Error("Terminal ownership origin changed.");
      const client = this.host.client;
      let cleanupUnverified = false;
      const subscription = client?.onEvent((event) => {
        if (event.type === "runtime_warning" && event.warningCode === "cleanup-unverified") cleanupUnverified = true;
      });
      try {
        if (client) await this.host.stop();
      } finally {
        subscription?.dispose();
      }
      if (cleanupUnverified) {
        const inspected = await vscode.window.showWarningMessage(
          "Pi cleanup remains unverified. Inspect and stop remaining processes and tools before returning ownership.",
          { modal: true },
          "I Checked: Return Ownership",
        );
        if (inspected !== "I Checked: Return Ownership") return false;
      }
      if (
        this.disposed ||
        root !== (await this.workspaceRoot()) ||
        policy !== this.policyFingerprint() ||
        this.host.client
      )
        throw new Error("Ownership recovery origin changed.");
      if (marker === "invalid") {
        await this.host.context.workspaceState.update(externalOwnershipKey, undefined);
        this.persistedOwnership = undefined;
        ownership.release();
        this.terminal = undefined;
        this.host.emit({
          type: "runtime_warning",
          message: "Unverifiable ownership was explicitly cleared. Select a saved session before resuming.",
        });
        return false;
      }
      try {
        await this.host.startSession(sessionFile, marker !== undefined && marker.sessionId === undefined, root);
        await verifyPackagedCommands(
          await this.requireActiveClient().getCommands(),
          path.join(this.host.context.extensionUri.fsPath, "resources"),
        );
        await this.host.refresh();
        if (
          sessionFile &&
          (this.host.state.sessionFile !== sessionFile ||
            (sessionId !== undefined && this.host.state.sessionId !== sessionId))
        )
          throw new Error("Pi session identity changed while returning ownership.");
        if (this.disposed) throw new Error("Pi control disposed during ownership recovery.");
        await this.host.context.workspaceState.update(externalOwnershipKey, undefined);
        this.persistedOwnership = undefined;
        this.terminal = undefined;
        ownership.release();
        return true;
      } catch (error) {
        try {
          await this.host.stop();
        } finally {
          this.terminal = ownership;
        }
        throw new Error(`Ownership recovery failed. No command was replayed. ${String(error)}`);
      }
    });
  }
  public dispose(): void {
    this.disposed = true;
    this.terminal?.release();
    this.terminal = undefined;
  }
}
