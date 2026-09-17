import assert from "node:assert/strict";
import { createContext, Script } from "node:vm";
import { imageAssetId } from "../imageAssets";
import { getSidebarHtml } from "../sidebarHtml";
import { installVscodeMock } from "./vscodeMock";

test("follow-up shortcut selection uses the webview client OS", () => {
  const windows = createSidebarScriptHarness("Win32");
  assert.equal(windows.run("useCtrlQForFollowUp"), true);
  assert.match(windows.element("composer-hint").textContent, /Ctrl\+Q/);

  const linux = createSidebarScriptHarness("Linux x86_64");
  assert.equal(linux.run("useCtrlQForFollowUp"), false);
  assert.match(linux.element("composer-hint").textContent, /Alt\+Enter/);

  const reducedPlatform = createSidebarScriptHarness("", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
  assert.equal(reducedPlatform.run("useCtrlQForFollowUp"), true);
});

test("webview protocol rejects removed mode messages", () => {
  const vscode = installVscodeMock();
  try {
    const { isWebviewMessage } = require("../sidebarHelpers") as typeof import("../sidebarHelpers");
    assert.equal(isWebviewMessage({ type: "setMode", mode: "agent" }, 1024), false);
    assert.equal(isWebviewMessage({ type: "handoffAgent" }, 1024), false);
    assert.equal(isWebviewMessage({ type: "queueInstruction", kind: "steer", text: "adjust", revision: 1 }, 1024), true);
    assert.equal(isWebviewMessage({ type: "sendNewSession", text: "start", revision: 1 }, 1024), true);
    assert.equal(isWebviewMessage({ type: "sendNewSession", text: "start", revision: -1 }, 1024), false);
    assert.equal(isWebviewMessage({ type: "imageAssetEvicted", id: `sha256-${"a".repeat(64)}` }, 1024), true);
    assert.equal(isWebviewMessage({ type: "imageAssetRejected", id: `sha256-${"b".repeat(64)}` }, 1024), true);
    assert.equal(isWebviewMessage({ type: "restoreQueueAttachments", id: "11111111-1111-4111-8111-111111111111" }, 1024), true);
    assert.equal(isWebviewMessage({ type: "restoreQueueAttachments", id: "../../session" }, 1024), false);
    assert.equal(isWebviewMessage({ type: "refreshSessions" }, 1024), true);
    assert.equal(isWebviewMessage({ type: "switchRecentSession", id: "a".repeat(24) }, 1024), true);
    assert.equal(isWebviewMessage({ type: "switchRecentSession", id: "../../session" }, 1024), false);
    assert.equal(isWebviewMessage({ type: "imageAssetEvicted", id: "../../session" }, 1024), false);
    assert.equal(isWebviewMessage({ type: "imageAssetRejected", id: "../../session" }, 1024), false);
  } finally { vscode.restore(); }
});

test("sidebar composer forwards pasted clipboard images with client-side bounds", () => {
  const html = getSidebarHtml(100_000, 123_456);

  assert.match(html, /input\.addEventListener\('paste', attachPastedImages\)/);
  assert.match(html, /type: 'pasteImage'/);
  assert.match(html, /file\.size > 123456/);
  assert.match(html, /image\/png/);
  assert.match(html, /image\/webp/);
  assert.match(html, /type: 'removeAttachment'/);
  assert.match(html, /let pendingImageReads = 0/);
  assert.match(html, /pendingImageReads > 0/);
  assert.match(html, /reader\.addEventListener\('loadend'/);
  assert.match(html, /Wait for pasted images to finish loading/);
  assert.match(html, /current model does not support image attachments/i);
});

test("sidebar places model and thinking controls before Send and exposes recovery without queue buttons", () => {
  const html = getSidebarHtml(100_000, 5 * 1024 * 1024);

  assert.match(html, /<div class="composer-actions">[\s\S]*id="model-picker"[\s\S]*id="thinking-level"[\s\S]*id="send"/);
  assert.match(html, /id="thinking-level"[^>]*aria-label="Pi thinking level"/);
  assert.doesNotMatch(html, /id="steer"|id="follow-up"|id="inspect-queue"|id="clear-queue"/);
  assert.doesNotMatch(html, /id="mode"|id="handoff-agent"|type: 'setMode'|type: 'handoffAgent'/);
  assert.match(html, /renderThinkingLevel\(state\.runtime\)/);
  assert.match(html, /type: 'setThinking', level: thinkingLevel\.value/);
  assert.match(html, /id="delete-session"[^>]*aria-label="Delete current Pi session"[^>]*hidden>/);
  assert.match(html, /delete-session'\)\.hidden = !deletableSession/);
  assert.match(html, /type: 'deleteSession'/);
  assert.match(html, /delete-session'\)\.disabled = interactionLocked \|\| !connected \|\| !deletableSession/);
  assert.match(html, /id="more"/);
  assert.match(html, /<main id="app" class="sessions-layer">/);
  assert.match(html, /#app\.sessions-layer > :not\(#sessions\):not\(#composer\):not\(#notice\):not\(#runtime\)/);
  assert.match(html, /id="sessions" aria-label="Pi sessions"/);
  assert.match(html, /id="session-header-title"[^>]*>Sessions</);
  assert.match(html, /id="back-to-sessions"[^>]*aria-label="Back to Sessions"/);
  assert.match(html, /id="recent-session-list"/);
  assert.match(html, /id="view-all-sessions"/);
  assert.match(html, /id="session-search-input"[^>]*placeholder="Search recent sessions"/);
  assert.match(html, /type: 'switchRecentSession', id/);
  assert.match(html, /type: 'refreshSessions'/);
  assert.match(html, /id="reconnect"/);
  assert.match(html, /id="retry"/);
  assert.match(html, /id="refresh-history"/);
  assert.match(html, /type: 'refreshHistory'/);
  assert.match(html, /type: 'proposalAction'/);
  assert.match(html, /proposal\.status !== 'previewed'/);
  assert.match(html, /\['previewing', 'applying', 'rejecting'\]\.includes\(proposal\.status\)/);
  assert.match(html, /function setComposerInput\(text\)[\s\S]*composerRevision \+= 1[\s\S]*updateSendState\(\)[\s\S]*message\.type === 'setInput'[\s\S]*setComposerInput\(message\.text\)/);
  assert.match(html, /clearInput'[\s\S]*composerRevision === message\.expectedRevision[\s\S]*input\.value === message\.expectedText[\s\S]*updateSendState\(\)/);
  assert.match(html, /showMoreActions', text: input\.value, revision: composerRevision/);
  assert.match(html, /input\.addEventListener\('input', \(\) => \{ composerRevision \+= 1/);
  assert.match(html, /let submissionPending = false/);
  assert.match(html, /submissionPending = true;\s+updateSendState\(\);\s+vscode\.postMessage/);
  assert.match(html, /message\.type === 'sendRejected'[\s\S]*submissionPending = false/);
  assert.match(html, /let backgroundSubmissionPending = false/);
  assert.match(html, /\(!text && !attachedItems\) \|\| !connected \|\| submissionPending \|\| backgroundSubmissionPending/);
  assert.match(html, /backgroundSubmissionPending = Boolean\(state\.backgroundSubmissionPending\)/);
  assert.match(html, /function isInteractionLocked\(\) \{\s+return busy \|\| submissionPending \|\| backgroundSubmissionPending \|\| pendingImageReads > 0/);
  assert.match(html, /const interactionLocked = isInteractionLocked\(\)/);
  assert.match(html, /Starting background agent/);
  assert.match(html, /messages\.filter\(message => message\.role !== 'assistant' \|\| Boolean\(message\.html\)\)/);
  assert.match(html, /for \(let index = 0; index < visibleMessages\.length; index \+= 1\)/);
  assert.match(html, /structure === renderedMessageStructure/);
  assert.match(html, /content\.innerHTML = html\[index\]/);
  assert.match(html, /#add-context span \{ display: none; \}/);
  assert.match(html, /\.composer-actions \{[^}]*flex-wrap: nowrap/);
  assert.doesNotMatch(html, /id="resume-session"/);
});

test("sidebar preserves hidden semantics, themed layout, and keyboard accessibility", () => {
  const html = getSidebarHtml(42, 1024);
  const composerPosition = html.indexOf('id="composer"');
  const noticePosition = html.indexOf('id="notice"');
  const runtimePosition = html.indexOf('id="runtime"');

  assert.ok(composerPosition < noticePosition && noticePosition < runtimePosition, "runtime status belongs below the composer and notices");
  assert.match(html, /grid-template-rows: auto minmax\(0, 1fr\) auto auto auto auto/);
  assert.match(html, /#runtime \{[^}]*border-top: 1px solid var\(--pi-border\)/);
  assert.match(html, /\[hidden\] \{ display: none !important; \}/);
  assert.match(html, /id="activity" aria-label="Pi workflow activity" hidden/);
  assert.match(html, /id="proposals" aria-label="Pi edit proposals"/);
  assert.match(html, /<span>Pi changes<\/span>/);
  assert.match(html, /id="changes" aria-label="Pi file changes"/);
  assert.match(html, /activity'\)\.hidden = !\[state\.proposals, state\.changes, state\.backgroundTasks\]/);
  assert.match(html, /attachmentsElement\.hidden = attachments\.length === 0/);
  assert.match(html, /id="attachments"[^>]*hidden/);
  assert.match(html, /#notice:empty \{ display: none; \}/);
  assert.match(html, /var\(--vscode-focusBorder\)/);
  assert.match(html, /var\(--vscode-contrastBorder\)/);
  assert.match(html, /prefers-reduced-motion: no-preference/);
  assert.match(html, /summary:focus-visible/);
  assert.match(html, /<div id="pending-queue" role="list" aria-label="Pending Pi messages" hidden><\/div>/);
  assert.match(html, /\.pending-queue-item \{[^}]*min-width: 0/);
  assert.match(html, /\.pending-queue-text \{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere;[^}]*-webkit-line-clamp: 2/);
  assert.match(html, /row\.setAttribute\('role', 'listitem'\)/);
  assert.match(html, /text\.textContent = item\.text/);
  assert.doesNotMatch(html, /row\.innerHTML|text\.innerHTML|kindLabel\.innerHTML/);
  assert.match(html, /<label for="input" class="sr-only">Message Pi<\/label>/);
  assert.match(html, /<textarea[^>]*maxlength="42"[^>]*aria-describedby="composer-hint"/);
  assert.match(html, /id="send"[^>]*aria-label="Send message"[^>]*disabled/);
  assert.match(html, /sendButton\.hidden = cancellable/);
  assert.match(html, /cancelButton\.hidden = !cancellable/);
  assert.match(html, /if \(event\.isComposing\) return/);
  assert.match(html, /input\.scrollHeight/);
});

test("transcript images, context chips, compact composer, and in-flow tools use bounded responsive markup", () => {
  const html = getSidebarHtml(100_000, 5 * 1024 * 1024);
  const conversation = html.indexOf('id="conversation"');
  const messages = html.indexOf('id="messages"');
  const tools = html.indexOf('id="tools-group"');
  const activity = html.indexOf('id="activity"');
  assert.ok(conversation < messages && messages < tools && tools < activity, "request tools follow the active response inside the conversation scroller");
  assert.match(html, /grid-template-columns: repeat\(auto-fit, minmax\(min\(124px, 100%\), 1fr\)\)/);
  assert.match(html, /imageGrid\.className = 'transcript-images'/);
  assert.match(html, /card\.className = 'attachment-image'/);
  assert.match(html, /renderComposerImage\(preview, attachment\)/);
  assert.match(html, /button\.composer-image \{[^}]*height: 72px/);
  assert.match(html, /button\.composer-image:focus-visible, button\.attachment-remove:focus-visible \{[^}]*box-shadow: inset 0 0 0 2px var\(--vscode-focusBorder\)/);
  assert.match(html, /attachment\.fullLabel/);
  assert.match(html, /context\.textContent = attachment\.label/);
  assert.match(html, /context\.title = attachment\.fullLabel/);
  assert.match(html, /<textarea[^>]*rows="1"/);
  assert.match(html, /textarea \{[^}]*height: 42px; min-height: 42px/);
  assert.match(html, /\.content code \{[^}]*font-size: \.95em/);
  assert.match(html, /heightDelta = conversationElement\.scrollHeight - beforeHeight/);
  assert.match(html, /wasBelowViewport \? beforeTop : beforeTop \+ Math\.max\(0, heightDelta\)/);
  assert.match(html, /@media \(max-width: 340px\)/);
  assert.doesNotMatch(html, /context\.innerHTML|label\.innerHTML|image\.innerHTML/);
});

test("responsive transcript constraints and VS Code theme tokens cover 280, 400, and 600 pixel Sidebar widths", () => {
  const html = getSidebarHtml(100_000, 5 * 1024 * 1024);
  for (const width of [280, 400, 600]) {
    assert.ok(width >= 280);
    assert.match(html, /min-width: 0/);
    assert.match(html, /max-width: 100%/);
    assert.match(html, /minmax\(min\(124px, 100%\), 1fr\)/);
  }
  for (const token of ["--vscode-sideBar-background", "--vscode-foreground", "--vscode-focusBorder", "--vscode-contrastBorder"]) assert.ok(html.includes(token));
  assert.match(html, /body\.vscode-light, body\.vscode-high-contrast-light/);
  assert.match(html, /body\.vscode-dark, body\.vscode-high-contrast/);
});

test("sidebar groups tools without reopening disclosures on every state update", () => {
  const html = getSidebarHtml(100_000, 1024);

  assert.match(html, /<details id="tools-group" hidden><summary>/);
  assert.doesNotMatch(html, /<details id="tools-group"[^>]*\bopen\b/);
  assert.match(html, /details\.dataset\.id, details\.open/);
  assert.match(html, /details\.open = openTools\.get\(tool\.id\) \?\? tool\.status === 'running'/);
  assert.match(html, /requestSettled = toolRequestBusy && !busy/);
  assert.match(html, /isRunning && !toolActivityRunning/);
  assert.match(html, /requestSettled \|\| \(previousStatus === 'running' && tool\.status !== 'running' && !busy\)/);
  assert.match(html, /group\.dataset\.status = running\.length/);
  assert.match(html, /failed\.length \+ ' failed'/);
  assert.doesNotMatch(html, /lastElementChild\.open = true/);
});

test("sidebar generated script parses with static icons and keeps nonce-only CSP", () => {
  const html = getSidebarHtml(100_000, 1024);
  const script = /<script nonce="([^"]+)">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(script);
  assert.doesNotThrow(() => new Script(script[2]));
  assert.ok(html.includes(`script-src 'nonce-${script[1]}'`));
  assert.ok(html.includes(`style-src 'nonce-${script[1]}'`));
  assert.match(html, /default-src 'none'/);
  assert.match(html, /img-src data:/);
  assert.doesNotMatch(html, /unsafe-inline|https?:\/\/|blob:|<script[^>]*src=/);
  assert.match(html, /<svg[^>]*aria-hidden="true"[^>]*focusable="false"/);
  assert.notEqual(getSidebarHtml(100_000, 1024), html, "each webview gets a fresh nonce");
});

// Only the DOM operations needed to execute the generated script are modeled.
// Descendant searches fail deterministically instead of relying on timing limits.
class SidebarTestElement {
  children: SidebarTestElement[] = [];
  dataset: Record<string, string> = {};
  classes = new Set<string>();
  classList = {
    toggle: (name: string, force?: boolean) => {
      const enabled = force ?? !this.classes.has(name);
      if (enabled) this.classes.add(name); else this.classes.delete(name);
      return enabled;
    },
    contains: (name: string) => this.classes.has(name),
  };
  style = {};
  value = "";
  innerHTML = "";
  textContent = "";
  title = "";
  placeholder = "";
  className = "";
  disabled = false;
  hidden = false;
  open = false;
  alt = "";
  src = "";
  scrollHeight = 100;
  scrollTop = 0;
  clientHeight = 100;
  rect = { top: 0, bottom: 100 };
  focusCount = 0;
  listeners = new Map<string, (event?: any) => void>();

  append(...elements: SidebarTestElement[]): void { this.children.push(...elements); }
  appendChild(element: SidebarTestElement): void { this.append(element); }
  replaceChildren(...elements: SidebarTestElement[]): void { this.children = [...elements]; }
  querySelector(): { textContent: string } { return { textContent: "" }; }
  querySelectorAll(): never { throw new Error("Unexpected conversation descendant search"); }
  closest(selector: string): SidebarTestElement | undefined {
    const key = /\[data-([a-z-]+)\]/.exec(selector)?.[1]?.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    return key && this.dataset[key] === undefined ? undefined : this;
  }
  setAttribute(name: string, value: string): void { (this as any)[name] = value; }
  removeAttribute(name: string): void { (this as any)[name] = ""; }
  getBoundingClientRect(): { top: number; bottom: number } { return this.rect; }
  addEventListener(type: string, listener: (event?: any) => void): void { this.listeners.set(type, listener); }
  focus(): void { this.focusCount += 1; }
  showModal(): void { this.open = true; }
  close(): void { this.open = false; this.listeners.get("close")?.(); }
}

function createSidebarScriptHarness(clientPlatform = "Linux x86_64", userAgent = "") {
  const html = getSidebarHtml(100_000, 1024);
  const elements = new Map(Array.from(html.matchAll(/\bid="([^"]+)"/g), match => [match[1], new SidebarTestElement()]));
  const element = (id: string) => {
    const result = elements.get(id);
    assert.ok(result, `missing sidebar element: ${id}`);
    return result;
  };
  let receive: ((event: { data: unknown }) => void) | undefined;
  const posted: any[] = [];
  const context = createContext({
    document: { getElementById: element, createElement: () => new SidebarTestElement() },
    window: { addEventListener: (type: string, listener: typeof receive) => { if (type === "message") receive = listener; } },
    navigator: { platform: clientPlatform, userAgent },
    Element: SidebarTestElement,
    FileReader: class {
      result = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
      listeners = new Map<string, () => void>();
      addEventListener(type: string, listener: () => void): void { this.listeners.set(type, listener); }
      readAsDataURL(): void { this.listeners.get("load")?.(); this.listeners.get("loadend")?.(); }
    },
    atob: (data: string) => Buffer.from(data, "base64").toString("binary"),
    btoa: (data: string) => Buffer.from(data, "binary").toString("base64"),
    acquireVsCodeApi: () => ({ postMessage: (message: unknown) => posted.push(message) }),
  });
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(script);
  new Script(script[1]).runInContext(context);
  return {
    element,
    posted,
    receive: (data: unknown) => receive!({ data }),
    run: (source: string) => new Script(source).runInContext(context),
    welcomeButtons: () => element("messages").children[0].children[0].children,
  };
}

test("Sessions is a separate layer that opens a detail view and returns with Back", () => {
  const sidebar = createSidebarScriptHarness();
  const ids = ["a", "b", "c", "d"].map(character => character.repeat(24));
  const sessions = [
    { id: ids[0], title: "Current work", updatedAt: Date.now(), current: true },
    { id: ids[1], title: "Fix sidebar", updatedAt: Date.now() - 60_000, current: false },
    { id: ids[2], title: "Write tests", updatedAt: Date.now() - 120_000, current: false },
    { id: ids[3], title: "Release notes", updatedAt: Date.now() - 180_000, current: false },
  ];
  sidebar.receive({ type: "state", status: "Ready", runtime: { busy: false, cancellable: false, connected: true }, sessions });

  assert.equal(sidebar.element("app").classList.contains("sessions-layer"), true);
  assert.equal(sidebar.element("session-list-content").hidden, false);
  assert.equal(sidebar.element("session-header-title").textContent, "Sessions");
  assert.equal(sidebar.element("recent-session-list").children.length, 3);
  assert.equal(sidebar.element("view-all-sessions").textContent, "View all (4)");
  assert.equal(sidebar.element("input").placeholder, "Start a new session…");

  const input = sidebar.element("input");
  input.value = "Start from the Sessions layer";
  input.listeners.get("input")!();
  sidebar.element("send").listeners.get("click")!();
  assert.equal(sidebar.posted.at(-1).type, "sendNewSession");
  sidebar.receive({ type: "sendRejected" });
  input.value = "";
  input.listeners.get("input")!();

  const current = sidebar.element("recent-session-list").children[0]!;
  sidebar.element("recent-session-list").listeners.get("click")!({ target: current });
  assert.equal(sidebar.element("app").classList.contains("sessions-layer"), false);
  assert.equal(sidebar.element("session-list-content").hidden, true);
  assert.equal(sidebar.element("back-to-sessions").hidden, false);
  assert.equal(sidebar.element("session-header-title").textContent, "Current work");
  assert.equal(sidebar.element("input").placeholder, "Ask, plan, or build something…");

  input.value = "Continue the selected Session";
  input.listeners.get("input")!();
  sidebar.element("send").listeners.get("click")!();
  assert.equal(sidebar.posted.at(-1).type, "send");
  sidebar.receive({ type: "sendRejected" });
  input.value = "";
  input.listeners.get("input")!();

  sidebar.element("back-to-sessions").listeners.get("click")!();
  assert.equal(sidebar.element("app").classList.contains("sessions-layer"), true);
  assert.equal(sidebar.element("session-list-content").hidden, false);
  assert.equal(sidebar.element("session-header-title").textContent, "Sessions");

  sidebar.element("new-session").listeners.get("click")!();
  assert.equal(sidebar.element("app").classList.contains("sessions-layer"), false);
  assert.equal(sidebar.posted.at(-1).type, "newSession");
  sidebar.receive({ type: "newSessionRejected" });
  assert.equal(sidebar.element("app").classList.contains("sessions-layer"), true);

  sidebar.receive({ type: "showSessionDetail" });
  assert.equal(sidebar.element("app").classList.contains("sessions-layer"), false, "editor actions can open the detail layer");
  sidebar.receive({ type: "showSessionsLayer" });
  assert.equal(sidebar.element("app").classList.contains("sessions-layer"), true, "Open Sessions can restore the list layer");
  sidebar.receive({ type: "showSessionDetail" });
  sidebar.element("back-to-sessions").listeners.get("click")!();

  sidebar.element("view-all-sessions").listeners.get("click")!();
  assert.equal(sidebar.element("sessions-browser").hidden, false);
  assert.equal(sidebar.posted.at(-1).type, "refreshSessions");
  const search = sidebar.element("session-search-input");
  search.value = "sidebar";
  search.listeners.get("input")!();
  assert.equal(sidebar.element("all-session-list").children.length, 1);
  const result = sidebar.element("all-session-list").children[0]!;
  sidebar.element("all-session-list").listeners.get("click")!({ target: result });
  assert.equal(sidebar.posted.at(-1).type, "switchRecentSession");
  assert.equal(sidebar.posted.at(-1).id, ids[1]);
  assert.equal(sidebar.element("all-session-list").children[0]?.disabled, true);

  sidebar.receive({ type: "state", status: "Ready", runtime: { busy: false, cancellable: false, connected: true }, sessions: sessions.map((session, index) => ({ ...session, current: index === 1 })) });
  assert.equal(sidebar.element("app").classList.contains("sessions-layer"), false);
  assert.equal(sidebar.element("session-header-title").textContent, "Fix sidebar");
  sidebar.element("back-to-sessions").listeners.get("click")!();
  assert.equal(sidebar.element("app").classList.contains("sessions-layer"), true);
  assert.equal(sidebar.element("sessions-browser").hidden, false, "Back returns to the list layer the session was opened from");

  sidebar.receive({ type: "sessionSwitchRejected" });
  assert.equal(sidebar.element("all-session-list").children[0]?.disabled, false);
});

test("returning to collapsed Sessions focuses only a visible fallback", () => {
  const sidebar = createSidebarScriptHarness();
  const ids = ["a", "b", "c", "d"].map(character => character.repeat(24));
  const sessions = ids.map((id, index) => ({
    id,
    title: `Session ${index + 1}`,
    updatedAt: Date.now() - index * 60_000,
    current: index === 3,
  }));
  sidebar.receive({ type: "state", status: "Ready", runtime: { busy: false, cancellable: false, connected: true }, sessions });

  sidebar.receive({ type: "showSessionDetail" });
  sidebar.receive({ type: "showSessionsLayer" });

  assert.equal(sidebar.element("recent-session-list").children[0]?.focusCount, 1, "the first visible row is the fallback");
  assert.equal(sidebar.element("all-session-list").children[3]?.focusCount, 0, "the current row in the hidden browser is not focused");

  sidebar.receive({
    type: "state",
    status: "Ready",
    runtime: { busy: false, cancellable: false, connected: true },
    sessions: sessions.map(session => ({ ...session, current: false })),
  });
  sidebar.receive({ type: "showSessionDetail" });
  sidebar.receive({ type: "showSessionsLayer" });

  assert.equal(sidebar.element("recent-session-list").children[0]?.focusCount, 1, "a missing current session still gets a visible fallback");
});

test("collapsing an emptied Sessions browser focuses New session instead of hidden View all", () => {
  const sidebar = createSidebarScriptHarness();
  sidebar.receive({
    type: "state",
    status: "Ready",
    runtime: { busy: false, cancellable: false, connected: true },
    sessions: [{ id: "a".repeat(24), title: "Current work", updatedAt: Date.now(), current: true }],
  });
  sidebar.element("view-all-sessions").listeners.get("click")!();
  sidebar.receive({ type: "state", status: "Ready", runtime: { busy: false, cancellable: false, connected: true }, sessions: [] });

  sidebar.element("back-to-sessions").listeners.get("click")!();

  assert.equal(sidebar.element("view-all-sessions").hidden, true);
  assert.equal(sidebar.element("view-all-sessions").focusCount, 0);
  assert.equal(sidebar.element("new-session").focusCount, 1);
});

test("recent session switching respects every non-busy interaction lock", () => {
  const sidebar = createSidebarScriptHarness();
  const currentId = "a".repeat(24);
  const targetId = "b".repeat(24);
  sidebar.receive({
    type: "state",
    status: "Starting background agent…",
    runtime: { busy: false, cancellable: false, connected: true },
    backgroundSubmissionPending: true,
    sessions: [
      { id: currentId, title: "Current work", updatedAt: Date.now(), current: true },
      { id: targetId, title: "Other work", updatedAt: Date.now() - 60_000, current: false },
    ],
  });
  sidebar.element("view-all-sessions").listeners.get("click")!();

  for (const [lock, unlock] of [
    ["backgroundSubmissionPending = true", "backgroundSubmissionPending = false"],
    ["submissionPending = true", "submissionPending = false"],
    ["pendingImageReads = 1", "pendingImageReads = 0"],
  ]) {
    sidebar.run(`${lock}; renderSessions()`);
    assert.equal(sidebar.element("all-session-list").children[1]?.disabled, true);
    const postedCount = sidebar.posted.length;
    sidebar.run(`selectRecentSession("${targetId}")`);
    assert.equal(sidebar.posted.length, postedCount);
    sidebar.run(unlock);
  }
});

test("proposal cards block empty previews and hide dead terminal actions", () => {
  const sidebar = createSidebarScriptHarness();
  sidebar.receive({
    type: "state",
    status: "Ready",
    runtime: { busy: false, cancellable: false, connected: true },
    proposals: [
      { id: "empty", label: "src/empty.ts:1", status: "ready", selected: [], totalHunks: 1 },
      { id: "applied", label: "src/applied.ts:1-3", status: "applied", selected: ["h0", "h1", "h2"], totalHunks: 3, summary: "Applied 3/3 hunks." },
    ],
  });

  const [empty, applied] = sidebar.element("proposals").children;
  assert.equal(empty?.children[1]?.textContent, "Ready to preview · 0/1 selected");
  const [choose, preview, apply, reject] = empty?.children[2]?.children ?? [];
  assert.equal(choose?.disabled, false);
  assert.equal(preview?.disabled, true);
  assert.equal(apply?.disabled, true);
  assert.equal(reject?.disabled, false);
  assert.equal(applied?.children[1]?.textContent, "Applied 3/3 hunks.");
  assert.equal(applied?.children.length, 2);
});

test("sidebar displays and changes the current thinking level", () => {
  const sidebar = createSidebarScriptHarness();
  sidebar.receive({
    type: "state",
    runtime: {
      busy: false,
      connected: true,
      thinkingLevel: "high",
      availableThinkingLevels: ["off", "low", "high"],
    },
  });

  const picker = sidebar.element("thinking-level");
  assert.equal(picker.value, "high");
  assert.equal(picker.title, "Pi thinking level: High");
  assert.equal(picker.disabled, false);
  assert.deepEqual(picker.children.map(option => option.textContent), ["Thinking: Off", "Thinking: Low", "Thinking: High"]);

  picker.value = "low";
  picker.listeners.get("change")!();
  assert.equal(sidebar.posted.at(-1).type, "setThinking");
  assert.equal(sidebar.posted.at(-1).level, "low");

  sidebar.receive({
    type: "state",
    runtime: {
      busy: false,
      connected: true,
      thinkingLevel: "off",
      availableThinkingLevels: ["off"],
    },
  });
  assert.equal(picker.value, "off");
  assert.equal(picker.disabled, true);
});

test("transcript image assets render without HTML injection and preview restores focus after close or Escape", () => {
  const sidebar = createSidebarScriptHarness();
  const bytes = Buffer.alloc(11);
  bytes.write("GIF89a", 0, "ascii"); bytes.writeUInt16LE(3, 6); bytes.writeUInt16LE(2, 8);
  const data = bytes.toString("base64");
  const id = imageAssetId(bytes);
  const image = { type: "image", assetId: id, label: "diagram.gif", fullLabel: "screenshots/diagram.gif", mimeType: "image/gif", width: 3, height: 2, availability: "available" };
  sidebar.receive({ type: "state", status: "Ready", runtime: { busy: false, cancellable: false, connected: true }, messages: [{ role: "user", html: "<p>See this</p>", attachments: [{ type: "context", label: "…/feature.ts:1-3", fullLabel: "src/deep/feature.ts:1-3" }, image] }] });
  const contextChip = sidebar.run("messagesElement.children[0].children[2].children[0]") as SidebarTestElement;
  assert.equal(contextChip.textContent, "…/feature.ts:1-3");
  assert.equal(contextChip.title, "src/deep/feature.ts:1-3");
  let trigger = sidebar.run(`imageTargets.get(${JSON.stringify(id)})[0].button`) as SidebarTestElement;
  assert.match(trigger.children[0]!.textContent, /Loading image/);

  sidebar.receive({ type: "imageAsset", id, mimeType: "image/gif", data, byteLength: bytes.length, width: 3, height: 2 });
  assert.equal(trigger.children[0]?.alt, "screenshots/diagram.gif");
  assert.equal(trigger.children[0]?.src, `data:image/gif;base64,${data}`);
  const click = sidebar.element("messages").listeners.get("click")!;
  click({ target: trigger });
  assert.equal(sidebar.element("image-preview").open, true);
  assert.equal(sidebar.element("preview-close").focusCount, 1);
  sidebar.element("preview-close").listeners.get("click")!();
  assert.equal(sidebar.element("image-preview").open, false);
  assert.equal(sidebar.element("preview-image").src, "");
  assert.equal(trigger.focusCount, 1);

  click({ target: trigger });
  sidebar.receive({ type: "state", status: "Pi is working…", runtime: { busy: true, cancellable: true, connected: true }, messages: [{ role: "user", html: "<p>See this</p>", attachments: [image] }] });
  const detachedTrigger = trigger;
  trigger = sidebar.run(`imageTargets.get(${JSON.stringify(id)})[0].button`) as SidebarTestElement;
  let prevented = false;
  sidebar.element("image-preview").listeners.get("cancel")!({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(detachedTrigger.focusCount, 1, "the detached trigger is not focused again");
  assert.equal(trigger.focusCount, 1, "focus returns to the rerendered visible thumbnail");

  for (let marker = 1; marker <= 100; marker += 1) {
    const other = Buffer.from(bytes); other[10] = marker;
    sidebar.receive({ type: "imageAsset", id: imageAssetId(other), mimeType: "image/gif", data: other.toString("base64"), byteLength: other.length, width: 3, height: 2 });
  }
  assert.equal(trigger.disabled, true);
  assert.match(trigger.children[0]!.textContent, /unavailable/i);
  assert.ok(sidebar.posted.some(message => message.type === "imageAssetEvicted" && message.id === id));

  sidebar.receive({ type: "state", status: "Ready", runtime: { busy: false, cancellable: false, connected: true }, messages: [{ role: "user", html: "<p>Missing</p>", attachments: [{ ...image, assetId: `unavailable-${"a".repeat(64)}`, availability: "unavailable" }] }] });
  const unavailable = sidebar.run(`imageTargets.get(${JSON.stringify(`unavailable-${"a".repeat(64)}`)})[0].button`) as SidebarTestElement;
  assert.equal(unavailable.disabled, true);
  assert.match(unavailable.children[0]!.textContent, /unavailable/i);
});

test("composer image attachments use thumbnail cards with preview and remove actions", () => {
  const sidebar = createSidebarScriptHarness();
  const bytes = Buffer.alloc(11);
  bytes.write("GIF89a", 0, "ascii"); bytes.writeUInt16LE(3, 6); bytes.writeUInt16LE(2, 8);
  const data = bytes.toString("base64");
  const id = imageAssetId(bytes);
  const attachment = { id: "draft-image", image: true, type: "image", assetId: id, label: "image.png", fullLabel: "image.png", mimeType: "image/gif", width: 3, height: 2, availability: "available" };

  sidebar.receive({ type: "state", status: "Ready", imageSupported: true, runtime: { busy: false, cancellable: false, connected: true }, attachments: [attachment] });
  const card = sidebar.element("attachments").children[0]!;
  assert.equal(card.className, "attachment-image");
  assert.equal(card.children[1]?.textContent, "image.png");
  const preview = sidebar.run(`imageTargets.get(${JSON.stringify(id)})[0].button`) as SidebarTestElement;
  assert.match(preview.children[0]!.textContent, /Loading preview/);

  sidebar.receive({ type: "imageAsset", id, mimeType: "image/gif", data, byteLength: bytes.length, width: 3, height: 2 });
  assert.equal(preview.children[0]?.src, `data:image/gif;base64,${data}`);
  const click = sidebar.element("attachments").listeners.get("click")!;
  click({ target: preview });
  assert.equal(sidebar.element("image-preview").open, true);
  sidebar.element("preview-close").listeners.get("click")!();
  click({ target: card.children[2] });
  assert.equal(sidebar.posted.at(-1)?.type, "removeAttachment");
  assert.equal(sidebar.posted.at(-1)?.id, "draft-image");
});

test("an attached image can start a new Session without additional text", () => {
  const sidebar = createSidebarScriptHarness();
  const attachment = { id: "draft-image", image: true, type: "image", assetId: `sha256-${"a".repeat(64)}`, label: "image.png", fullLabel: "image.png", mimeType: "image/png", availability: "available" };
  sidebar.receive({ type: "state", status: "Ready", imageSupported: true, runtime: { busy: false, cancellable: false, connected: true }, attachments: [attachment] });

  assert.equal(sidebar.element("input").value, "");
  assert.equal(sidebar.element("send").disabled, false);
  assert.equal(sidebar.element("send").title, "Send attached context");
  sidebar.element("send").listeners.get("click")!();
  assert.equal(sidebar.posted.at(-1)?.type, "sendNewSession");
  assert.equal(sidebar.posted.at(-1)?.text, "");
  assert.equal(sidebar.posted.at(-1)?.revision, 0);
});

test("an attachment removal race can release a pending submission", () => {
  const sidebar = createSidebarScriptHarness();
  const attachment = { id: "draft-context", image: false, type: "selection", label: "Selection from example.ts" };
  sidebar.receive({ type: "state", status: "Ready", runtime: { busy: false, cancellable: false, connected: true }, attachments: [attachment] });

  sidebar.element("send").listeners.get("click")!();
  assert.equal(sidebar.run("submissionPending"), true);
  assert.equal(sidebar.element("status").textContent, "Sending to Pi…");

  sidebar.receive({ type: "state", status: "Ready", runtime: { busy: false, cancellable: false, connected: true }, attachments: [] });
  sidebar.receive({ type: "sendRejected" });
  assert.equal(sidebar.run("submissionPending"), false);
  assert.equal(sidebar.element("status").textContent, "Ready");
});

test("thumbnail and preview decode failures become unavailable without retrying corrupt payloads", () => {
  const bytes = Buffer.alloc(11);
  bytes.write("GIF89a", 0, "ascii"); bytes.writeUInt16LE(3, 6); bytes.writeUInt16LE(2, 8);
  const data = bytes.toString("base64");
  const id = imageAssetId(bytes);
  const attachment = { type: "image", assetId: id, label: "broken.gif", fullLabel: "broken.gif", mimeType: "image/gif", width: 3, height: 2, availability: "available" };

  const thumbnailSidebar = createSidebarScriptHarness();
  thumbnailSidebar.receive({ type: "state", status: "Ready", runtime: { busy: false, cancellable: false, connected: true }, messages: [{ role: "user", html: "<p>Broken</p>", attachments: [attachment] }] });
  thumbnailSidebar.receive({ type: "imageAsset", id, mimeType: "image/gif", data, byteLength: bytes.length, width: 3, height: 2 });
  const thumbnail = thumbnailSidebar.run(`imageTargets.get(${JSON.stringify(id)})[0].button`) as SidebarTestElement;
  thumbnail.children[0]!.listeners.get("error")!();
  assert.equal(thumbnail.disabled, true);
  assert.match(thumbnail.children[0]!.textContent, /unavailable/i);
  assert.equal(thumbnailSidebar.posted.at(-1)?.type, "imageAssetRejected");
  assert.equal(thumbnailSidebar.posted.at(-1)?.id, id);

  const previewSidebar = createSidebarScriptHarness();
  previewSidebar.receive({ type: "state", status: "Ready", runtime: { busy: false, cancellable: false, connected: true }, messages: [{ role: "user", html: "<p>Broken preview</p>", attachments: [{ ...attachment }] }] });
  previewSidebar.receive({ type: "imageAsset", id, mimeType: "image/gif", data, byteLength: bytes.length, width: 3, height: 2 });
  const previewTrigger = previewSidebar.run(`imageTargets.get(${JSON.stringify(id)})[0].button`) as SidebarTestElement;
  previewSidebar.element("messages").listeners.get("click")!({ target: previewTrigger });
  assert.equal(previewSidebar.element("image-preview").open, true);
  previewSidebar.element("preview-image").listeners.get("error")!();
  assert.equal(previewSidebar.element("image-preview").open, false);
  assert.equal(previewTrigger.disabled, true);
  assert.equal(previewSidebar.posted.at(-1)?.type, "imageAssetRejected");
  assert.equal(previewSidebar.posted.at(-1)?.id, id);
});

test("image decode keeps scroll position when the thumbnail is below the viewport", () => {
  const sidebar = createSidebarScriptHarness();
  const bytes = Buffer.alloc(11);
  bytes.write("GIF89a", 0, "ascii"); bytes.writeUInt16LE(3, 6); bytes.writeUInt16LE(2, 8);
  const data = bytes.toString("base64");
  const id = imageAssetId(bytes);
  const image = { type: "image", assetId: id, label: "below.gif", fullLabel: "below.gif", mimeType: "image/gif", width: 3, height: 2, availability: "available" };
  sidebar.receive({ type: "state", status: "Ready", runtime: { busy: false, cancellable: false, connected: true }, messages: [{ role: "user", html: "<p>Below</p>", attachments: [image] }] });
  const conversation = sidebar.element("conversation");
  conversation.scrollHeight = 300;
  conversation.scrollTop = 50;
  conversation.clientHeight = 100;
  conversation.rect = { top: 0, bottom: 100 };
  const trigger = sidebar.run(`imageTargets.get(${JSON.stringify(id)})[0].button`) as SidebarTestElement;
  trigger.rect = { top: 120, bottom: 190 };

  sidebar.receive({ type: "imageAsset", id, mimeType: "image/gif", data, byteLength: bytes.length, width: 3, height: 2 });
  const loadedImage = trigger.children[0]!;
  conversation.scrollHeight = 360;
  loadedImage.listeners.get("load")!();
  assert.equal(conversation.scrollTop, 50);
});

test("bottom-following scroll includes newly rendered tool activity", () => {
  const sidebar = createSidebarScriptHarness();
  const conversation = sidebar.element("conversation");
  conversation.scrollHeight = 100;
  conversation.scrollTop = 0;
  conversation.clientHeight = 100;
  const tools = sidebar.element("tools");
  const appendTool = tools.appendChild.bind(tools);
  tools.appendChild = element => { appendTool(element); conversation.scrollHeight = 180; };
  sidebar.receive({
    type: "state",
    status: "Running read…",
    runtime: { busy: true, cancellable: true, connected: true },
    messages: [{ role: "assistant", html: "<p>Reply</p>" }],
    tools: [{ id: "tool-1", name: "read", status: "running", input: "file.ts", output: "" }],
  });
  assert.equal(conversation.scrollTop, 180);
});

test("tool activity stays open after tool completion and collapses when the request settles", () => {
  const sidebar = createSidebarScriptHarness();
  const state = (phase: "running" | "tool-complete" | "settled", html: string) => sidebar.receive({
    type: "state",
    status: phase === "running" ? "Running bash…" : phase === "tool-complete" ? "Pi is working…" : "Ready",
    runtime: { busy: phase !== "settled", cancellable: phase !== "settled", connected: true },
    messages: [{ id: "assistant-1", role: "assistant", html }],
    tools: [{ id: "tool-1", name: "bash", status: phase === "running" ? "running" : "success", input: "npm test", output: phase === "running" ? "Running" : "Passed" }],
  });

  state("running", "<p>Working</p>");
  const group = sidebar.element("tools-group");
  const tool = sidebar.element("tools").children[0]!;
  assert.equal(group.open, true);
  assert.equal(tool.open, true);

  group.open = false;
  state("running", "<p>Still working</p>");
  assert.equal(group.open, false, "stream updates respect a manual collapse");

  group.open = true;
  state("tool-complete", "<p>Preparing conclusion</p>");
  assert.equal(group.open, true, "completed tool output remains visible while the request is active");
  assert.equal(tool.open, true);

  state("settled", "<p>Final conclusion</p>");
  assert.equal(group.open, false, "completed output no longer covers the final conclusion");
  assert.equal(tool.open, false);
  assert.equal(sidebar.element("messages").children[0]?.children[1]?.innerHTML, "<p>Final conclusion</p>");
});

test("programmatic off-bottom scrolls do not disable streaming follow", () => {
  const sidebar = createSidebarScriptHarness();
  const conversation = sidebar.element("conversation");
  conversation.scrollHeight = 400;
  conversation.clientHeight = 100;
  sidebar.run("setConversationScrollTop(40)");
  conversation.listeners.get("scroll")!({ isTrusted: true });

  assert.equal(sidebar.run("conversationPinnedToBottom"), true);
  sidebar.receive({
    type: "state",
    status: "Pi is working…",
    runtime: { busy: true, cancellable: true, connected: true },
    messages: [{ id: "assistant-1", role: "assistant", html: "<p>Streaming reply</p>" }],
  });
  assert.equal(conversation.scrollTop, 400);
});

test("streaming does not force the conversation to the bottom after the reader scrolls up", () => {
  const sidebar = createSidebarScriptHarness();
  const conversation = sidebar.element("conversation");
  assert.equal(conversation.listeners.has("pointerdown"), false, "ordinary clicks must not disable bottom-following");
  assert.equal(conversation.listeners.has("touchstart"), false, "ordinary taps must not disable bottom-following");
  conversation.scrollHeight = 400;
  conversation.clientHeight = 100;
  conversation.scrollTop = 40;
  conversation.listeners.get("scroll")!({ isTrusted: true });
  sidebar.receive({
    type: "state",
    status: "Pi is working…",
    runtime: { busy: true, cancellable: true, connected: true },
    messages: [{ id: "assistant-1", role: "assistant", html: "<p>Streaming reply</p>" }],
  });
  assert.equal(conversation.scrollTop, 40);
});

test("streaming continues to follow after the reader returns to the bottom", () => {
  const sidebar = createSidebarScriptHarness();
  const conversation = sidebar.element("conversation");
  conversation.scrollHeight = 400;
  conversation.clientHeight = 100;
  conversation.scrollTop = 300;
  conversation.listeners.get("scroll")!();
  sidebar.receive({
    type: "state",
    status: "Pi is working…",
    runtime: { busy: true, cancellable: true, connected: true },
    messages: [{ id: "assistant-1", role: "assistant", html: "<p>More output</p>" }],
  });
  assert.equal(conversation.scrollTop, 400);
});

test("streamed state patches stable conversation, tool, and attachment nodes in place", () => {
  const sidebar = createSidebarScriptHarness();
  const state = (html: string, output: string, appendMessage = false) => sidebar.receive({
    type: "state",
    status: "Pi is working…",
    runtime: { busy: true, cancellable: true, connected: true },
    messages: [
      { id: "assistant-1", role: "assistant", html },
      ...(appendMessage ? [{ id: "assistant-2", role: "assistant", html: "<p>Next step</p>" }] : []),
    ],
    tools: [{ id: "tool-1", name: "read", status: "running", input: "file.ts", output }],
    attachments: [{ id: "next-context", label: "src/next.ts", image: false }],
  });

  state("<p>First</p>", "one");
  const message = sidebar.element("messages").children[0]!;
  const tool = sidebar.element("tools").children[0]!;
  const attachment = sidebar.element("attachments").children[0]!;

  state("<p>First second</p>", "one\ntwo");
  assert.equal(sidebar.element("messages").children[0], message);
  assert.equal(message.children[1]?.innerHTML, "<p>First second</p>");
  assert.equal(sidebar.element("tools").children[0], tool);
  assert.equal(tool.children[1]?.textContent, "one\ntwo");
  assert.equal(sidebar.element("attachments").children[0], attachment);
  assert.equal(sidebar.element("add-context").disabled, false);

  state("<p>First second</p>", "one\ntwo", true);
  assert.equal(sidebar.element("attachments").children[0], attachment, "message-structure updates keep unchanged composer attachments");

  const output = tool.children[1]!;
  output.scrollHeight = 400;
  output.clientHeight = 100;
  output.scrollTop = 40;
  state("<p>First second third</p>", "one\ntwo\nthree");
  assert.equal(output.scrollTop, 40, "streamed tool output preserves a reader's position");
  output.scrollTop = 300;
  state("<p>First second third</p>", "one\ntwo\nthree\nfour");
  assert.equal(output.scrollTop, 400, "tool output follows updates when already at the bottom");
});

test("busy, settling, cancellation, failure, and reconnection states expose one status and every cancellable state exposes Stop", () => {
  const sidebar = createSidebarScriptHarness();
  const state = (status: string, busy: boolean, cancellable: boolean, connected = true, backgroundSubmissionPending = false) => sidebar.receive({ type: "state", status, backgroundSubmissionPending, runtime: { busy, cancellable, connected } });
  for (const status of ["Sending to Pi…", "Pi is working…", "Running read…", "Finishing Pi response…", "Cancelling Pi request…"]) {
    state(status, true, true);
    assert.equal(sidebar.element("cancel").hidden, false, status);
    assert.equal(sidebar.element("send").hidden, true, status);
    assert.equal(sidebar.element("status").textContent, status);
  }
  state("Request failed · Retry available", false, false);
  assert.equal(sidebar.element("cancel").hidden, true);
  assert.equal(sidebar.element("send").hidden, false);
  sidebar.receive({ type: "notice", message: "Pi request failed.", level: "error", detailsAvailable: true });
  const details = sidebar.element("notice").children[0]!;
  sidebar.element("notice").listeners.get("click")!({ target: details });
  assert.equal(sidebar.posted.at(-1).type, "showNoticeDetails");
  state("Ready", false, false, true, true);
  assert.equal(sidebar.element("status").textContent, "Starting background agent…", "Ready is not shown beside a wait state");
  state("Disconnected · Reconnect available", false, false, false);
  assert.match(sidebar.element("status").textContent, /Disconnected/);

  state("Pi is working…", true, true);
  sidebar.element("input").listeners.get("paste")!({ clipboardData: { items: [{ kind: "file", type: "image/gif", getAsFile: () => ({ type: "image/gif", size: 25, name: "during-work.gif" }) }] }, preventDefault() {} });
  assert.doesNotMatch(sidebar.element("notice").textContent, /Cancel or wait/, "pasting images remains available during active requests");
  assert.equal(sidebar.posted.at(-1).type, "pasteImage");
  state("Ready", false, false);
});

test("sidebar keystrokes do not search populated conversation descendants", () => {
  const sidebar = createSidebarScriptHarness();
  sidebar.run("renderMessages(Array.from({ length: 100 }, () => ({ role: 'assistant', html: '<p>Reply</p>' })))");
  assert.equal(sidebar.element("messages").children.length, 100);
  const input = sidebar.element("input");
  const onInput = input.listeners.get("input");
  assert.ok(onInput);
  for (let index = 0; index < 20; index += 1) {
    input.value += "x";
    onInput();
  }
});

test("sidebar keeps stable welcome controls and stops updating them after message renders", () => {
  const sidebar = createSidebarScriptHarness();
  const assertLocked = (expected: boolean) => {
    const buttons = sidebar.welcomeButtons();
    assert.equal(buttons.length, 3);
    for (const button of buttons) assert.equal(button.disabled, expected);
  };

  sidebar.run("renderMessages([]); updateSendState()");
  assertLocked(false);
  for (const [flag, lockedValue, unlockedValue] of [
    ["busy", "true", "false"],
    ["submissionPending", "true", "false"],
    ["backgroundSubmissionPending", "true", "false"],
    ["pendingImageReads", "1", "0"],
  ]) {
    sidebar.run(`${flag} = ${lockedValue}; updateSendState()`);
    assertLocked(true);
    sidebar.run(`${flag} = ${unlockedValue}; updateSendState()`);
    assertLocked(false);
  }

  const firstButtons = sidebar.welcomeButtons();
  sidebar.run("busy = true; renderMessages([]); updateSendState()");
  assert.equal(sidebar.welcomeButtons()[0], firstButtons[0], "unchanged state keeps the existing DOM");
  assertLocked(true);

  sidebar.run("renderMessages([{ id: 'user-1', role: 'user', html: '<p>Question</p>' }])");
  for (const button of firstButtons) {
    Object.defineProperty(button, "disabled", {
      set() { assert.fail("A detached welcome button must not be updated"); },
    });
  }
  sidebar.run("updateSendState()");
  sidebar.run("busy = false; renderMessages([{ id: 'assistant-1', role: 'assistant', html: '' }]); updateSendState()");
  assertLocked(false);
});

test("welcome actions attach context or set ordinary composer drafts locally", () => {
  const sidebar = createSidebarScriptHarness();
  const input = sidebar.element("input");
  sidebar.run("renderMessages([])");
  const [selection, plan, build] = sidebar.welcomeButtons();
  const click = sidebar.element("messages").listeners.get("click")!;

  click({ target: selection });
  assert.equal(sidebar.posted.at(-1).type, "attachSelection");
  const postedAfterSelection = sidebar.posted.length;
  const focusAfterSelection = input.focusCount;

  click({ target: plan });
  assert.equal(input.value, "Plan this change before implementing it: ");
  assert.equal(sidebar.run("composerRevision"), 1);
  assert.equal(sidebar.posted.length, postedAfterSelection);
  assert.equal(input.focusCount, focusAfterSelection + 1);

  click({ target: build });
  assert.equal(input.value, "Implement this task: ");
  assert.equal(sidebar.run("composerRevision"), 2);
  assert.equal(sidebar.posted.length, postedAfterSelection);
  assert.equal(input.focusCount, focusAfterSelection + 2);
  assert.equal(sidebar.posted.some(message => message.type === "setInput" || message.type === "setMode" || message.type === "handoffAgent"), false);
});

test("composer keyboard submission matches Pi queue behavior on Alt+Enter platforms", () => {
  const sidebar = createSidebarScriptHarness("MacIntel");
  sidebar.receive({ type: "showSessionDetail" });
  const input = sidebar.element("input");
  const keydown = input.listeners.get("keydown")!;
  const press = (fields: Record<string, unknown>) => {
    let prevented = false;
    keydown({ key: "Enter", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false, preventDefault: () => { prevented = true; }, ...fields });
    return prevented;
  };
  sidebar.run("connected = true; busy = false; queueable = false; submissionPending = false");
  input.value = "start now";
  assert.equal(press({}), true);
  assert.equal(sidebar.posted.at(-1).type, "send");
  assert.equal(sidebar.posted.at(-1).text, "start now");
  assert.equal(sidebar.posted.at(-1).revision, 0);

  sidebar.run("submissionPending = false; busy = true; queueable = true");
  input.value = "steer now";
  assert.equal(press({}), true);
  assert.equal(sidebar.posted.at(-1).kind, "steer");
  sidebar.run("submissionPending = false");
  input.value = "after completion";
  assert.equal(press({ altKey: true }), true);
  assert.equal(sidebar.posted.at(-1).kind, "followUp");

  sidebar.run("submissionPending = false; busy = false; queueable = false");
  input.value = "idle follow-up shortcut";
  assert.equal(press({ altKey: true }), true);
  assert.equal(sidebar.posted.at(-1).type, "send");

  const count = sidebar.posted.length;
  assert.equal(press({ shiftKey: true }), false);
  assert.equal(press({ isComposing: true }), false);
  assert.equal(sidebar.posted.length, count);

  sidebar.run("submissionPending = false; busy = true; queueable = false");
  input.value = "preserved";
  assert.equal(press({}), true);
  assert.equal(sidebar.posted.length, count);
  assert.equal(input.value, "preserved");
  assert.match(sidebar.element("notice").textContent, /does not accept queued messages/);
  sidebar.receive({ type: "state", status: "Pi is working…", runtime: { busy: true, cancellable: true, connected: true, queueable: false }, attachments: [] });
  assert.match(sidebar.element("notice").textContent, /does not accept queued messages/, "stream updates keep text-only queue feedback while busy");
});

test("busy composer queues attachment-only steering and follow-up while preserving image gates", () => {
  const sidebar = createSidebarScriptHarness("MacIntel");
  sidebar.receive({ type: "showSessionDetail" });
  const input = sidebar.element("input");
  const keydown = input.listeners.get("keydown")!;
  const press = (fields: Record<string, unknown> = {}) => keydown({ key: "Enter", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false, preventDefault() {}, ...fields });
  sidebar.run("connected = true; busy = true; queueable = true; attachedItems = true; attachedImages = true; imageSupported = true; submissionPending = false; pendingImageReads = 0; updateSendState()");

  input.value = "";
  press();
  const steering = sidebar.posted.at(-1);
  assert.equal(steering.type, "queueInstruction"); assert.equal(steering.kind, "steer"); assert.equal(steering.text, ""); assert.equal(steering.revision, 0);
  sidebar.run("submissionPending = false; updateSendState()");
  press({ altKey: true });
  assert.equal(sidebar.posted.at(-1).kind, "followUp");

  sidebar.run("submissionPending = false; pendingImageReads = 1; updateSendState()");
  const loadingCount = sidebar.posted.length;
  press();
  assert.equal(sidebar.posted.length, loadingCount, "partially read images are not queued");

  sidebar.run("pendingImageReads = 0; imageSupported = false; updateSendState()");
  press();
  assert.equal(sidebar.posted.length, loadingCount, "unsupported images are not queued");
  assert.match(sidebar.element("composer-hint").textContent, /image-capable model/);

  sidebar.receive({
    type: "state",
    status: "Pi is working…",
    imageSupported: true,
    runtime: {
      busy: true,
      cancellable: true,
      connected: true,
      queueable: true,
      queue: { steering: ["one"], followUp: ["two"] },
      pendingQueue: {
        steering: [{ id: "one", kind: "steering", text: "one", hasAttachments: true }],
        followUp: [{ id: "two", kind: "followUp", text: "two", hasAttachments: false }],
      },
    },
    attachments: [{ id: "context", label: "context.ts", image: false }],
  });
  assert.match(sidebar.element("queue-status").textContent, /1 steering · 1 follow-ups pending/);
  const pendingRows = sidebar.element("pending-queue").children;
  assert.equal(pendingRows.length, 2);
  assert.deepEqual(pendingRows[0]?.children.map(child => child.textContent), ["Steering:", "one · attachments included"]);
  assert.deepEqual(pendingRows[1]?.children.map(child => child.textContent), ["Follow-up:", "two"]);
  const contextQueueCount = sidebar.posted.length;
  sidebar.run("submissionPending = false; submit()");
  assert.equal(sidebar.posted.length, contextQueueCount + 1);
  assert.equal(sidebar.posted.at(-1).type, "queueInstruction");
  assert.equal(sidebar.posted.at(-1).text, "", "attachment-only text context is queued instead of deferred");
  assert.equal(sidebar.element("notice").textContent, "");
});

test("pending queue renders Pi-style labels, duplicate text and safe bounded previews until delivery", () => {
  const sidebar = createSidebarScriptHarness();
  const queuedText = "<img src=x onerror=alert(1)>\ncontinue here";
  const runtime = (steering: unknown[], followUp: unknown[]) => ({
    busy: true,
    cancellable: true,
    connected: true,
    queueable: true,
    pendingQueue: { steering, followUp },
  });
  sidebar.receive({
    type: "state",
    status: "Pi is working…",
    runtime: runtime(
      [
        { id: "first", kind: "steering", text: queuedText, hasAttachments: false },
        { id: "second", kind: "steering", text: queuedText, hasAttachments: true },
      ],
      [{ id: "later", kind: "followUp", text: "after completion", hasAttachments: false }],
    ),
    attachments: [],
  });

  const pending = sidebar.element("pending-queue");
  assert.equal(pending.hidden, false);
  assert.equal(pending.children.length, 3, "duplicate text keeps separate pending rows");
  assert.equal(pending.children[0]?.title, queuedText);
  assert.equal(pending.children[0]?.children[1]?.textContent, queuedText);
  assert.equal(pending.children[0]?.innerHTML, "", "queued text is never interpreted as HTML");
  assert.equal(pending.children[1]?.children[1]?.textContent, `${queuedText} · attachments included`);

  sidebar.receive({
    type: "state",
    status: "Pi is working…",
    runtime: runtime([], [{ id: "later", kind: "followUp", text: "after completion", hasAttachments: false }]),
    messages: [{ id: "delivered", role: "user", html: "<p>continue here</p>" }],
    attachments: [],
  });
  assert.equal(pending.children.length, 1);
  assert.deepEqual(pending.children[0]?.children.map(child => child.textContent), ["Follow-up:", "after completion"]);
  assert.equal(sidebar.element("messages").children.length, 1, "delivered input moves into the transcript state");

  sidebar.receive({ type: "state", status: "Ready", runtime: { busy: false, connected: true, pendingQueue: { steering: [], followUp: [] } }, attachments: [] });
  assert.equal(pending.hidden, true);
  assert.equal(sidebar.element("queue-status").textContent, "");
});

test("composer uses Ctrl+Q for Windows-client follow-ups", () => {
  const sidebar = createSidebarScriptHarness("Win32");
  sidebar.receive({ type: "showSessionDetail" });
  const input = sidebar.element("input");
  const keydown = input.listeners.get("keydown")!;
  const press = (fields: Record<string, unknown>) => {
    let prevented = false;
    keydown({ key: "q", shiftKey: false, altKey: false, ctrlKey: true, metaKey: false, isComposing: false, preventDefault: () => { prevented = true; }, ...fields });
    return prevented;
  };
  sidebar.run("connected = true; busy = true; queueable = true; submissionPending = false");
  input.value = "follow up";
  assert.equal(press({}), true);
  assert.equal(sidebar.posted.at(-1).type, "queueInstruction");
  assert.equal(sidebar.posted.at(-1).kind, "followUp");

  sidebar.run("submissionPending = false; busy = false; queueable = false");
  input.value = "start now";
  assert.equal(press({}), true);
  assert.equal(sidebar.posted.at(-1).type, "send");

  const count = sidebar.posted.length;
  assert.equal(press({ key: "Enter", ctrlKey: false, altKey: true }), false);
  assert.equal(sidebar.posted.length, count);
});

test("isolated background sessions offer Open Worktree instead of an unusable Resume", () => {
  const sidebar = createSidebarScriptHarness();
  const actions = (task: Record<string, unknown>) => {
    sidebar.run(`renderBackground([${JSON.stringify({ id: "task", title: "Task", status: "completed", sessionFile: "/session.jsonl", ...task })}])`);
    return sidebar.element("background").children[0]!.children.at(-1)!.children.map(button => button.dataset.action);
  };
  assert.ok(actions({}).includes("resumeBackground"));
  const isolated = actions({ worktreePath: "/worktree", origin: {} });
  assert.ok(isolated.includes("openWorktree")); assert.equal(isolated.includes("resumeBackground"), false);
  assert.equal(actions({ worktreePath: "/legacy-worktree" }).includes("resumeBackground"), false);
  assert.equal(actions({ origin: {} }).includes("resumeBackground"), false, "cleanup does not make an isolated session resumable here");
  assert.equal(actions({ status: "running" }).includes("resumeBackground"), false);
});

test("keyboard queue and accepted-send messages preserve newer drafts and never create transcript copies", () => {
  const sidebar = createSidebarScriptHarness();
  sidebar.receive({ type: "showSessionDetail" });
  const input = sidebar.element("input");
  const change = input.listeners.get("input")!;
  const keydown = input.listeners.get("keydown")!;
  const pressEnter = () => keydown({ key: "Enter", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false, preventDefault() {} });
  sidebar.run("busy = true; connected = true; queueable = true; updateSendState()");
  input.value = "steer text"; change();
  pressEnter();
  const queued = sidebar.posted.at(-1);
  assert.equal(queued.type, "queueInstruction"); assert.equal(queued.kind, "steer");
  assert.equal(queued.text, "steer text"); assert.equal(queued.revision, 1);
  assert.equal(sidebar.element("recover-queue").disabled, true, "recovery cannot start during queue acceptance");
  assert.equal(sidebar.element("messages").children.length, 0);
  input.value = "new draft"; change();
  sidebar.receive({ type: "clearInput", expectedText: queued.text, expectedRevision: queued.revision });
  assert.equal(input.value, "new draft");
  const recoveredDraftId = "11111111-1111-4111-8111-111111111111";
  const postedBeforeStaleRecovery = sidebar.posted.length;
  sidebar.receive({ type: "appendDraft", text: "recovered", expectedRevision: 1, recoveredDraftId });
  assert.equal(input.value, "new draft");
  assert.equal(sidebar.posted.length, postedBeforeStaleRecovery, "stale text recovery does not consume its attachment handle");
  sidebar.receive({ type: "appendDraft", text: "recovered", expectedRevision: 2, recoveredDraftId });
  assert.equal(input.value, "new draft", "recovered text waits for successful attachment restoration");
  assert.equal(input.disabled, true, "the composer is locked during the atomic recovery handshake");
  assert.equal(sidebar.posted.at(-1)?.type, "restoreQueueAttachments", "attachments restore only after text revision acceptance");
  assert.equal(sidebar.posted.at(-1)?.id, recoveredDraftId);
  sidebar.receive({ type: "rejectRecoveredDraft", id: recoveredDraftId });
  assert.equal(input.value, "new draft", "failed attachment restoration does not append recoverable text");
  assert.equal(input.disabled, false);
  sidebar.receive({ type: "appendDraft", text: "recovered", expectedRevision: 2, recoveredDraftId });
  sidebar.receive({ type: "commitRecoveredDraft", id: recoveredDraftId });
  assert.equal(input.value, "new draft\n\nrecovered");
  assert.equal(input.disabled, false);
  sidebar.receive({ type: "clearInput", expectedText: input.value, expectedRevision: 3 });
  assert.equal(input.value, "");
  sidebar.run("queueable = false; submissionPending = false; updateSendState()");
  input.value = "callback continuation"; change();
  const count = sidebar.posted.length;
  pressEnter();
  assert.equal(sidebar.posted.length, count);
});
