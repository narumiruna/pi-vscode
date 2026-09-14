import assert from "node:assert/strict";
import test from "node:test";
import { createContext, Script } from "node:vm";
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
  assert.match(html, /id="delete-session"[^>]*aria-label="Delete current Pi conversation"[^>]*hidden>/);
  assert.match(html, /delete-session'\)\.hidden = !deletableSession/);
  assert.match(html, /type: 'deleteSession'/);
  assert.match(html, /delete-session'\)\.disabled = interactionLocked \|\| !connected \|\| !deletableSession/);
  assert.match(html, /id="more"/);
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
  assert.match(html, /!text \|\| !connected \|\| submissionPending \|\| backgroundSubmissionPending/);
  assert.match(html, /backgroundSubmissionPending = Boolean\(state\.backgroundSubmissionPending\)/);
  assert.match(html, /busy \|\| submissionPending \|\| backgroundSubmissionPending \|\| imageLoading/);
  assert.match(html, /Starting background agent/);
  assert.match(html, /messages\.filter\(message => message\.role !== 'assistant' \|\| Boolean\(message\.html\)\)/);
  assert.match(html, /for \(const message of visibleMessages\)/);
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
  assert.match(html, /id="activity"[^>]*hidden/);
  assert.match(html, /activity'\)\.hidden = !\[state\.proposals, state\.tools, state\.changes, state\.backgroundTasks\]/);
  assert.match(html, /attachmentsElement\.hidden = attachments\.length === 0/);
  assert.match(html, /id="attachments"[^>]*hidden/);
  assert.match(html, /#notice:empty \{ display: none; \}/);
  assert.match(html, /var\(--vscode-focusBorder\)/);
  assert.match(html, /var\(--vscode-contrastBorder\)/);
  assert.match(html, /prefers-reduced-motion: no-preference/);
  assert.match(html, /summary:focus-visible/);
  assert.match(html, /<label for="input" class="sr-only">Message Pi<\/label>/);
  assert.match(html, /<textarea[^>]*maxlength="42"[^>]*aria-describedby="composer-hint"/);
  assert.match(html, /id="send"[^>]*aria-label="Send message"[^>]*disabled/);
  assert.match(html, /sendButton\.hidden = busy/);
  assert.match(html, /cancelButton\.hidden = !busy/);
  assert.match(html, /if \(event\.isComposing\) return/);
  assert.match(html, /input\.scrollHeight/);
});

test("sidebar groups tools without reopening disclosures on every state update", () => {
  const html = getSidebarHtml(100_000, 1024);

  assert.match(html, /<details id="tools-group" hidden><summary>/);
  assert.doesNotMatch(html, /<details id="tools-group"[^>]*\bopen\b/);
  assert.match(html, /details\.dataset\.id, details\.open/);
  assert.match(html, /details\.open = openTools\.get\(tool\.id\) \?\? tool\.status !== 'success'/);
  assert.match(html, /if \(!tools\.length\) group\.open = false/);
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
  assert.doesNotMatch(html, /unsafe-inline|https?:\/\/|<script[^>]*src=/);
  assert.match(html, /<svg[^>]*aria-hidden="true"[^>]*focusable="false"/);
  assert.notEqual(getSidebarHtml(100_000, 1024), html, "each webview gets a fresh nonce");
});

// Only the DOM operations needed to execute the generated script are modeled.
// Descendant searches fail deterministically instead of relying on timing limits.
class SidebarTestElement {
  children: SidebarTestElement[] = [];
  dataset: Record<string, string> = {};
  classList = { toggle() {} };
  style = {};
  value = "";
  textContent = "";
  title = "";
  disabled = false;
  scrollHeight = 100;
  scrollTop = 0;
  clientHeight = 100;
  focusCount = 0;
  listeners = new Map<string, (event?: any) => void>();

  append(...elements: SidebarTestElement[]): void { this.children.push(...elements); }
  appendChild(element: SidebarTestElement): void { this.append(element); }
  replaceChildren(): void { this.children = []; }
  querySelector(): { textContent: string } { return { textContent: "" }; }
  querySelectorAll(): never { throw new Error("Unexpected conversation descendant search"); }
  closest(): SidebarTestElement { return this; }
  addEventListener(type: string, listener: (event?: any) => void): void { this.listeners.set(type, listener); }
  focus(): void { this.focusCount += 1; }
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

test("sidebar updates only current welcome buttons across locks and message renders", () => {
  const sidebar = createSidebarScriptHarness();
  const assertLocked = (expected: boolean) => {
    const buttons = sidebar.welcomeButtons();
    assert.equal(buttons.length, 3);
    for (const button of buttons) assert.equal(button.disabled, expected);
  };
  const rejectStaleUpdates = (buttons: SidebarTestElement[]) => {
    for (const button of buttons) {
      Object.defineProperty(button, "disabled", {
        set() { assert.fail("A detached welcome button must not be updated"); },
      });
    }
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
  rejectStaleUpdates(firstButtons);
  sidebar.run("busy = true; renderMessages([]); updateSendState()");
  assert.notEqual(sidebar.welcomeButtons()[0], firstButtons[0]);
  assertLocked(true);

  rejectStaleUpdates(sidebar.welcomeButtons());
  sidebar.run("renderMessages([{ role: 'user', html: '<p>Question</p>' }]); updateSendState()");
  sidebar.run("busy = false; renderMessages([{ role: 'assistant', html: '' }]); updateSendState()");
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
});

test("composer uses Ctrl+Q for Windows-client follow-ups", () => {
  const sidebar = createSidebarScriptHarness("Win32");
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
  assert.equal(sidebar.element("messages").children.length, 0);
  input.value = "new draft"; change();
  sidebar.receive({ type: "clearInput", expectedText: queued.text, expectedRevision: queued.revision });
  assert.equal(input.value, "new draft");
  sidebar.receive({ type: "appendDraft", text: "recovered", expectedRevision: 1 });
  assert.equal(input.value, "new draft");
  sidebar.receive({ type: "appendDraft", text: "recovered", expectedRevision: 2 });
  assert.equal(input.value, "new draft\n\nrecovered");
  sidebar.receive({ type: "clearInput", expectedText: input.value, expectedRevision: 3 });
  assert.equal(input.value, "");
  sidebar.run("queueable = false; submissionPending = false; updateSendState()");
  input.value = "callback continuation"; change();
  const count = sidebar.posted.length;
  pressEnter();
  assert.equal(sidebar.posted.length, count);
});
