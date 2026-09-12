import assert from "node:assert/strict";
import test from "node:test";
import { createContext, Script } from "node:vm";
import { getSidebarHtml } from "../sidebarHtml";

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

test("sidebar keeps primary controls compact and exposes recovery and proposal actions", () => {
  const html = getSidebarHtml(100_000, 5 * 1024 * 1024);

  assert.match(html, /id="model-picker"/);
  assert.match(html, /id="delete-session"[^>]*aria-label="Delete current Pi conversation"[^>]*hidden>/);
  assert.match(html, /delete-session'\)\.hidden = !deletableSession/);
  assert.match(html, /type: 'deleteSession'/);
  assert.match(html, /delete-session'\)\.disabled = interactionLocked \|\| !connected \|\| !deletableSession/);
  assert.match(html, /id="more"/);
  assert.match(html, /id="handoff-agent"[^>]*hidden>Implement Plan<\/button>/);
  assert.match(html, /state\.runtime\.mode !== 'plan'/);
  assert.match(html, /handoff-agent'\)\.disabled = true;\s+vscode\.postMessage\(\{ type: 'handoffAgent'/);
  assert.match(html, /id="reconnect"/);
  assert.match(html, /id="retry"/);
  assert.match(html, /id="refresh-history"/);
  assert.match(html, /type: 'refreshHistory'/);
  assert.match(html, /type: 'proposalAction'/);
  assert.match(html, /proposal\.status !== 'previewed'/);
  assert.match(html, /\['previewing', 'applying', 'rejecting'\]\.includes\(proposal\.status\)/);
  assert.match(html, /setInput'[\s\S]*composerRevision \+= 1[\s\S]*updateSendState\(\)/);
  assert.match(html, /clearInput'[\s\S]*composerRevision === message\.expectedRevision[\s\S]*input\.value === message\.expectedText[\s\S]*updateSendState\(\)/);
  assert.match(html, /showMoreActions', text: input\.value, revision: composerRevision/);
  assert.match(html, /input\.addEventListener\('input', \(\) => \{ composerRevision \+= 1/);
  assert.match(html, /let submissionPending = false/);
  assert.match(html, /submissionPending = true;\s+updateSendState\(\);\s+vscode\.postMessage/);
  assert.match(html, /message\.type === 'sendRejected'[\s\S]*submissionPending = false/);
  assert.match(html, /let backgroundSubmissionPending = false/);
  assert.match(html, /submissionPending \|\| backgroundSubmissionPending \|\| \(attachedImages/);
  assert.match(html, /backgroundSubmissionPending = Boolean\(state\.backgroundSubmissionPending\)/);
  assert.match(html, /busy \|\| submissionPending \|\| backgroundSubmissionPending \|\| imageLoading/);
  assert.match(html, /Starting background agent/);
  assert.match(html, /messages\.filter\(message => message\.role !== 'assistant' \|\| Boolean\(message\.html\)\)/);
  assert.match(html, /for \(const message of visibleMessages\)/);
  assert.doesNotMatch(html, /id="resume-session"/);
});

test("sidebar preserves hidden semantics, themed layout, and keyboard accessibility", () => {
  const html = getSidebarHtml(42, 1024);

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
  assert.match(html, /!event\.isComposing/);
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
  disabled = false;
  scrollHeight = 100;
  scrollTop = 0;
  clientHeight = 100;
  listeners = new Map<string, () => void>();

  append(...elements: SidebarTestElement[]): void { this.children.push(...elements); }
  appendChild(element: SidebarTestElement): void { this.append(element); }
  replaceChildren(): void { this.children = []; }
  querySelector(): { textContent: string } { return { textContent: "" }; }
  querySelectorAll(): never { throw new Error("Unexpected conversation descendant search"); }
  addEventListener(type: string, listener: () => void): void { this.listeners.set(type, listener); }
  focus(): void {}
}

function createSidebarScriptHarness() {
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

test("queue and accepted-send messages preserve newer drafts and never create transcript copies", () => {
  const sidebar = createSidebarScriptHarness();
  const input = sidebar.element("input");
  const change = input.listeners.get("input")!;
  sidebar.run("busy = true; connected = true; queueable = true; updateSendState()");
  input.value = "steer text"; change();
  sidebar.element("steer").listeners.get("click")!();
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
  sidebar.run("queueable = false; updateSendState()");
  input.value = "callback continuation"; change();
  const count = sidebar.posted.length;
  sidebar.element("follow-up").listeners.get("click")!();
  assert.equal(sidebar.posted.length, count);
});
