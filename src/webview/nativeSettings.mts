import type { NativeFormEntry, NativeFormSnapshot, NativeFormValue } from "../nativePiFormModel";
import {
  mcpExposures,
  type NativeSettingControl,
  nativeSettingControls,
  validateNativeSetting,
} from "../nativePiModel";
import { serializedSize } from "../settingsModel";

type Scope = "global" | "project";
type Draft = { raw: string | boolean; base: string; origin: string; conflict: boolean };
type Pending = { id: string; scope: Scope; key: string; server?: string };
type Recovery = { scope: Scope; drafts: Record<string, Draft> };
const limit = 28 * 1024;
const token = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}
function parsed(control: NativeSettingControl, raw: string | boolean): NativeFormValue {
  return Array.isArray(control.defaultValue)
    ? String(raw)
        .split("\n")
        .filter((line) => line !== "")
    : raw;
}
function valid(control: NativeSettingControl, raw: unknown): raw is string | boolean {
  if (typeof raw !== "string" && typeof raw !== "boolean") return false;
  try {
    validateNativeSetting(control, parsed(control, raw));
    return true;
  } catch {
    return false;
  }
}
// A local change indicator, not a write authorization token. The host checks real file revisions.
function fingerprint(entry: NativeFormEntry): string {
  const text = JSON.stringify([
    entry.own,
    entry.inherited,
    entry.value,
    entry.source,
    entry.hasOverride,
    entry.invalid,
    entry.inheritedInvalid,
  ]);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Native file projections and MCP drafts stay in memory. Only bounded common drafts can be recovered. */
export class NativeSettingsForm {
  private scope: Scope = "global";
  private active = false;
  private available = false;
  private snapshot?: NativeFormSnapshot;
  private loadId?: string;
  private counter = 0;
  private readonly instance = crypto.randomUUID();
  private readonly drafts: Record<string, Draft> = {};
  private readonly pending = new Map<string, Pending>();
  private readonly mcpRevisions = new Map<string, string>();
  private readonly messages = new Map<string, string>();
  private notice = "";

  constructor(
    private readonly post: (message: unknown) => void,
    private readonly redraw: () => void,
    private readonly persist: () => void,
    saved: unknown,
  ) {
    if (!saved || typeof saved !== "object" || serializedSize(saved) > limit) return;
    const state = saved as Partial<Recovery>;
    if (state.scope === "project") this.scope = "project";
    for (const scope of ["global", "project"]) {
      for (const control of nativeSettingControls) {
        const key = `${scope}:${control.key}`;
        const draft = state.drafts?.[key];
        if (
          draft &&
          valid(control, draft.raw) &&
          typeof draft.base === "string" &&
          /^[a-f0-9]{8}$/.test(draft.base) &&
          token(draft.origin)
        ) {
          this.drafts[key] = {
            raw: draft.raw,
            base: draft.base,
            origin: draft.origin,
            conflict: draft.conflict === true,
          };
        }
      }
    }
  }

  private commonDrafts(): Record<string, Draft> {
    const drafts: Record<string, Draft> = {};
    for (const scope of ["global", "project"]) {
      for (const control of nativeSettingControls) {
        const key = `${scope}:${control.key}`;
        const draft = this.drafts[key];
        if (draft && valid(control, draft.raw)) drafts[key] = { ...draft };
      }
    }
    return drafts;
  }

  recoveryOverflowed(): boolean {
    return serializedSize({ scope: this.scope, drafts: this.commonDrafts() }) > limit;
  }

  recovery(): Recovery {
    const state = { scope: this.scope, drafts: this.commonDrafts() };
    return serializedSize(state) <= limit ? state : { scope: this.scope, drafts: {} };
  }

  setContext(active: boolean, available: boolean): void {
    const entered = active && !this.active;
    const enabled = available && !this.available;
    if (this.available && !available) this.invalidate();
    this.active = active;
    this.available = available;
    if (!active) this.loadId = undefined;
    if (active && available && !this.loadId && (enabled || entered)) this.load();
  }

  private id(): string {
    return `native-${this.instance}-${++this.counter}`;
  }

  private load(): void {
    if (!this.active || !this.available) return;
    // A new host load supersedes earlier operations. Never keep a row pending on a reply that cannot arrive.
    for (const key of this.pending.keys()) {
      if (this.drafts[key]) this.drafts[key].conflict = true;
      this.messages.set(key, "Configuration changed. Reload this row before saving again.");
    }
    this.pending.clear();
    this.loadId = this.id();
    this.notice = "Loading native configuration…";
    this.post({ type: "nativeLoad", id: this.loadId, scope: this.scope });
  }

  private invalidate(): void {
    this.snapshot = undefined;
    this.loadId = undefined;
    this.pending.clear();
    for (const draft of Object.values(this.drafts)) draft.conflict = true;
    this.notice = "Configuration changed. Drafts retained; reload each changed row before saving.";
  }

  receive(message: unknown): boolean {
    if (!message || typeof message !== "object") return false;
    const data = message as { type?: string; ok?: boolean; error?: string } & Partial<Omit<NativeFormSnapshot, "type">>;
    if (data.type === "nativeInvalidated") {
      this.invalidate();
      if (this.active) this.load();
    } else if (data.type === "nativeSnapshot") {
      const operation = [...this.pending.values()].find((item) => item.id === data.id);
      const loading = typeof data.id === "string" && data.id === this.loadId;
      if ((!loading && !operation) || data.scope !== (operation?.scope ?? this.scope)) return true;
      if (!token(data.origin) || !token(data.revision) || !Array.isArray(data.entries) || !Array.isArray(data.servers))
        return true;
      if (loading) this.loadId = undefined;
      if (data.scope === this.scope) this.snapshot = data as NativeFormSnapshot;
      this.notice = "";
    } else if (data.type === "nativeResult") {
      if (typeof data.id === "string" && data.id === this.loadId) {
        this.loadId = undefined;
        this.snapshot = undefined;
        this.notice = data.error || "Could not load native configuration. Reload configuration to try again.";
      } else {
        const match = [...this.pending].find(([, operation]) => operation.id === data.id);
        if (!match) return true;
        const [key] = match;
        this.pending.delete(key);
        if (data.ok === true) {
          delete this.drafts[key];
          this.mcpRevisions.delete(key);
          this.messages.set(key, "Saved. Running sessions are unchanged.");
        } else {
          if (this.drafts[key] && /changed|conflict|stale|reload/i.test(data.error ?? ""))
            this.drafts[key].conflict = true;
          this.messages.set(key, data.error || "Could not save native configuration. Draft retained.");
        }
      }
    } else return false;
    this.persist();
    this.redraw();
    return true;
  }

  render(main: HTMLElement): void {
    main.append(
      element("p", "Edit common native settings with explicit Save. Changing a field never writes automatically."),
      element(
        "p",
        "Only validated common-setting drafts within the 28 KiB recovery limit are restored after hiding this page. MCP drafts stay in memory only.",
      ),
      element(
        "p",
        "Global Pi uses the Extension Host's ~/.pi/agent/settings.json and mcp.json, or PI_CODING_AGENT_DIR. Project Pi uses .pi/settings.json and .pi/mcp.json in the first workspace folder. Remote windows use remote host paths.",
      ),
      element(
        "p",
        "Opening, switching, and resetting an absent override create nothing. Save does not restart Pi, connect MCP servers, or approve project resources. VS Code launch overrides can take precedence.",
      ),
    );
    const scopes = element("div");
    scopes.className = "scope";
    const label = element("label", "Native scope");
    label.htmlFor = "native-scope";
    const select = element("select");
    select.id = "native-scope";
    for (const [value, title] of [
      ["global", "Global Pi"],
      ["project", "Project Pi"],
    ]) {
      const option = element("option", title);
      option.value = value;
      select.append(option);
    }
    select.value = this.scope;
    select.disabled = !this.available;
    select.addEventListener("change", () => {
      this.scope = select.value === "project" ? "project" : "global";
      this.snapshot = undefined;
      this.loadId = undefined;
      this.load();
      this.persist();
      this.redraw();
    });
    scopes.append(label, select);
    main.append(scopes);
    const actions = element("div");
    actions.className = "actions native-actions";
    for (const kind of ["settings", "mcp"] as const) {
      const button = element("button", kind === "settings" ? "Native settings management" : "Native MCP management");
      button.type = "button";
      button.id = `native-manage-${kind}`;
      button.disabled = !this.available;
      button.addEventListener("click", () => this.post({ type: "openPiFile", kind, scope: this.scope }));
      actions.append(button);
    }
    const reload = element("button", "Reload configuration");
    reload.type = "button";
    reload.id = "native-reload-configuration";
    reload.disabled = !this.available || !!this.loadId;
    reload.addEventListener("click", () => {
      this.load();
      this.redraw();
    });
    actions.append(reload);
    main.append(actions);
    const notice = element(
      "p",
      this.available ? this.notice : "Open a trusted, file-backed workspace to edit Pi configuration.",
    );
    notice.setAttribute("role", "status");
    main.append(notice);
    if (!this.available || !this.snapshot) return;
    if (this.scope === "project" && !this.snapshot.approved)
      main.append(
        element(
          "p",
          "Project overrides remain inactive until project resources are approved. These are configured values, not active runtime settings.",
        ),
      );
    for (const control of nativeSettingControls) {
      const entry = this.snapshot.entries.find((entry) => entry.key === control.key);
      if (entry) this.row(main, control, entry);
    }
    main.append(
      element("h3", "Configured MCP servers"),
      element(
        "p",
        "Connection state is unknown. Use native management for creation, transport, credentials, authentication, and diagnostics.",
      ),
    );
    if (!this.snapshot.servers.length) main.append(element("p", "No configured MCP servers."));
    for (const [index, server] of this.snapshot.servers.entries()) {
      const section = element("section");
      section.className = "mcp-server";
      section.dataset.server = server.name;
      section.append(
        element("h4", server.name),
        element("p", `Transport: ${server.type} · Source: ${server.source} · Connection: unknown`),
      );
      for (const field of server.fields) {
        if (field.key !== "enabled" && field.key !== "exposure") continue;
        const control: NativeSettingControl = {
          key: field.key,
          label: field.key === "enabled" ? "Enabled" : "Exposure",
          path: [],
          defaultValue: field.key === "enabled" ? true : "codemode",
          ...(field.key === "exposure" ? { choices: mcpExposures } : {}),
          effect: "Configured state only; saving does not connect a server.",
        };
        this.row(section, control, field, server.name, index);
      }
      main.append(section);
    }
  }

  private row(
    main: HTMLElement,
    descriptor: NativeSettingControl,
    entry: NativeFormEntry,
    server?: string,
    index = 0,
  ): void {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    const key = `${this.scope}:${server === undefined ? descriptor.key : `mcp:${server}:${descriptor.key}`}`;
    const draft = this.drafts[key];
    const conflict =
      !!draft &&
      (draft.conflict ||
        draft.origin !== snapshot.origin ||
        draft.base !== fingerprint(entry) ||
        (server !== undefined && this.mcpRevisions.get(key) !== snapshot.revision));
    const blocked = this.pending.has(key) || !!this.loadId;
    const row = element("section");
    row.className = "setting";
    row.dataset.nativeKey = descriptor.key;
    const id = `native-${server === undefined ? descriptor.key : `mcp-${index}-${descriptor.key}`}`;
    const label = element("label", descriptor.label);
    label.htmlFor = id;
    const description = element(
      "p",
      descriptor.effect +
        (Array.isArray(descriptor.defaultValue) ? " Enter one pattern per line; order is preserved." : ""),
    );
    description.id = `${id}-description`;
    const boolean = typeof descriptor.defaultValue === "boolean";
    const control = boolean
      ? element("input")
      : descriptor.choices
        ? element("select")
        : Array.isArray(descriptor.defaultValue)
          ? element("textarea")
          : element("input");
    control.id = id;
    control.disabled = blocked;
    control.setAttribute("aria-describedby", `${description.id} ${id}-meta ${id}-status`);
    if (control instanceof HTMLInputElement) {
      control.type = boolean ? "checkbox" : "text";
      if (!boolean) control.maxLength = 256;
    }
    if (control instanceof HTMLSelectElement) {
      for (const value of descriptor.choices ?? []) {
        const option = element("option", value);
        option.value = value;
        control.append(option);
      }
    }
    const raw = draft?.raw ?? (Array.isArray(entry.value) ? entry.value.join("\n") : entry.value);
    if (control instanceof HTMLInputElement && boolean) control.checked = raw === true;
    else control.value = String(raw);
    const status = element(
      "p",
      blocked
        ? "Saving or loading…"
        : conflict
          ? "Configuration changed. Draft retained; reload this row before saving."
          : (this.messages.get(key) ?? (draft ? "Unsaved changes" : "")),
    );
    status.id = `${id}-status`;
    status.className = conflict ? "row-status conflict" : "row-status";
    status.setAttribute("role", "status");
    const display = (value: NativeFormValue | undefined) =>
      value === undefined
        ? "None"
        : Array.isArray(value)
          ? value.join("; ") || "(empty list)"
          : String(value) || "(empty)";
    const meta = element(
      "p",
      `Selected-scope override: ${entry.invalid ? "Invalid value (not displayed)" : entry.hasOverride ? display(entry.own) : "None"} · Inherited/default: ${entry.inheritedInvalid ? "Invalid inherited value; default shown: " : ""}${display(entry.inherited)} · Source: ${entry.source}${this.scope === "project" && !snapshot.approved ? " · Project values inactive" : ""}`,
    );
    meta.id = `${id}-meta`;
    meta.className = "meta";
    const actions = element("div");
    actions.className = "actions";
    const save = element("button", "Save");
    save.type = "button";
    save.id = `${id}-save`;
    save.disabled = blocked || conflict;
    const submit = (reset: boolean) => {
      if (this.pending.has(key) || this.loadId || conflict || !this.snapshot) return;
      const raw = this.drafts[key]?.raw ?? (Array.isArray(entry.value) ? entry.value.join("\n") : entry.value);
      if (!reset && !valid(descriptor, raw)) {
        this.messages.set(
          key,
          "Invalid value. Use at most 256 characters per value or pattern, 100 patterns, and no control characters or commas in patterns.",
        );
        this.redraw();
        return;
      }
      this.drafts[key] ??= {
        raw,
        base: fingerprint(entry),
        origin: snapshot.origin,
        conflict: false,
      };
      if (server !== undefined && !this.mcpRevisions.has(key)) this.mcpRevisions.set(key, snapshot.revision);
      const id = this.id();
      this.pending.set(key, {
        id,
        scope: this.scope,
        key: descriptor.key,
        ...(server !== undefined ? { server } : {}),
      });
      this.post({
        type: reset ? "nativeReset" : "nativeSave",
        id,
        scope: this.scope,
        revision: this.snapshot.revision,
        key: descriptor.key,
        ...(server !== undefined ? { server } : {}),
        ...(!reset ? { value: parsed(descriptor, raw) } : {}),
      });
      this.persist();
      this.redraw();
    };
    save.addEventListener("click", () => submit(false));
    const reset = element("button", "Reset override");
    reset.type = "button";
    reset.id = `${id}-reset`;
    reset.dataset.focusControl = id;
    reset.className = "secondary";
    reset.disabled = blocked || conflict || !entry.hasOverride;
    reset.addEventListener("click", () => submit(true));
    const reload = element("button", "Reload row");
    reload.type = "button";
    reload.id = `${id}-reload`;
    reload.className = "secondary";
    reload.disabled = blocked;
    reload.addEventListener("click", () => {
      delete this.drafts[key];
      this.mcpRevisions.delete(key);
      this.messages.delete(key);
      this.load();
      this.persist();
      this.redraw();
      document.getElementById(id)?.focus();
    });
    const update = () => {
      if (server !== undefined && !this.mcpRevisions.has(key)) this.mcpRevisions.set(key, snapshot.revision);
      this.drafts[key] = {
        raw: control instanceof HTMLInputElement && boolean ? control.checked : control.value,
        base: draft?.base ?? fingerprint(entry),
        origin: draft?.origin ?? snapshot.origin,
        conflict: draft?.conflict ?? false,
      };
      this.messages.delete(key);
      status.textContent = conflict ? "Configuration changed. Reload this row before saving." : "Unsaved changes";
      this.persist();
    };
    control.addEventListener("input", update);
    control.addEventListener("change", update);
    actions.append(save, reset, reload);
    row.append(label, description, control, meta, actions, status);
    main.append(row);
  }
}
