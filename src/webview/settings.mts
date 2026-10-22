import { maxSettingsMessage, type SettingsSnapshot, serializedSize } from "../settingsModel";
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
    ? (recovered as { native?: unknown; detailsOpen?: boolean })
    : undefined;
const main = document.querySelector<HTMLElement>("main")!;
const status = document.querySelector<HTMLElement>("#status")!;
const details = document.querySelector<HTMLDetailsElement>("#configuration-details")!;
details.open = saved?.detailsOpen === true;
let snapshot: SettingsSnapshot | undefined;
let focusId: string | undefined;
let focusControlId: string | undefined;
const nativeForm = new NativeSettingsForm((message) => api.postMessage(message), render, persist, saved?.native);

function persist(): void {
  // Ignore legacy category, target, and VS Code drafts; never persist native file snapshots or MCP data.
  api.setState({ native: nativeForm.recovery(), detailsOpen: details.open });
  status.textContent = nativeForm.recoveryOverflowed()
    ? "Native drafts exceed the 28 KiB recovery limit. They will not be restored after hiding this page. Save or shorten them first."
    : "Pi files save only with Save or Reset override. Running sessions are unchanged.";
}

function render(): void {
  main.replaceChildren();
  nativeForm.setContext(true, snapshot?.nativeFilesAvailable === true);
  nativeForm.render(main);
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
window.addEventListener("message", (event: MessageEvent) => {
  const data = event.data;
  if (nativeForm.receive(data)) return;
  if (data?.type === "snapshot" && typeof data.nativeFilesAvailable === "boolean") {
    snapshot = data as SettingsSnapshot;
    render();
  } else if (data?.type === "result" && data.ok === false) {
    status.textContent = data.error || "Could not open configuration. Use the Command Palette.";
  }
});
render();
api.postMessage({ type: "ready" });
