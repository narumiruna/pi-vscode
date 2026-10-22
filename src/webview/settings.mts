import {
  maxSettingsMessage,
  type SettingsRestartStatus,
  type SettingsSnapshot,
  serializedSize,
} from "../settingsModel";
import { NativeSettingsForm } from "./nativeSettings.mjs";

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};
const api = acquireVsCodeApi();
const recovered = api.getState();
const saved =
  recovered && typeof recovered === "object" && serializedSize(recovered) <= maxSettingsMessage
    ? (recovered as { native?: unknown; detailsOpen?: boolean; restartId?: unknown; restartStatus?: unknown })
    : undefined;
const main = document.querySelector<HTMLElement>("main")!;
const status = document.querySelector<HTMLElement>("#status")!;
const details = document.querySelector<HTMLDetailsElement>("#configuration-details")!;
details.open = saved?.detailsOpen === true;
let snapshot: SettingsSnapshot | undefined;
let focusId: string | undefined;
let focusControlId: string | undefined;
const restartButton = document.querySelector<HTMLButtonElement>("#native-restart-pi")!;
const operationStatus = document.querySelector<HTMLElement>("#operation-status")!;
const restartMessages: Readonly<Record<SettingsRestartStatus, string>> = {
  completed: "Pi restarted. Resumed-session values and VS Code launch overrides can still take precedence.",
  cancelled: "Restart cancelled. Saved files and drafts are unchanged.",
  failed:
    "Pi could not be restarted. Saved files and drafts are unchanged; runtime state is uncertain. Inspect Pi before retrying.",
  rejected: "Restart request expired or is unavailable. Reload saved values before retrying. Drafts are retained.",
};
function isRestartStatus(value: unknown): value is SettingsRestartStatus {
  return typeof value === "string" && Object.hasOwn(restartMessages, value);
}
let restartId =
  typeof saved?.restartId === "string" && /^restart-[a-f0-9-]{36}$/.test(saved.restartId) ? saved.restartId : undefined;
let restartStatus = restartId && isRestartStatus(saved?.restartStatus) ? saved.restartStatus : undefined;
const waitingForRestart = "Waiting for Pi restart confirmation or completion…";
operationStatus.textContent = restartStatus ? restartMessages[restartStatus] : restartId ? waitingForRestart : "";
const nativeForm = new NativeSettingsForm((message) => api.postMessage(message), render, persist, saved?.native);

function persist(): void {
  // Recover only bounded drafts and fixed restart feedback, never file snapshots, MCP data, or action tokens.
  api.setState({
    native: nativeForm.recovery(),
    detailsOpen: details.open,
    ...(restartId ? { restartId } : {}),
    ...(restartStatus ? { restartStatus } : {}),
  });
  status.textContent = nativeForm.recoveryOverflowed()
    ? "Native drafts exceed the 28 KiB recovery limit. They will not be restored after hiding this page. Save or shorten them first."
    : "";
}

function render(): void {
  main.replaceChildren();
  nativeForm.setContext(true, snapshot?.nativeFilesAvailable === true);
  nativeForm.render(main);
  restartButton.disabled =
    !snapshot?.nativeFilesAvailable || !snapshot.restartActionToken || (!!restartId && !restartStatus);
  persist();
  if (focusId) {
    const previous = document.getElementById(focusId);
    const fallback = previous?.dataset.focusControl ?? focusControlId;
    const menu = previous?.closest<HTMLDetailsElement>("details.setting-actions");
    const next =
      fallback &&
      (!previous ||
        previous.hidden ||
        (previous instanceof HTMLButtonElement && previous.disabled) ||
        (menu && !menu.open))
        ? document.getElementById(fallback)
        : previous;
    next?.focus({ preventScroll: true });
  }
}

document.addEventListener("focusin", (event) => {
  const node = event.target;
  focusId = node instanceof HTMLElement && main.contains(node) ? node.id : undefined;
  focusControlId = node instanceof HTMLElement && main.contains(node) ? node.dataset.focusControl : undefined;
});
function closeMenu(menu: HTMLDetailsElement): void {
  menu.open = false;
  menu.querySelector("summary")?.setAttribute("aria-expanded", "false");
}

document.addEventListener(
  "toggle",
  (event) => {
    const node = event.target;
    if (!(node instanceof HTMLDetailsElement) || !node.classList.contains("setting-actions")) return;
    node.querySelector("summary")?.setAttribute("aria-expanded", String(node.open));
    if (node.open)
      for (const other of document.querySelectorAll<HTMLDetailsElement>("details.setting-actions[open]"))
        if (other !== node) closeMenu(other);
  },
  true,
);
document.addEventListener("pointerdown", (event) => {
  for (const menu of document.querySelectorAll<HTMLDetailsElement>("details.setting-actions[open]"))
    if (event.target instanceof Node && !menu.contains(event.target)) closeMenu(menu);
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  const menu = document.querySelector<HTMLDetailsElement>("details.setting-actions[open]");
  if (!menu) return;
  event.preventDefault();
  closeMenu(menu);
  menu.querySelector("summary")?.focus();
});
details.addEventListener("toggle", persist);
details.querySelector("summary")?.addEventListener("click", (event) => {
  event.preventDefault();
  details.open = !details.open;
  persist();
});
document.querySelector("#native-settings")!.addEventListener("click", () => api.postMessage({ type: "openNative" }));
restartButton.addEventListener("click", () => {
  if ((restartId && !restartStatus) || !snapshot?.nativeFilesAvailable || !snapshot.restartActionToken) return;
  restartId = `restart-${crypto.randomUUID()}`;
  restartStatus = undefined;
  restartButton.disabled = true;
  operationStatus.textContent = waitingForRestart;
  persist();
  api.postMessage({ type: "restartPi", id: restartId, actionToken: snapshot.restartActionToken });
});
window.addEventListener("message", (event: MessageEvent) => {
  const data = event.data;
  if (nativeForm.receive(data)) return;
  if (data?.type === "snapshot" && typeof data.nativeFilesAvailable === "boolean") {
    snapshot = data as SettingsSnapshot;
    render();
  } else if (data?.type === "restartResult" && restartId && data.id === restartId) {
    const outcome: unknown = data.status;
    if (!isRestartStatus(outcome) || restartStatus === outcome) return;
    restartStatus = outcome;
    operationStatus.textContent = restartMessages[outcome];
    persist();
    restartButton.disabled = !snapshot?.nativeFilesAvailable || !snapshot.restartActionToken;
  } else if (data?.type === "result" && data.ok === false) {
    operationStatus.textContent = "Could not open configuration. Use the Command Palette.";
  }
});
render();
api.postMessage({ type: "ready" });
