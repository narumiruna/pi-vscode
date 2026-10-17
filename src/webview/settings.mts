import {
  entryFingerprint,
  maxSettingsMessage,
  type SettingDescriptor,
  type SettingEntry,
  type SettingsSnapshot,
  type SettingsTarget,
  serializedSize,
  settingsDescriptors,
  targetValue,
  validSettingValue,
} from "../settingsModel";

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};
const api = acquireVsCodeApi();
const categories = ["General", "Permissions", "Editor"] as const;
type Draft = { raw: string | boolean; base: string };
const drafts: Record<string, Draft> = {};
const pending = new Map<string, { id: string }>();
const messages = new Map<string, string>();
let snapshot: SettingsSnapshot | undefined;
let category: string = "General";
let target: SettingsTarget = "user";
let counter = 0;
const instance = crypto.randomUUID();
const saved = api.getState() as { category?: string; target?: string; drafts?: Record<string, Draft> } | undefined;
if (saved && serializedSize(saved) <= maxSettingsMessage) {
  if (categories.some((name) => name === saved.category)) category = saved.category!;
  if (saved.target === "workspace") target = "workspace";
  for (const scope of ["user", "workspace"]) {
    for (const descriptor of settingsDescriptors) {
      const key = `${scope}:${descriptor.key}`;
      const draft = saved.drafts?.[key];
      if (draft && (typeof draft.raw === "string" || typeof draft.raw === "boolean") && typeof draft.base === "string")
        drafts[key] = draft;
    }
  }
}
const main = document.querySelector<HTMLElement>("main")!;
const nav = document.querySelector<HTMLElement>("nav")!;
const scope = document.querySelector<HTMLSelectElement>("#target")!;
const status = document.querySelector<HTMLElement>("#status")!;
let focusId: string | undefined;
document.addEventListener("focusin", (event) => {
  const node = event.target;
  focusId = node instanceof HTMLElement && main.contains(node) ? node.id : undefined;
});
function persist(): void {
  const state = { category, target, drafts };
  // Never persist configuration snapshots, and bound the total draft state.
  if (serializedSize(state) <= maxSettingsMessage) {
    api.setState(state);
    status.textContent = "Settings are stored by VS Code. No Pi process is started by this page.";
  } else {
    api.setState({ category, target });
    status.textContent = "Drafts exceed the 32 KiB recovery limit. Save or shorten them before hiding this tab.";
  }
}
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}
function rawValue(descriptor: SettingDescriptor, value: unknown): string | boolean {
  if (descriptor.type === "boolean") return value === true;
  if (descriptor.type === "array" && Array.isArray(value)) return value.join("\n");
  return typeof value === "string" ? value : JSON.stringify(value);
}
function parsed(descriptor: SettingDescriptor, raw: string | boolean): unknown {
  if (descriptor.type === "number") return typeof raw === "string" && raw.trim() !== "" ? Number(raw) : null;
  if (descriptor.type === "array")
    return String(raw)
      .split("\n")
      .filter((line) => line !== "");
  return raw;
}
function save(descriptor: SettingDescriptor, entry: SettingEntry, reset = false): void {
  if (!snapshot) return;
  const key = `${target}:${descriptor.key}`;
  const draft = drafts[key];
  if (draft && draft.base !== entryFingerprint(entry)) {
    messages.set(key, "Settings changed. Reload this row before saving.");
    render();
    return;
  }
  const value = parsed(descriptor, draft?.raw ?? rawValue(descriptor, targetValue(entry, target)));
  if (!reset && !validSettingValue(descriptor, value)) {
    messages.set(
      key,
      "Invalid value. Check the range or edit limits (4,096 characters, 100 list items, 16 KiB per list).",
    );
    render();
    return;
  }
  const id = `${instance}-${++counter}`;
  pending.set(key, { id });
  messages.delete(key);
  api.postMessage({
    type: reset ? "reset" : "save",
    id,
    key: descriptor.key,
    target,
    revision: snapshot.revision,
    ...(!reset ? { value } : {}),
  });
  render();
}
function render(): void {
  scope.value = target;
  scope.querySelector<HTMLOptionElement>('option[value="workspace"]')!.disabled = !snapshot?.workspace;
  document.querySelector<HTMLElement>("#scope-note")!.textContent = snapshot?.remote
    ? "Remote window: use VS Code Settings for local-user versus remote-user scope. Reset removes only this page's selected override."
    : "Reset removes only the selected scope's override. User edits can be overridden by Workspace settings.";
  nav.replaceChildren();
  for (const name of categories) {
    const button = element("button", name);
    button.type = "button";
    button.setAttribute("aria-pressed", String(category === name));
    button.addEventListener("click", () => {
      category = name;
      persist();
      render();
      nav.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
    });
    nav.append(button);
  }
  main.replaceChildren(element("h2", category));
  if (!snapshot) return;
  if (category === "Editor")
    main.append(
      element(
        "p",
        "Changes affect later completion requests. In-flight requests and cached results can remain unchanged.",
      ),
    );
  for (const descriptor of settingsDescriptors.filter((item) => item.category === category)) {
    const entry = snapshot.entries.find((item) => item.key === descriptor.key);
    if (!entry) continue;
    const key = `${target}:${descriptor.key}`;
    const draft = drafts[key];
    const conflict = !!draft && draft.base !== entryFingerprint(entry) && !pending.has(key);
    const blocked = pending.has(key) || (descriptor.key === "approveProjectResources" && !snapshot.trusted);
    const row = element("section");
    row.className = "setting";
    row.dataset.key = descriptor.key;
    const label = element("label", descriptor.label);
    label.htmlFor = descriptor.key;
    const description = element("p", descriptor.description);
    description.id = `${descriptor.key}-description`;
    const control = descriptor.enum
      ? element("select")
      : descriptor.type === "array"
        ? element("textarea")
        : element("input");
    control.id = descriptor.key;
    control.setAttribute("aria-describedby", description.id);
    control.disabled = blocked;
    if (control instanceof HTMLInputElement) {
      control.type = descriptor.type === "boolean" ? "checkbox" : descriptor.type === "number" ? "number" : "text";
      if (descriptor.minimum !== undefined) control.min = String(descriptor.minimum);
      if (descriptor.maximum !== undefined) control.max = String(descriptor.maximum);
      if (descriptor.type === "number") control.step = "1";
    }
    if (control instanceof HTMLSelectElement)
      for (const value of descriptor.enum!) {
        const option = element("option", value === "default" ? "Default (use Pi settings)" : value);
        option.value = value;
        control.append(option);
      }
    const raw = draft?.raw ?? rawValue(descriptor, targetValue(entry, target));
    if (control instanceof HTMLInputElement && control.type === "checkbox") control.checked = raw === true;
    else control.value = String(raw);
    const rowStatus = element(
      "p",
      pending.has(key)
        ? "Saving…"
        : conflict
          ? "Settings changed. Draft retained; reload this row before saving."
          : (messages.get(key) ?? ""),
    );
    rowStatus.className = conflict ? "row-status conflict" : "row-status";
    rowStatus.setAttribute("role", "status");
    const updateDraft = () => {
      drafts[key] = {
        raw: control instanceof HTMLInputElement && control.type === "checkbox" ? control.checked : control.value,
        base: drafts[key]?.base ?? entryFingerprint(entry),
      };
      messages.delete(key);
      rowStatus.textContent = conflict ? "Settings changed. Reload this row before saving." : "Unsaved changes";
      persist();
    };
    control.addEventListener("input", updateDraft);
    if (descriptor.enum || descriptor.type === "boolean")
      control.addEventListener("change", () => {
        updateDraft();
        save(descriptor, entry);
      });
    const meta = element(
      "p",
      `${entry[target] === undefined ? "Inherited" : `Set in ${target === "user" ? "User" : "Workspace"}`} · Effective: ${JSON.stringify(entry.effective)}`,
    );
    meta.className = "meta";
    const actions = element("div");
    actions.className = "actions";
    const automatic = !!descriptor.enum || descriptor.type === "boolean";
    if (!automatic || (draft && !pending.has(key))) {
      const button = element("button", automatic ? "Retry save" : "Save");
      button.type = "button";
      button.id = `${key}-save`;
      button.disabled = blocked || conflict;
      button.addEventListener("click", () => save(descriptor, entry));
      actions.append(button);
    }
    const reset = element("button", "Reset");
    reset.type = "button";
    reset.id = `${key}-reset`;
    reset.className = "secondary";
    reset.disabled = blocked || conflict || entry[target] === undefined;
    reset.addEventListener("click", () => save(descriptor, entry, true));
    const reload = element("button", "Reload row");
    reload.type = "button";
    reload.id = `${key}-reload`;
    reload.className = "secondary";
    reload.disabled = pending.has(key);
    reload.addEventListener("click", () => {
      delete drafts[key];
      messages.delete(key);
      persist();
      render();
      document.getElementById(descriptor.key)?.focus();
    });
    actions.append(reset, reload);
    row.append(label, description);
    if (descriptor.launch) row.append(element("p", "Used when a Pi process starts; running sessions are unchanged."));
    row.append(control, meta, actions, rowStatus);
    main.append(row);
  }
  if (serializedSize({ category, target, drafts }) > maxSettingsMessage) {
    status.textContent = "Drafts exceed the 32 KiB recovery limit. Save or shorten them before hiding this tab.";
  }
  if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
}
scope.addEventListener("change", () => {
  target = scope.value === "workspace" ? "workspace" : "user";
  persist();
  render();
});
document.querySelector("#native-settings")!.addEventListener("click", () => api.postMessage({ type: "openNative" }));
window.addEventListener("message", (event: MessageEvent) => {
  const data = event.data;
  if (data?.type === "snapshot" && Number.isSafeInteger(data.revision) && Array.isArray(data.entries)) {
    if (snapshot && data.revision < snapshot.revision) return;
    snapshot = data as SettingsSnapshot;
    if (!snapshot.workspace && target === "workspace") {
      target = "user";
      persist();
    }
    status.textContent = "Settings are stored by VS Code. No Pi process is started by this page.";
    render();
  } else if (data?.type === "result") {
    const match = [...pending].find(([, item]) => item.id === data.id);
    if (!match) return;
    const [key] = match;
    pending.delete(key);
    if (data.ok === true) {
      delete drafts[key];
      messages.set(key, "Saved. Running sessions are unchanged.");
    } else messages.set(key, typeof data.error === "string" ? data.error : "Could not save settings.");
    persist();
    render();
  }
});
render();
api.postMessage({ type: "ready" });
