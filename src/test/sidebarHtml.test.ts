import assert from "node:assert/strict";
import { createContext, Script } from "node:vm";
import { imageAssetId } from "../imageAssets";
import { getSidebarHtml } from "../sidebarHtml";
import { installVscodeMock } from "./vscodeMock";

test("composer blockers share a visible explanation and button title for every unavailable state", () => {
  const cases = [
    ["connected = false; pendingImageReads = 1", /disconnected.*Reconnect/, false],
    ["composerDraft = { changed() {}, blocked: () => true }", /Draft context changed.*verify/, false],
    ["fileCompletion = { busy: true, refresh() {} }", /Capturing.*Wait/, false],
    ["recoveredDraftPending = { id: 'recover', text: 'draft' }", /Restoring.*Wait/, false],
    ["submissionPending = true", /Sending this message.*Wait/, false],
    ["backgroundSubmissionPending = true", /Starting a background.*Wait/, false],
    ["pendingImageReads = 1", /Loading pasted images.*Wait/, false],
    ["sessionsLayerVisible = true; busy = true", /before starting a new session/, true],
    ["busy = true; queueable = false", /cannot accept queued messages.*Wait/, true],
    ["input.value = '!pwd'; attachedItems = true", /Direct shell.*remove attachments/, false],
    ["busy = true; queueable = true; input.value = '/compact'", /Slash commands.*Wait/, false],
    ["busy = true; queueable = true; pendingQueueCount = 10", /queue is full.*Wait/, false],
    ["attachedImages = true; imageSupported = false", /cannot use images.*Choose/, false],
  ] as const;
  for (const [flags, reason, hidden] of cases) {
    const sidebar = createSidebarScriptHarness();
    sidebar.run("connected = true; sessionsLayerVisible = false; input.value = 'Draft'");
    sidebar.run(`${flags}; updateSendState()`);
    const status = sidebar.element("composer-status");
    assert.equal(status.hidden, false, flags);
    assert.match(status.textContent, reason, flags);
    assert.equal(sidebar.element("send").title, status.textContent, flags);
    assert.equal(sidebar.element("after-this").title, status.textContent, flags);
    assert.equal(sidebar.element("send").disabled, true, flags);
    assert.equal(sidebar.element("send").hidden, hidden, flags);
    assert.equal(sidebar.run("document.activeElement === input"), false, "status updates do not steal focus");
  }
});

test("composer blockers clear when ready and empty text is neutral, not a failure", () => {
  const sidebar = createSidebarScriptHarness();
  sidebar.run("connected = true; sessionsLayerVisible = false; input.value = ''; updateSendState()");
  assert.equal(sidebar.element("composer-status").dataset.state, "empty");
  assert.equal(sidebar.element("composer-status").hidden, true);
  assert.match(sidebar.element("composer-status").textContent, /Enter a message or attach context/);
  assert.equal(sidebar.element("send").title, sidebar.element("composer-status").textContent);
  sidebar.run("input.value = 'Ready'; updateSendState()");
  assert.equal(sidebar.element("composer-status").hidden, true);
  assert.equal(sidebar.element("composer-status").textContent, "");
  assert.equal(sidebar.element("send").disabled, false);
  sidebar.run("busy = true; queueable = true; updateSendState()");
  assert.equal(sidebar.element("composer-status").hidden, true);
  assert.match(sidebar.element("send").title, /after the current tool/);
  assert.match(sidebar.element("after-this").title, /finishes responding/);
  const html = getSidebarHtml(1000, 1024);
  assert.match(html, /id="composer-status" role="status" aria-live="polite" aria-atomic="true"/);
  for (const id of ["input", "send", "after-this"]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*aria-describedby="[^"]*composer-status`));
  }
  assert.ok(html.indexOf('id="composer-status"') < html.indexOf('id="composer-help"'));
});

test("Conversation details opens only on request and Close or Escape returns focus to More", () => {
  const sidebar = createSidebarScriptHarness();
  const dialog = sidebar.element("conversation-details");
  assert.equal(dialog.open, false);
  for (const runtime of [{ connected: true, busy: true }, { connected: false }]) {
    sidebar.receive({ type: "state", runtime });
    assert.equal(sidebar.element("more").disabled, false);
    sidebar.element("more").listeners.get("click")!();
    assert.equal(sidebar.posted.at(-1).type, "showMoreActions");
    assert.equal(dialog.open, false, "More still uses the native action picker");
    sidebar.receive({ type: "showConversationDetails" });
    assert.equal(dialog.open, true);
    assert.equal(sidebar.run("document.activeElement === $('conversation-details-close')"), true);
    sidebar.element("conversation-details-close").listeners.get("click")!();
    assert.equal(dialog.open, false);
    assert.equal(sidebar.run("document.activeElement === $('more')"), true);
    sidebar.receive({ type: "showConversationDetails" });
    let prevented = false;
    dialog.listeners.get("cancel")!({
      preventDefault() {
        prevented = true;
      },
    });
    assert.equal(prevented, true);
    assert.equal(dialog.open, false);
    assert.equal(sidebar.run("document.activeElement === $('more')"), true);
  }
  const html = getSidebarHtml(1000, 1024);
  const details = html.slice(
    html.indexOf('<dialog id="conversation-details"'),
    html.indexOf('<dialog id="image-preview"'),
  );
  for (const id of [
    "composer-help",
    "composer-hint",
    "file-discovery-hint",
    "session-details",
    "usage",
    "extension-status",
  ]) {
    assert.match(details, new RegExp(`id="${id}"`));
  }
  assert.match(html, /#conversation-details \{[^}]*max-height: calc\(100vh - 24px\);[^}]*overflow-y: auto/);
});

test("read-only details preserves an active file capture and composer revision", () => {
  const sidebar = createSidebarScriptHarness();
  sidebar.receive({ type: "setInput", text: "@src/file.ts" });
  sidebar.run(
    "fileCompletion = { busy: true, receive() {}, cancel() { throw new Error('capture must remain pending'); } }",
  );
  sidebar.receive({ type: "showConversationDetails" });
  assert.equal(sidebar.element("conversation-details").open, true);
  assert.equal(sidebar.run("fileCompletion.busy"), true);
  assert.equal(sidebar.run("composerRevision"), 1);
  assert.equal(sidebar.element("input").value, "@src/file.ts");
});

test("retained text notice is session-bound, manual and never opens details or submits automatically", () => {
  const sidebar = createSidebarScriptHarness();
  sidebar.receive({ type: "state", runtime: { connected: true } });
  const draftState = { type: "draftState", binding: "session-a", enabled: true, writable: true, available: true };
  sidebar.receive(draftState);
  const notice = sidebar.element("text-draft-notice");
  assert.equal(notice.hidden, false);
  assert.equal(sidebar.element("conversation-details").open, false);
  assert.equal(sidebar.element("text-draft-recovery").open, false);
  assert.equal(sidebar.element("input").value, "");
  assert.equal(
    sidebar.posted.some((item) => ["draftRestore", "send", "sendNewSession"].includes(item.type)),
    false,
  );
  notice.listeners.get("click")!();
  assert.equal(sidebar.element("conversation-details").open, true);
  assert.equal(sidebar.element("text-draft-recovery").open, true);
  assert.equal(sidebar.element("input").value, "");
  sidebar.element("restore-text-draft").listeners.get("click")!();
  assert.equal(sidebar.posted.at(-1).type, "draftRestore");
  assert.equal(sidebar.posted.at(-1).binding, "session-a");
  sidebar.receive({ type: "draftRestored", binding: "stale", expectedRevision: 0, text: "stale text" });
  assert.equal(sidebar.element("input").value, "");
  sidebar.receive({ type: "setInput", text: "Newer text" });
  sidebar.receive({ type: "draftRestored", binding: "session-a", expectedRevision: 0, text: "old text" });
  assert.equal(sidebar.element("input").value, "Newer text");
  sidebar.receive({ ...draftState, binding: "session-b", available: false });
  assert.equal(notice.hidden, true);
  assert.equal(sidebar.element("send").disabled, true, "uncertain draft context still blocks submission");
  assert.match(sidebar.element("composer-status").textContent, /Draft context changed/);
  assert.equal(sidebar.element("composer-status").hidden, false);
  assert.equal(
    sidebar.posted.some((item) => ["send", "sendNewSession", "queueInstruction"].includes(item.type)),
    false,
  );
});

test("draft controls keep explicit consent and verified restore returns to the composer without sending", () => {
  const sidebar = createSidebarScriptHarness();
  sidebar.receive({ type: "state", runtime: { connected: true } });
  sidebar.receive({ type: "draftState", binding: "session-a", enabled: false, writable: true, available: false });
  assert.equal(sidebar.element("text-draft-notice").hidden, true);
  sidebar.element("enable-text-drafts").listeners.get("click")!();
  assert.equal(sidebar.posted.at(-1).type, "draftEnable");
  assert.equal(sidebar.posted.at(-1).binding, "session-a");
  assert.equal(sidebar.element("disable-text-drafts").hidden, true, "retention waits for host consent");
  sidebar.receive({ type: "draftState", binding: "session-a", enabled: true, writable: true, available: true });
  sidebar.element("text-draft-notice").listeners.get("click")!();
  sidebar.receive({ type: "draftRestored", binding: "session-a", expectedRevision: 0, text: "Recovered text" });
  assert.equal(sidebar.element("input").value, "Recovered text");
  assert.equal(sidebar.element("conversation-details").open, false);
  assert.equal(sidebar.run("document.activeElement === input"), true);
  assert.equal(
    sidebar.element("conversation-details").listeners.has("close"),
    false,
    "deferred close cannot steal later focus",
  );
  assert.equal(
    sidebar.posted.some((item) => ["send", "sendNewSession", "queueInstruction"].includes(item.type)),
    false,
  );
  sidebar.element("discard-text-draft").listeners.get("click")!();
  assert.equal(sidebar.posted.at(-1).type, "draftDiscard");
  assert.equal(sidebar.posted.at(-1).binding, "session-a");
  sidebar.element("disable-text-drafts").listeners.get("click")!();
  assert.equal(sidebar.posted.at(-1).type, "draftDisable");
  assert.equal(sidebar.posted.at(-1).binding, "session-a");
});

test("one runtime line follows the conversation tail and keeps Sessions recovery visible", () => {
  const sidebar = createSidebarScriptHarness();
  sidebar.receive({ type: "state", status: "Ready", runtime: { connected: true } });
  assert.equal(sidebar.element("runtime").hidden, true);
  sidebar.receive({ type: "showSessionDetail" });
  assert.equal(sidebar.element("runtime").parentElement, sidebar.element("conversation"));
  for (const state of [
    { status: "Working…", runtime: { connected: true, busy: true, cancellable: true } },
    { status: "Ready", retryAvailable: true, runtime: { connected: true } },
    { status: "Ready", historyRecoveryAvailable: true, runtime: { connected: true } },
    { status: "Disconnected", runtime: { connected: false } },
  ]) {
    sidebar.receive({ type: "state", ...state });
    assert.equal(sidebar.element("runtime").hidden, false);
    sidebar.receive({ type: "showSessionsLayer" });
    assert.equal(sidebar.element("runtime").parentElement, sidebar.element("app"));
    assert.equal(sidebar.element("runtime").hidden, false);
    assert.equal(sidebar.element("reconnect").hidden, state.runtime.connected);
    assert.equal(sidebar.element("retry").hidden, !("retryAvailable" in state));
    assert.equal(sidebar.element("refresh-history").hidden, !("historyRecoveryAvailable" in state));
    sidebar.receive({ type: "showSessionDetail" });
    assert.equal(sidebar.element("runtime").parentElement, sidebar.element("conversation"));
  }
  assert.equal((getSidebarHtml(1000, 1024).match(/id="runtime"/g) || []).length, 1);
});

test("only non-blocking informational notices can be dismissed", () => {
  const sidebar = createSidebarScriptHarness();
  sidebar.receive({ type: "notice", message: "Display updated.", level: "info" });
  const dismiss = sidebar.element("notice").children.find((child) => child.dataset.noticeDismiss);
  assert.ok(dismiss);
  sidebar.element("notice").listeners.get("click")!({ target: dismiss });
  assert.equal(sidebar.element("notice").textContent, "");
  for (const [level, message] of [
    ["error", "Permission required."],
    ["warning", "Cleanup is unverified."],
    ["warning", "Queue delivery is uncertain."],
  ]) {
    sidebar.receive({ type: "notice", level, message, detailsAvailable: true });
    assert.equal(sidebar.element("notice").textContent, message);
    assert.equal(
      sidebar.element("notice").children.some((child) => child.dataset.noticeDismiss),
      false,
    );
    assert.equal(sidebar.element("notice").children[0].textContent, "View diagnostic");
  }
});

test("Jump to latest tracks transcript changes only and does not submit or change drafts", () => {
  const sidebar = createSidebarScriptHarness();
  sidebar.receive({ type: "showSessionDetail" });
  sidebar.run("renderMessages([{ id: 'reply', role: 'assistant', html: '<p>First</p>' }])");
  const conversation = sidebar.element("conversation");
  conversation.scrollHeight = 1000;
  conversation.clientHeight = 100;
  conversation.scrollTop = 40;
  conversation.listeners.get("scroll")!({ isTrusted: true });
  assert.equal(sidebar.element("jump-to-latest").hidden, false);
  assert.equal(sidebar.element("jump-to-latest").textContent, "Jump to latest");
  sidebar.run("renderMessages([{ id: 'reply', role: 'assistant', html: '<p>First</p>' }]); updateLatestOutput()");
  assert.equal(sidebar.run("hasNewTranscriptOutput"), false);
  sidebar.run("renderMessages([{ id: 'reply', role: 'assistant', html: '<p>Second</p>' }]); updateLatestOutput()");
  assert.equal(conversation.scrollTop, 40);
  assert.match(sidebar.element("jump-to-latest").textContent, /New output/);
  sidebar.element("input").value = "Unsent draft";
  const count = sidebar.posted.length;
  sidebar.element("jump-to-latest").listeners.get("click")!();
  assert.equal(sidebar.element("input").value, "Unsent draft");
  assert.equal(sidebar.posted.length, count);
  assert.equal(sidebar.run("conversationPinnedToBottom"), true);
  assert.equal(sidebar.run("hasNewTranscriptOutput"), false);
  assert.equal(sidebar.element("jump-to-latest").hidden, true);
  assert.ok(sidebar.element("input").focusCount > 0);
});

test("rich assets preserve nonce-only scripts, offline resource restrictions and source fallback", () => {
  const html = getSidebarHtml(1000, 1024, {
    source: "https://vscode-resource.example",
    script: "https://vscode-resource.example/rich-content.js",
    style: "https://vscode-resource.example/rich-content.css",
  });
  const policy = /Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? "";
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /script-src 'nonce-[^']+'/);
  assert.doesNotMatch(policy, /unsafe-eval|script-src[^;]*unsafe-inline|connect-src|frame-src/);
  assert.match(policy, /style-src https:\/\/vscode-resource\.example 'unsafe-inline'/);
  assert.match(policy, /font-src https:\/\/vscode-resource\.example/);
  assert.match(policy, /img-src data:/);
  assert.match(html, /<script nonce="[^"]+" src="https:\/\/vscode-resource\.example\/rich-content\.js"><\/script>/);
  assert.match(html, /piRichContent\.setContent/);
  assert.match(html, /else content\.innerHTML = html/);
});

test("extension status and widgets render as inert ordered text without changing host warning or Stop", () => {
  const sidebar = createSidebarScriptHarness();
  sidebar.receive({ type: "showSessionDetail" });
  sidebar.receive({ type: "notice", level: "warning", message: "Queued delivery is uncertain. Check history." });
  const text = "<script>unsafe()</script> [run](command:run)";
  const state = {
    type: "state",
    runtime: { connected: true, busy: true, cancellable: true },
    status: "Pi is working…",
    extensionUi: {
      statuses: [
        { key: "second", text },
        { key: "first", text: "one" },
      ],
      widgets: [
        { key: "above", lines: [text, "line two"], placement: "aboveEditor" },
        { key: "below", lines: ["below text"], placement: "belowEditor" },
      ],
      diagnostic: "An extension update was ignored.",
    },
  };
  sidebar.receive(state);
  const above = sidebar.element("extension-ui-above");
  const below = sidebar.element("extension-ui-below");
  assert.deepEqual(
    above.children.map((child) => child.textContent),
    ["Extension widgets · above editor", "above", `${text}\nline two`],
  );
  assert.deepEqual(
    below.children.map((child) => child.textContent),
    ["Extension widgets · below editor", "below", "below text"],
  );
  const status = sidebar.element("extension-status");
  assert.deepEqual(
    status.children.map((child) => child.textContent),
    ["Extension status", `second: ${text}`, "first: one", "An extension update was ignored."],
  );
  assert.equal(status.innerHTML, "");
  assert.equal(above.innerHTML, "");
  assert.equal(below.innerHTML, "");
  assert.equal(sidebar.element("cancel").hidden, false);
  assert.equal(sidebar.element("notice").textContent, "Queued delivery is uncertain. Check history.");
  assert.equal(sidebar.element("status").textContent, "Pi is working…");
  const retained = above.children[0];
  sidebar.receive(state);
  assert.equal(above.children[0], retained, "identical updates preserve keyboard/scroll targets");
  sidebar.receive({ ...state, extensionUi: { statuses: [], widgets: [] } });
  assert.equal(above.hidden, true);
  assert.equal(below.hidden, true);
  assert.equal(above.children.length, 0);
  assert.equal(below.children.length, 0);
  assert.equal(status.hidden, true);
  assert.equal(status.children.length, 0);
});

test("follow-up shortcut selection uses the webview client OS", () => {
  const windows = createSidebarScriptHarness("Win32");
  assert.equal(windows.run("useCtrlQForFollowUp"), true);
  windows.receive({ type: "showSessionDetail" });
  windows.run("busy = true; queueable = true; updateSendState()");
  assert.equal(
    windows.element("composer-hint").textContent,
    "Next: after the current tool · After this: after the response · Enter / Ctrl+Q · Shift+Enter for a new line",
  );

  const linux = createSidebarScriptHarness("Linux x86_64");
  assert.equal(linux.run("useCtrlQForFollowUp"), false);
  linux.receive({ type: "showSessionDetail" });
  linux.run("busy = true; queueable = true; updateSendState()");
  assert.equal(
    linux.element("composer-hint").textContent,
    "Next: after the current tool · After this: after the response · Enter / Alt+Enter · Shift+Enter for a new line",
  );

  const reducedPlatform = createSidebarScriptHarness("", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
  assert.equal(reducedPlatform.run("useCtrlQForFollowUp"), true);
});

test("webview protocol rejects removed mode messages", () => {
  const vscode = installVscodeMock();
  try {
    const { isWebviewMessage } = require("../sidebarHelpers") as typeof import("../sidebarHelpers");
    assert.equal(isWebviewMessage({ type: "setMode", mode: "agent" }, 1024), false);
    assert.equal(isWebviewMessage({ type: "handoffAgent" }, 1024), false);
    assert.equal(
      isWebviewMessage({ type: "queueInstruction", kind: "steer", text: "adjust", revision: 1 }, 1024),
      true,
    );
    assert.equal(isWebviewMessage({ type: "sendNewSession", text: "start", revision: 1 }, 1024), true);
    assert.equal(isWebviewMessage({ type: "sendNewSession", text: "start", revision: -1 }, 1024), false);
    assert.equal(isWebviewMessage({ type: "imageAssetEvicted", id: `sha256-${"a".repeat(64)}` }, 1024), true);
    assert.equal(isWebviewMessage({ type: "imageAssetRejected", id: `sha256-${"b".repeat(64)}` }, 1024), true);
    assert.equal(
      isWebviewMessage({ type: "restoreQueueAttachments", id: "11111111-1111-4111-8111-111111111111" }, 1024),
      true,
    );
    assert.equal(isWebviewMessage({ type: "restoreQueueAttachments", id: "../../session" }, 1024), false);
    assert.equal(isWebviewMessage({ type: "refreshSessions" }, 1024), true);
    assert.equal(isWebviewMessage({ type: "switchRecentSession", id: "a".repeat(24) }, 1024), true);
    assert.equal(isWebviewMessage({ type: "switchRecentSession", id: "../../session" }, 1024), false);
    assert.equal(isWebviewMessage({ type: "imageAssetEvicted", id: "../../session" }, 1024), false);
    assert.equal(isWebviewMessage({ type: "imageAssetRejected", id: "../../session" }, 1024), false);
  } finally {
    vscode.restore();
  }
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
  assert.match(html, /Loading pasted images\. Wait for loading to finish/);
  assert.match(html, /This model cannot use images\. Choose an image-capable model or remove the images/);
});

test("sidebar places model and thinking controls before submission and exposes recovery", () => {
  const html = getSidebarHtml(100_000, 5 * 1024 * 1024);

  assert.match(
    html,
    /<div class="composer-actions">[\s\S]*id="add-context"[\s\S]*id="model-picker"[\s\S]*id="thinking-label"[\s\S]*id="send"/,
  );
  assert.doesNotMatch(html, /id="thinking-level"|class="thinking-picker"/);
  assert.doesNotMatch(html, /id="steer"|id="follow-up"|id="inspect-queue"|id="clear-queue"/);
  assert.doesNotMatch(html, /id="mode"|id="handoff-agent"|type: 'setMode'|type: 'handoffAgent'/);
  assert.match(html, /renderThinkingLevel\(state\.runtime\)/);
  assert.match(html, /type: 'pickComposerSettings'/);
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
  assert.match(
    html,
    /function setComposerInput\(text\)[\s\S]*composerRevision \+= 1[\s\S]*updateSendState\(\)[\s\S]*message\.type === 'setInput'[\s\S]*setComposerInput\(message\.text\)/,
  );
  assert.match(
    html,
    /clearInput'[\s\S]*composerRevision === message\.expectedRevision[\s\S]*input\.value === message\.expectedText[\s\S]*updateSendState\(\)/,
  );
  assert.match(html, /showMoreActions', text: input\.value, revision: composerRevision/);
  assert.match(html, /input\.addEventListener\('input', \(\) => \{ composerRevision \+= 1/);
  assert.match(html, /let submissionPending = false/);
  assert.match(html, /submissionPending = true;\s+updateSendState\(\);\s+vscode\.postMessage/);
  assert.match(html, /message\.type === 'sendRejected'[\s\S]*submissionPending = false/);
  assert.match(html, /let backgroundSubmissionPending = false/);
  assert.match(
    html,
    /\(!text && !attachedItems\) \|\| !connected \|\| submissionPending \|\| backgroundSubmissionPending/,
  );
  assert.match(html, /backgroundSubmissionPending = Boolean\(state\.backgroundSubmissionPending\)/);
  assert.match(
    html,
    /function isInteractionLocked\(\) \{\s+return busy \|\| submissionPending \|\| backgroundSubmissionPending \|\| pendingImageReads > 0/,
  );
  assert.match(html, /const interactionLocked = isInteractionLocked\(\)/);
  assert.match(html, /Starting background agent/);
  assert.match(
    html,
    /messages\.filter\(message => message\.role !== 'assistant' \|\| Boolean\(message\.html\) \|\| message\.thinking\?\.length\)/,
  );
  assert.match(html, /for \(let index = 0; index < visibleMessages\.length; index \+= 1\)/);
  assert.match(html, /structure === renderedMessageStructure/);
  assert.match(html, /setMessageContent\(content, html\[index\]\)/);
  assert.match(html, /id="add-context"[^>]*aria-label="Attach code, files, or images"/);
  assert.match(html, /\.composer-actions \{[^}]*flex-wrap: wrap/);
  assert.doesNotMatch(html, /id="resume-session"/);
});

test("combined settings can shrink while submission and attachment actions keep their size", () => {
  const html = getSidebarHtml(100_000, 5 * 1024 * 1024);
  assert.match(html, /#model-picker \{[^}]*min-width: 0;[^}]*flex: 0 1 auto;[^}]*max-width: 100%/);
  assert.match(html, /#model-label \{[^}]*text-overflow: ellipsis/);
  assert.match(html, /\.composer-submit-actions \{[^}]*flex: 1 1 0;[^}]*min-width: 0/);
  assert.match(html, /#thinking-label \{[^}]*min-width: 0;[^}]*text-overflow: ellipsis/);
  assert.match(html, /#add-context \{[^}]*flex: 0 0 30px/);
  assert.match(html, /#send \{[^}]*flex: 0 0 30px/);
  assert.doesNotMatch(html, /\.model-settings|class="composer-spacer"/);
});

test("sidebar preserves hidden semantics, themed layout, and keyboard accessibility", () => {
  const html = getSidebarHtml(42, 1024);
  const composerPosition = html.indexOf('id="composer"');
  const noticePosition = html.indexOf('id="notice"');
  const runtimePosition = html.indexOf('id="runtime"');

  assert.ok(
    runtimePosition < composerPosition && composerPosition < noticePosition,
    "one runtime line belongs at the conversation tail, not in a composer footer",
  );
  assert.match(html, /grid-template-rows: auto minmax\(0, 1fr\) auto minmax\(0, auto\) auto;/);
  assert.doesNotMatch(html, /#runtime \{[^}]*border-top/);
  assert.match(html, /\[hidden\] \{ display: none !important; \}/);
  assert.match(html, /id="activity" aria-label="Pi workflow activity" hidden/);
  assert.match(html, /id="proposals" aria-label="Pi edit proposals"/);
  assert.match(html, /<span>Pi changes<\/span>/);
  assert.match(html, /id="changes" aria-label="Pi file changes"/);
  assert.match(html, /activity'\)\.hidden = !\[state\.proposals, state\.changes, state\.backgroundTasks\]/);
  assert.match(html, /attachmentsElement\.hidden = attachments\.length === 0/);
  assert.match(html, /id="attachments"[^>]*aria-label="Attachments for the next message"[^>]*hidden/);
  assert.match(html, /#notice:empty \{ display: none; \}/);
  assert.match(html, /var\(--vscode-focusBorder\)/);
  assert.match(html, /var\(--vscode-contrastBorder\)/);
  assert.match(html, /prefers-reduced-motion: no-preference/);
  assert.match(html, /summary:focus-visible/);
  assert.match(html, /<div id="pending-queue" role="list" aria-label="Pending Pi messages" hidden><\/div>/);
  assert.match(html, /\.pending-queue-item \{[^}]*min-width: 0/);
  assert.match(
    html,
    /\.pending-queue-text \{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere;[^}]*-webkit-line-clamp: 2/,
  );
  assert.match(html, /row\.setAttribute\('role', 'listitem'\)/);
  assert.match(html, /text\.textContent = item\.text/);
  assert.doesNotMatch(html, /row\.innerHTML|text\.innerHTML|kindLabel\.innerHTML/);
  assert.match(html, /<label for="input" class="sr-only">Message Pi<\/label>/);
  assert.match(html, /<textarea[^>]*maxlength="42"[^>]*aria-describedby="[^"]*composer-hint[^"]*"/);
  assert.match(html, /id="send"[^>]*aria-label="Send message"[^>]*disabled/);
  assert.match(html, /sendButton\.hidden = busy && !canQueue/);
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
  assert.ok(
    conversation < messages && messages < tools && tools < activity,
    "request tools follow the active response inside the conversation scroller",
  );
  assert.match(html, /grid-template-columns: repeat\(auto-fit, minmax\(min\(124px, 100%\), 180px\)\)/);
  assert.match(html, /imageGrid\.className = 'transcript-images'/);
  assert.match(html, /card\.className = 'attachment-image'/);
  assert.match(html, /renderComposerImage\(preview, attachment\)/);
  assert.match(html, /button\.composer-image \{[^}]*height: 72px/);
  assert.match(
    html,
    /button\.composer-image:focus-visible, button\.attachment-remove:focus-visible \{[^}]*box-shadow: inset 0 0 0 2px var\(--vscode-focusBorder\)/,
  );
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
    assert.match(html, /minmax\(min\(124px, 100%\), 180px\)/);
  }
  for (const token of [
    "--vscode-sideBar-background",
    "--vscode-foreground",
    "--vscode-focusBorder",
    "--vscode-contrastBorder",
  ])
    assert.ok(html.includes(token));
  assert.match(html, /body\.vscode-light, body\.vscode-high-contrast-light/);
  assert.match(html, /body\.vscode-dark, body\.vscode-high-contrast/);
});

test("sidebar groups tools without reopening disclosures on every state update", () => {
  const html = getSidebarHtml(100_000, 1024);

  assert.match(html, /<details id="tools-group" hidden><summary id="tools-group-toggle">/);
  assert.doesNotMatch(html, /<details id="tools-group"[^>]*\bopen\b/);
  assert.match(html, /details\.toolManual = details\.open/);
  assert.match(html, /toolDisclosure\(group, busy\)/);
  assert.match(html, /Tool activity · /);
  assert.match(html, /tools-failed/);
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
test("slash suggestions filter command names by substring and complete without submitting", () => {
  const sidebar = createSidebarScriptHarness();
  const input = sidebar.element("input");
  const menu = sidebar.element("slash-commands");
  sidebar.receive({
    type: "state",
    runtime: {
      connected: true,
      busy: false,
      commands: [
        { name: "codex-compact", description: "Compact with Codex" },
        { name: "skill:review", description: "Review code" },
        { name: "compact", description: "Duplicate" },
        { name: "<unsafe>", description: "<img src=x>" },
      ],
    },
  });
  const type = (text: string) => {
    input.value = text;
    input.listeners.get("input")!();
  };
  type("/");
  assert.equal(menu.hidden, false);
  assert.equal(menu.children.length, 5, "the catalog deduplicates names and includes the local reload alias");
  assert.equal(menu.children[4]?.children[1]?.textContent, "<img src=x>", "descriptions are text, not HTML");
  type("/COM");
  assert.deepEqual(
    menu.children.map((row) => row.children[0]?.textContent),
    ["/compact", "/codex-compact"],
  );
  const key = (key: string, extra = {}) => {
    let prevented = false;
    input.listeners.get("keydown")!({
      key,
      preventDefault: () => {
        prevented = true;
      },
      ...extra,
    });
    return prevented;
  };
  assert.equal(key("ArrowDown"), true);
  assert.equal((menu.children[1] as any)["aria-selected"], "true");
  const count = sidebar.posted.length;
  assert.equal(key("Enter"), true);
  assert.equal(input.value, "/codex-compact ");
  assert.equal(sidebar.posted.length, count, "Enter completes before submission");
  assert.equal(menu.hidden, true);
  type("/com");
  assert.equal(key("ArrowUp"), true, "selection wraps");
  assert.equal(key("Tab"), true);
  assert.equal(input.value, "/codex-compact ");
  type("/skill:");
  menu.children[0]!.listeners.get("click")!();
  assert.equal(input.value, "/skill:review ");
  assert.equal(menu.hidden, true);
});

test("slash suggestions dismiss safely and preserve ordinary editor keys", () => {
  const sidebar = createSidebarScriptHarness();
  const input = sidebar.element("input");
  const menu = sidebar.element("slash-commands");
  const state = (busy = false) => sidebar.receive({ type: "state", runtime: { connected: true, busy } });
  state();
  const type = (text: string) => {
    input.value = text;
    input.listeners.get("input")!();
  };
  type("/com");
  let prevented = false;
  const press = (key: string, extra = {}) => {
    prevented = false;
    input.listeners.get("keydown")!({
      key,
      preventDefault: () => {
        prevented = true;
      },
      ...extra,
    });
  };
  press("Enter", { isComposing: true });
  assert.equal(prevented, false);
  assert.equal(input.value, "/com");
  press("Enter", { shiftKey: true });
  assert.equal(prevented, false);
  press("Escape");
  assert.equal(prevented, true);
  assert.equal(menu.hidden, true);
  state();
  assert.equal(menu.hidden, true, "stream updates do not reopen dismissed suggestions");
  type("/co");
  assert.equal(menu.hidden, false);
  input.listeners.get("blur")!();
  assert.equal(menu.hidden, true);
  state();
  assert.equal(menu.hidden, true, "state updates do not reopen suggestions after focus leaves the input");
  for (const text of ["/missing", "/compact instructions", "explain /com", "/com\n"]) {
    type(text);
    assert.equal(menu.hidden, true, text);
  }
  type("/");
  state(true);
  assert.equal(menu.hidden, true, "commands cannot be queued while busy");
  state();
  sidebar.run("input.selectionStart = 1; input.selectionEnd = 2");
  type("/com");
  assert.equal(menu.hidden, true, "selection and an interior caret do not open suggestions");
});

test("tool details retain both inputs and outputs, safe summaries, errors and empty states", () => {
  const sidebar = createSidebarScriptHarness();
  const send = (tools: any[], busy = false) =>
    sidebar.receive({
      type: "state",
      runtime: { busy, connected: true },
      tools,
    });
  send([]);
  assert.equal(sidebar.element("tools-group").hidden, true);
  const tool = {
    id: "one",
    name: "read",
    summary: "<img src=x>",
    input: '{"path":"file"}',
    status: "success",
    output: "",
  };
  send([tool]);
  const row = sidebar.element("tools").children[0]!;
  assert.equal(row.children[0]?.children[2]?.textContent, "<img src=x>");
  assert.equal(row.children[0]?.children[2]?.innerHTML, "");
  assert.equal((row.children[0]?.children[0] as any)?.["aria-label"], "Succeeded");
  assert.equal(row.children[2]?.children[1]?.textContent, tool.input);
  assert.equal(row.children[3]?.children[1]?.textContent, "No output returned.");
  assert.equal(sidebar.element("tools-summary").textContent, "Tool activity · 1 call");
  assert.equal(sidebar.element("tools-failed").textContent, "");
  send(
    [
      { ...tool, status: "error", output: "Permission denied\nDetails" },
      { ...tool, id: "two", status: "running" },
    ],
    true,
  );
  assert.equal(sidebar.element("tools-failed").textContent, " · 1 failed");
  assert.equal(sidebar.element("tools-running").textContent, " · 1 running");
  assert.equal(row.children[1]?.textContent, "Permission denied\nDetails");
  assert.equal(row.children[2]?.children[1]?.textContent, tool.input);
  assert.equal(row.children[3]?.children[1]?.textContent, "Permission denied\nDetails");
  send([{ ...tool, status: "error", output: "Permission denied" }]);
  assert.equal(sidebar.element("tools-failed").textContent, " · 1 failed");
  assert.equal(sidebar.element("tools-running").textContent, "");
});

test("manual tool disclosure survives insertion, settlement and full output updates; reset clears intent", () => {
  const sidebar = createSidebarScriptHarness();
  const tool = { id: "one", name: "bash", input: "npm test", output: "line\n".repeat(100), status: "running" };
  const send = (tools: any[], busy: boolean) =>
    sidebar.receive({ type: "state", runtime: { busy, connected: true }, tools });
  send([tool], true);
  const group = sidebar.element("tools-group");
  const row = sidebar.element("tools").children[0]!;
  row.open = false;
  group.open = false;
  send([tool, { ...tool, id: "two" }], true);
  assert.equal(group.open, false);
  assert.equal(sidebar.element("tools").children[0], row);
  assert.equal(row.open, false);
  const full = row.children[3]!.children[2]!;
  full.open = true;
  row.open = true;
  group.open = true;
  send([{ ...tool, status: "success", output: "more\n".repeat(200) }], false);
  assert.equal(group.open, true);
  assert.equal(row.open, true);
  assert.equal(full.open, true);
  assert.equal(full.children[1]?.textContent, "more\n".repeat(200));
  send([], false);
  send([{ ...tool, status: "success" }], false);
  assert.equal(group.open, false);
  assert.equal(sidebar.element("tools").children[0]?.open, false);
});

test("tool retention removes only expired rows and a replaced request clears group intent", () => {
  const sidebar = createSidebarScriptHarness();
  const tool = { id: "old", name: "read", input: "file", status: "success" };
  const send = (tools: any[], busy = true) =>
    sidebar.receive({ type: "state", runtime: { busy, connected: true }, tools });
  send([tool, { ...tool, id: "retained" }]);
  const retained = sidebar.element("tools").children[1]!;
  retained.open = true;
  sidebar.element("tools-group").open = false;
  send([
    { ...tool, id: "retained" },
    { ...tool, id: "new" },
  ]);
  assert.equal(sidebar.element("tools").children[0], retained);
  assert.equal(retained.open, true);
  assert.equal(sidebar.element("tools-group").open, false);
  send([{ ...tool, id: "next-request" }], false);
  assert.equal(sidebar.element("tools-group").open, false);
  send([{ ...tool, id: "another-request", status: "running" }]);
  assert.equal(sidebar.element("tools-group").open, true);
});

test("visible queue actions use the keyboard submission path and block duplicate or unsupported sends", () => {
  const sidebar = createSidebarScriptHarness();
  sidebar.receive({ type: "showSessionDetail" });
  const state = (runtime: Record<string, unknown> = {}) =>
    sidebar.receive({
      type: "state",
      imageSupported: true,
      runtime: { connected: true, busy: true, queueable: true, cancellable: true, ...runtime },
      attachments: [{ id: "context", label: "file.ts", image: false }],
    });
  for (const [id, kind] of [
    ["send", "steer"],
    ["after-this", "followUp"],
  ]) {
    state();
    sidebar.receive({ type: "setInput", text: "Continue with context" });
    const button = sidebar.element(id);
    assert.equal(button.hidden, false);
    assert.equal(button.disabled, false);
    assert.equal(sidebar.element("input").placeholder, "Write a follow-up…");
    const before = sidebar.posted.length;
    button.listeners.get("click")!();
    assert.equal(sidebar.posted.length, before + 1);
    assert.equal(sidebar.posted.at(-1).type, "queueInstruction");
    assert.equal(sidebar.posted.at(-1).kind, kind);
    assert.equal(sidebar.posted.at(-1).text, "Continue with context");
    button.listeners.get("click")!();
    assert.equal(sidebar.posted.length, before + 1, "pending acceptance blocks a second click");
    sidebar.receive({ type: "sendRejected" });
  }
  sidebar.receive({ type: "setInput", text: "/compact" });
  assert.equal(sidebar.element("send").disabled, true);
  assert.equal(sidebar.element("after-this").disabled, true);
  let count = sidebar.posted.length;
  sidebar.element("after-this").listeners.get("click")!();
  assert.equal(sidebar.posted.length, count);
  assert.match(sidebar.element("notice").textContent, /Slash commands cannot be queued/);
  sidebar.receive({ type: "setInput", text: "Continue" });
  state({ pendingQueue: { steering: Array.from({ length: 10 }, () => ({ text: "Pending" })), followUp: [] } });
  assert.equal(sidebar.element("send").disabled, true);
  count = sidebar.posted.length;
  sidebar.element("send").listeners.get("click")!();
  assert.equal(sidebar.posted.length, count);
  assert.match(sidebar.element("notice").textContent, /queue is full/);
  state({ queueable: false });
  assert.equal(sidebar.element("after-this").hidden, true);
  assert.equal(sidebar.element("send").hidden, true);
  assert.equal(sidebar.element("cancel").hidden, false);
  state({ connected: false });
  assert.equal(sidebar.element("after-this").disabled, true);
  const before = sidebar.posted.length;
  sidebar.element("after-this").listeners.get("click")!();
  assert.equal(sidebar.posted.length, before);
});

test("model identity and session details expose full runtime values without persistent footer IDs", () => {
  const sidebar = createSidebarScriptHarness();
  sidebar.receive({
    type: "state",
    runtime: {
      busy: false,
      connected: true,
      sessionId: "full-session-identifier",
      model: { name: "Runtime display name", provider: "provider", id: "full-model-id" },
    },
  });
  assert.equal(sidebar.element("session").value, "full-session-identifier");
  assert.equal(sidebar.element("session-details").hidden, false);
  assert.match(
    sidebar.element("model-picker").title,
    /Runtime display name.*provider\/full-model-id.*Thinking: Unavailable/,
  );
  assert.match(
    (sidebar.element("model-picker") as any)["aria-label"],
    /Pi model: Runtime display name.*provider\/full-model-id.*Thinking: Unavailable/,
  );
  assert.match(sidebar.element("settings-description").textContent, /unavailable for this model/);
});

test("thinking-only messages use collapsed inert disclosures and retain user state during updates", () => {
  const sidebar = createSidebarScriptHarness();
  const send = (text: string, truncated = false) =>
    sidebar.receive({
      type: "state",
      runtime: { connected: true, busy: true },
      messages: [
        {
          id: "assistant",
          role: "assistant",
          html: "",
          thinking: [
            { contentIndex: 0, text, truncated },
            { contentIndex: 2, text: "must not display", redacted: true },
          ],
        },
      ],
    });
  send("<script>bad()</script>");
  const wrapper = sidebar.element("messages").children[0]!;
  const details = wrapper.children[2]!;
  assert.equal(details.className, "thinking-transcript");
  assert.equal(details.open, false);
  assert.equal(details.children[0]?.textContent, "Thinking");
  assert.equal(details.children[1]?.children[0]?.textContent, "<script>bad()</script>");
  assert.equal(details.children[1]?.children[0]?.innerHTML, "");
  assert.match(details.children[1]?.children[1]?.textContent ?? "", /Provider redacted.*unavailable/);
  assert.equal(wrapper.children[1]?.innerHTML, "", "thinking is not answer HTML");
  details.open = true;
  send("completed text", true);
  assert.equal(sidebar.element("messages").children[0], wrapper);
  assert.equal(details.open, true);
  assert.match(details.children[1]?.children[1]?.textContent ?? "", /Thinking truncated/);
  details.open = false;
  send("more output");
  assert.equal(details.open, false);
  assert.equal(details.children[0]?.focusCount, 0);
  assert.doesNotMatch(getSidebarHtml(100, 100), /thinkingSignature|thoughtSignature/);
});

class SidebarTestElement {
  children: SidebarTestElement[] = [];
  parentElement?: SidebarTestElement;
  id = "";
  dataset: Record<string, string> = {};
  "aria-current"?: string;
  "aria-expanded"?: string;
  classes = new Set<string>();
  classList = {
    toggle: (name: string, force?: boolean) => {
      const enabled = force ?? !this.classes.has(name);
      if (enabled) this.classes.add(name);
      else this.classes.delete(name);
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

  append(...elements: SidebarTestElement[]): void {
    for (const element of elements) {
      element.parentElement?.removeChild(element);
      element.parentElement = this;
      this.children.push(element);
    }
  }
  insertBefore(element: SidebarTestElement, reference: SidebarTestElement): void {
    element.parentElement?.removeChild(element);
    element.parentElement = this;
    const index = this.children.indexOf(reference);
    this.children.splice(index < 0 ? this.children.length : index, 0, element);
  }
  appendChild(element: SidebarTestElement): void {
    this.append(element);
  }
  removeChild(element: SidebarTestElement): void {
    this.children = this.children.filter((child) => child !== element);
    element.parentElement = undefined;
  }
  replaceChildren(...elements: SidebarTestElement[]): void {
    this.children = [...elements];
  }
  querySelector(): { textContent: string } {
    return { textContent: "" };
  }
  querySelectorAll(): never {
    throw new Error("Unexpected conversation descendant search");
  }
  closest(selector: string): SidebarTestElement | undefined {
    const key = /\[data-([a-z-]+)\]/
      .exec(selector)?.[1]
      ?.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    return key && this.dataset[key] === undefined ? undefined : this;
  }
  setAttribute(name: string, value: string): void {
    (this as any)[name] = value;
  }
  removeAttribute(name: string): void {
    (this as any)[name] = "";
  }
  getBoundingClientRect(): { top: number; bottom: number } {
    return this.rect;
  }
  addEventListener(type: string, listener: (event?: any) => void): void {
    this.listeners.set(type, listener);
  }
  focus(): void {
    this.focusCount += 1;
  }
  select(): void {}
  showModal(): void {
    this.open = true;
  }
  close(): void {
    this.open = false;
    this.listeners.get("close")?.();
  }
}

function createSidebarScriptHarness(clientPlatform = "Linux x86_64", userAgent = "") {
  const html = getSidebarHtml(100_000, 1024);
  const document = {
    activeElement: undefined as SidebarTestElement | undefined,
    getElementById: (id: string): SidebarTestElement => element(id),
    createElement: () => makeElement(),
    addEventListener: () => {},
  };
  const created: SidebarTestElement[] = [];
  const makeElement = () => {
    const item = new SidebarTestElement();
    item.focus = () => {
      item.focusCount += 1;
      document.activeElement = item;
    };
    created.push(item);
    return item;
  };
  const elements = new Map(
    Array.from(html.matchAll(/\bid="([^"]+)"/g), (match) => {
      const item = makeElement();
      item.id = match[1];
      return [match[1], item];
    }),
  );
  const element = (id: string) => {
    const result = elements.get(id) || created.find((item) => item.id === id);
    assert.ok(result, `missing sidebar element: ${id}`);
    return result;
  };
  let receive: ((event: { data: unknown }) => void) | undefined;
  const posted: any[] = [];
  const context = createContext({
    document,
    window: {
      addEventListener: (type: string, listener: typeof receive) => {
        if (type === "message") receive = listener;
      },
    },
    setTimeout: () => 1,
    clearTimeout: () => {},
    navigator: { platform: clientPlatform, userAgent },
    Element: SidebarTestElement,
    FileReader: class {
      result = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
      listeners = new Map<string, () => void>();
      addEventListener(type: string, listener: () => void): void {
        this.listeners.set(type, listener);
      }
      readAsDataURL(): void {
        this.listeners.get("load")?.();
        this.listeners.get("loadend")?.();
      }
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

test("conversation header owns one accessible icon per action and no transcript toolbar", () => {
  const html = getSidebarHtml(100_000, 1024);
  const actions = /<div class="sessions-actions"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1];
  assert.ok(actions);
  const buttons = [...actions.matchAll(/<button id="([^"]+)"([^>]*)>([\s\S]*?)<\/button>/g)];
  assert.deepEqual(
    buttons.map((button) => button[1]),
    ["new-session", "delete-session", "history-search-open", "history-earlier", "history-latest", "more"],
  );
  for (const [_, id, attributes, content] of buttons) {
    assert.match(attributes, /class="[^"]*icon-button/);
    assert.match(attributes, /aria-label="[^"]+"/);
    assert.match(attributes, /title="[^"]+"/);
    assert.equal((content.match(/<svg\b/g) ?? []).length, 1);
    assert.match(content, /aria-hidden="true" focusable="false"/);
    assert.equal((html.match(new RegExp(`id="${id}"`, "g")) ?? []).length, 1);
  }
  assert.match(actions, /id="history-search-open"[^>]*aria-expanded="false"[^>]*aria-controls="history-search-bar"/);
  assert.doesNotMatch(html, /id="(?:wrap-code|transcript-controls)"/);
  const surface = html.slice(html.indexOf('id="history-controls"'), html.indexOf('<section id="messages"'));
  assert.doesNotMatch(surface, /id="history-(?:search-open|earlier|latest)"/);
  assert.ok(surface.indexOf('id="history-scope"') > surface.indexOf('id="history-search-bar"'));
});

test("conversation-only header controls follow list and detail navigation", () => {
  const sidebar = createSidebarScriptHarness();
  const controls = ["history-search-open", "history-earlier", "history-latest"];
  sidebar.receive({ type: "showSessionsLayer" });
  for (const id of controls) assert.equal(sidebar.element(id).hidden, true);
  sidebar.receive({ type: "showSessionDetail" });
  for (const id of controls) assert.equal(sidebar.element(id).hidden, false);
  sidebar.receive({ type: "showSessionsLayer" });
  for (const id of controls) assert.equal(sidebar.element(id).hidden, true);
});

test("search expands only on request and Escape restores the header trigger", () => {
  const sidebar = createSidebarScriptHarness();
  sidebar.receive({ type: "showSessionDetail" });
  sidebar.receive({ type: "state", runtime: { connected: true }, history: { mode: "latest", available: true } });
  const trigger = sidebar.element("history-search-open");
  const bar = sidebar.element("history-search-bar");
  const field = sidebar.element("history-search-input");
  assert.equal(bar.hidden, true);
  assert.equal(sidebar.element("history-controls").hidden, true);
  trigger.listeners.get("click")!();
  assert.equal(bar.hidden, false);
  assert.equal(trigger["aria-expanded"], "true");
  assert.equal(field.focusCount, 1);
  let prevented = 0;
  bar.listeners.get("keydown")!({ key: "Escape", preventDefault: () => prevented++, stopPropagation() {} });
  assert.equal(prevented, 1);
  assert.equal(bar.hidden, true);
  assert.equal(trigger["aria-expanded"], "false");
  assert.equal(trigger.focusCount, 1);
  trigger.listeners.get("click")!();
  trigger.listeners.get("click")!();
  assert.equal(bar.hidden, true, "the expanded trigger also closes search");
});

test("header history actions retain navigation guards and conditional feedback", () => {
  const sidebar = createSidebarScriptHarness();
  sidebar.receive({ type: "showSessionDetail" });
  const history = { mode: "latest", available: true, canNavigate: true, omittedBefore: 100, total: 200, generation: 7 };
  const render = (overrides = {}, runtime = { connected: true, busy: false }) =>
    sidebar.receive({ type: "state", runtime, history: { ...history, ...overrides } });
  render();
  assert.equal(sidebar.element("history-earlier").disabled, false);
  assert.equal(sidebar.element("history-latest").disabled, true);
  assert.equal(sidebar.element("history-status").hidden, true);
  sidebar.element("history-latest").listeners.get("click")!();
  assert.notEqual(sidebar.posted.at(-1)?.type, "historyWindow", "latest cannot request an already-latest window");
  sidebar.element("history-earlier").listeners.get("click")!();
  assert.equal(sidebar.posted.at(-1)?.direction, "earlier");
  render({ mode: "earlier", omittedAfter: 100 });
  assert.equal(sidebar.element("history-latest").disabled, false);
  assert.match(sidebar.element("history-status").textContent, /Earlier window.*100 later/);
  assert.equal(sidebar.element("history-search-bar").hidden, true);
  sidebar.element("history-latest").listeners.get("click")!();
  assert.equal(sidebar.posted.at(-1)?.direction, "latest");
  for (const [overrides, runtime, expected] of [
    [{ loading: true }, { connected: true, busy: false }, /Loading history/],
    [{ available: false }, { connected: true, busy: false }, /Full history unavailable/],
    [{}, { connected: false, busy: false }, undefined],
    [{}, { connected: true, busy: true }, undefined],
  ] as const) {
    render(overrides, runtime);
    assert.equal(sidebar.element("history-earlier").disabled, true);
    assert.equal(sidebar.element("history-latest").disabled, true);
    const before = sidebar.posted.length;
    sidebar.element("history-earlier").listeners.get("click")!();
    sidebar.element("history-latest").listeners.get("click")!();
    assert.equal(sidebar.posted.length, before, "unavailable actions cannot dispatch even through a stale handler");
    if (expected) assert.match(sidebar.element("history-status").textContent, expected);
  }
  render({ truncated: true });
  assert.match(sidebar.element("history-status").textContent, /omitted portions.*cannot be browsed/);
  assert.equal(sidebar.element("history-controls").hidden, false);
  render();
  assert.equal(sidebar.element("history-controls").hidden, true);
});

test("More sends current wrapping state and only the fixed host reply toggles it", () => {
  const sidebar = createSidebarScriptHarness();
  sidebar.run(
    "let wrapCalls = 0; toggleCodeWrapping = () => { wrapCalls++; messagesElement.classList.toggle('wrap-code', !messagesElement.classList.contains('wrap-code')); }",
  );
  sidebar.element("input").value = "Keep draft";
  sidebar.element("more").listeners.get("click")!();
  assert.deepEqual(JSON.parse(JSON.stringify(sidebar.posted.at(-1))), {
    type: "showMoreActions",
    text: "Keep draft",
    revision: 0,
    codeWrapping: false,
  });
  assert.equal(sidebar.run("wrapCalls"), 0);
  sidebar.receive({ type: "toggleCodeWrapping" });
  sidebar.element("more").listeners.get("click")!();
  assert.equal(sidebar.posted.at(-1)?.codeWrapping, true);
  assert.equal(sidebar.run("wrapCalls"), 1);
  assert.equal(sidebar.element("input").value, "Keep draft");
});

test("composer keeps idle hints short and empty queue quiet, with unknown usage in details", () => {
  const sidebar = createSidebarScriptHarness();
  sidebar.receive({ type: "state", status: "Ready", runtime: { busy: false, connected: true }, attachments: [] });
  assert.equal(sidebar.element("composer-hint").textContent, "Enter to send · Shift+Enter for a new line");
  assert.equal(sidebar.element("usage").textContent, "Context usage is unavailable.");
  assert.equal(sidebar.element("usage").title, "");
  assert.equal(sidebar.element("queue-status").textContent, "");
  assert.equal(sidebar.element("attachment-estimate").textContent, "");
  assert.doesNotMatch(getSidebarHtml(100_000, 5 * 1024 * 1024), /inspect-context/);

  sidebar.receive({ type: "showSessionDetail" });
  sidebar.receive({
    type: "state",
    status: "Working…",
    runtime: { busy: true, queueable: true, connected: true, stats: { contextUsage: { percent: 12.4 } } },
  });
  assert.equal(sidebar.element("queue-status").textContent, "", "an empty queue stays quiet even while Pi is working");
  assert.equal(sidebar.element("usage").textContent, "Context 12%");
  assert.equal(sidebar.element("usage").title, "Share of the model’s context window currently in use");
});

test("attachment summary shows counts and estimates without a separate view button", () => {
  const sidebar = createSidebarScriptHarness();
  const state = (attachments: unknown[], characters = 0, estimatedTextTokens = 0) =>
    sidebar.receive({
      type: "state",
      status: "Ready",
      runtime: { busy: false, connected: true },
      imageSupported: true,
      attachments,
      attachmentEstimate: { characters, estimatedTextTokens },
    });
  const image = { id: "image", label: "image.png", image: true, assetId: "asset" };
  const context = { id: "context", label: "file.ts", image: false };
  state([image]);
  assert.equal(sidebar.element("attachment-estimate").textContent, "1 image");
  assert.match(sidebar.element("attachment-estimate").title, /image tokens not included/);
  sidebar.receive({ type: "setInput", text: "This prompt must not change the attachment count" });
  assert.equal(sidebar.element("attachment-estimate").textContent, "1 image");
  sidebar.receive({ type: "setInput", text: "" });
  sidebar.element("add-context").listeners.get("click")!();
  assert.equal(sidebar.posted.at(-1).type, "pickContext");

  state([image, context], 120, 30);
  assert.equal(sidebar.element("attachment-estimate").textContent, "1 image · 120 attachment text characters");
  state([context], 120, 30);
  assert.equal(sidebar.element("attachment-estimate").textContent, "120 attachment text characters");
  assert.equal(sidebar.element("send").title, "Send attachments");
  state([]);
  assert.equal(sidebar.element("attachment-estimate").textContent, "");
});

test("Sessions is a separate layer that opens a detail view and returns with Back", () => {
  const sidebar = createSidebarScriptHarness();
  const ids = ["a", "b", "c", "d"].map((character) => character.repeat(24));
  const sessions = [
    { id: ids[0], title: "Current work", updatedAt: Date.now(), current: true },
    { id: ids[1], title: "Fix sidebar", updatedAt: Date.now() - 60_000, current: false },
    { id: ids[2], title: "Write tests", updatedAt: Date.now() - 120_000, current: false },
    { id: ids[3], title: "Release notes", updatedAt: Date.now() - 180_000, current: false },
  ];
  sidebar.receive({
    type: "state",
    status: "Ready",
    runtime: { busy: false, cancellable: false, connected: true },
    sessions,
  });

  assert.equal(sidebar.element("app").classList.contains("sessions-layer"), true);
  assert.equal(sidebar.element("session-list-content").hidden, false);
  assert.equal(sidebar.element("session-header-title").textContent, "Sessions");
  assert.equal(sidebar.element("recent-session-list").children.length, 3);
  assert.equal(sidebar.element("view-all-sessions").textContent, "View all (4)");
  assert.equal(sidebar.element("input").placeholder, "Start a new session…");
  sidebar.receive({ type: "state", status: "Working…", runtime: { busy: true, connected: true }, sessions });
  assert.equal(sidebar.element("composer-hint").textContent, "Wait for Pi to finish before starting a new session");
  sidebar.receive({ type: "state", status: "Ready", runtime: { busy: false, connected: true }, sessions });

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
  assert.equal(sidebar.element("input").placeholder, "Ask Pi anything…");

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
  assert.equal(
    sidebar.element("app").classList.contains("sessions-layer"),
    false,
    "editor actions can open the detail layer",
  );
  sidebar.receive({ type: "showSessionsLayer" });
  assert.equal(
    sidebar.element("app").classList.contains("sessions-layer"),
    true,
    "Open Sessions can restore the list layer",
  );
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

  sidebar.receive({
    type: "state",
    status: "Ready",
    runtime: { busy: false, cancellable: false, connected: true },
    sessions: sessions.map((session, index) => ({ ...session, current: index === 1 })),
  });
  assert.equal(sidebar.element("app").classList.contains("sessions-layer"), false);
  assert.equal(sidebar.element("session-header-title").textContent, "Fix sidebar");
  sidebar.element("back-to-sessions").listeners.get("click")!();
  assert.equal(sidebar.element("app").classList.contains("sessions-layer"), true);
  assert.equal(
    sidebar.element("sessions-browser").hidden,
    false,
    "Back returns to the list layer the session was opened from",
  );

  sidebar.receive({ type: "sessionSwitchRejected" });
  assert.equal(sidebar.element("all-session-list").children[0]?.disabled, false);
});

test("hidden session updates refresh the detail header and rebuild current rows and locks on Back", () => {
  const sidebar = createSidebarScriptHarness();
  const ids = ["a", "b", "c", "d"].map((character) => character.repeat(24));
  const sessions = ids.map((id, index) => ({
    id,
    title: `Session ${index + 1}`,
    updatedAt: Date.now(),
    current: index === 0,
  }));
  const state = (rows: typeof sessions, busy = false) =>
    sidebar.receive({
      type: "state",
      runtime: { connected: true, busy, cancellable: busy },
      sessions: rows,
    });
  state(sessions);
  sidebar.receive({ type: "showSessionDetail" });
  const changedCurrent = sessions[3];
  const retainedSession = sessions[1];
  assert.ok(changedCurrent);
  assert.ok(retainedSession);
  const latest = [
    { ...changedCurrent, title: "Latest current title", current: true },
    { ...retainedSession, title: "Renamed remaining session", current: false },
  ];
  state(latest, true);
  assert.equal(sidebar.element("session-list-content").hidden, true);
  assert.equal(sidebar.element("session-header-title").textContent, "Latest current title");
  assert.equal(sidebar.element("session-header-title").title, "Latest current title");
  assert.equal(sidebar.element("input").placeholder, "Write a follow-up…");
  assert.equal(sidebar.element("cancel").hidden, false);

  const back = sidebar.element("back-to-sessions").listeners.get("click");
  assert.ok(back);
  back();
  const recent = sidebar.element("recent-session-list");
  assert.deepEqual(
    recent.children.map((row) => row.dataset.sessionId),
    [ids[3], ids[1]],
  );
  assert.deepEqual(
    recent.children.map((row) => row.title),
    latest.map((session) => session.title),
  );
  assert.equal(recent.children[0]?.["aria-current"], "page");
  assert.equal(recent.children[0]?.classList.contains("current"), true);
  assert.equal(recent.children[1]?.classList.contains("current"), false);
  assert.equal(sidebar.element("all-session-list").children.length, 2);
  assert.equal(sidebar.element("view-all-sessions").textContent, "View all (2)");
  assert.equal(sidebar.element("no-sessions").hidden, true);
  assert.equal(sidebar.element("session-header-title").textContent, "Sessions");
  assert.equal(sidebar.element("input").placeholder, "Start a new session…");
  for (const row of recent.children) {
    assert.equal(row.disabled, true);
    assert.equal(row.focusCount, 0, "locked rows must not receive focus");
  }
  assert.equal(sidebar.element("view-all-sessions").focusCount, 1, "Back focuses a visible unlocked fallback");

  sidebar.receive({ type: "showSessionDetail" });
  state(latest.map((session) => ({ ...session, current: false })));
  assert.equal(sidebar.element("session-header-title").textContent, "Session");
  assert.equal(sidebar.element("session-header-title").title, "");
  assert.equal(sidebar.element("input").placeholder, "Ask Pi anything…");
  state(latest);
  back();
  assert.equal(recent.children[0]?.disabled, false);
  assert.equal(recent.children[0]?.focusCount, 1, "Back focuses the latest visible current row");
  assert.equal(recent.children[1]?.focusCount, 0);
});

test("hidden expanded Sessions retain search and reveal fresh membership, empty results and control locks", () => {
  const sidebar = createSidebarScriptHarness();
  const current = { id: "a".repeat(24), title: "Find current", updatedAt: Date.now(), current: true };
  const added = { id: "b".repeat(24), title: "Find added", updatedAt: Date.now(), current: false };
  const state = (sessions: (typeof current)[], locked = false) =>
    sidebar.receive({
      type: "state",
      runtime: { connected: true, busy: false },
      backgroundSubmissionPending: locked,
      sessions,
    });
  state([current]);
  const viewAll = sidebar.element("view-all-sessions").listeners.get("click");
  const back = sidebar.element("back-to-sessions").listeners.get("click");
  assert.ok(viewAll);
  assert.ok(back);
  viewAll();
  const search = sidebar.element("session-search-input");
  search.value = "find";
  const searchInput = search.listeners.get("input");
  assert.ok(searchInput);
  searchInput();
  sidebar.receive({ type: "showSessionDetail" });
  state([{ ...current, title: "Renamed current" }]);
  assert.equal(sidebar.element("session-header-title").textContent, "Renamed current");
  back();
  assert.equal(search.value, "find");
  assert.equal(sidebar.element("sessions-browser").hidden, false);
  assert.equal(sidebar.element("recent-session-list").hidden, true);
  assert.equal(sidebar.element("all-session-list").children.length, 0, "removed matches do not survive Back");
  assert.equal(sidebar.element("no-sessions").hidden, false);
  assert.equal(search.focusCount, 2, "Back restores focus to the expanded search");

  sidebar.receive({ type: "showSessionDetail" });
  state([added, { ...current, title: "Other current" }], true);
  back();
  const all = sidebar.element("all-session-list");
  assert.equal(search.value, "find");
  assert.equal(search.focusCount, 3);
  assert.equal(all.children.length, 1);
  assert.equal(all.children[0]?.dataset.sessionId, added.id);
  assert.equal(all.children[0]?.children[0]?.textContent, added.title);
  assert.equal(all.children[0]?.disabled, true);
  assert.equal(sidebar.element("no-sessions").hidden, true);
  const posted = sidebar.posted.length;
  const selectSession = all.listeners.get("click");
  assert.ok(selectSession);
  selectSession({ target: all.children[0] });
  assert.equal(sidebar.posted.length, posted, "a fresh row still respects the interaction lock");

  const latest = { ...added, title: "Find <script>latest</script>", current: true };
  state([latest]);
  assert.equal(all.children.length, 1, "visible state updates still refresh the filtered list");
  assert.equal(all.children[0]?.disabled, false);
  assert.equal(all.children[0]?.children[0]?.textContent, latest.title);
  assert.equal(all.children[0]?.children[0]?.innerHTML, "", "session titles remain inert text");
  assert.equal(all.children[0]?.["aria-current"], "page");
  assert.equal(sidebar.element("recent-session-list").children.length, 1);
  assert.equal(sidebar.element("view-all-sessions").textContent, "View all (1)");
  state([]);
  assert.equal(all.children.length, 0);
  assert.equal(sidebar.element("recent-session-list").children.length, 0);
  assert.equal(sidebar.element("no-sessions").hidden, false);
});

test("hidden streaming state retains session list nodes without reconstructing rows", () => {
  const sidebar = createSidebarScriptHarness();
  const sessions = Array.from({ length: 100 }, (_, index) => ({
    id: index.toString(16).padStart(24, "0"),
    title: `Session ${index}`,
    updatedAt: Date.now(),
    current: index === 0,
  }));
  const state = (tick: number) =>
    sidebar.receive({
      type: "state",
      runtime: { connected: true, busy: tick > 0, cancellable: tick > 0 },
      sessions: sessions.slice(tick).map((session, index) => ({
        ...session,
        title: `${session.title} update ${tick}`,
        current: index === 0,
      })),
      messages: [{ id: "assistant", role: "assistant", html: `<p>Streaming ${tick}</p>` }],
    });
  state(0);
  sidebar.receive({ type: "showSessionDetail" });
  const retained = ["recent-session-list", "all-session-list"].map((id) => ({
    list: sidebar.element(id),
    rows: sidebar.element(id).children.map((row) => ({ row, children: [...row.children] })),
  }));
  assert.equal(retained[0]?.rows.length, 3);
  assert.equal(retained[1]?.rows.length, 100);
  for (let tick = 1; tick <= 3; tick += 1) {
    state(tick);
    assert.equal(sidebar.element("session-list-content").hidden, true);
    assert.equal(sidebar.element("session-header-title").textContent, `Session ${tick} update ${tick}`);
    for (const { list, rows } of retained) {
      assert.equal(list.children.length, rows.length);
      for (const [index, { row, children }] of rows.entries()) {
        assert.equal(list.children[index], row, "hidden state must not replace session rows");
        assert.equal(row.children[0], children[0]);
        assert.equal(row.children[1], children[1]);
      }
    }
  }
});

test("returning to collapsed Sessions focuses only a visible fallback", () => {
  const sidebar = createSidebarScriptHarness();
  const ids = ["a", "b", "c", "d"].map((character) => character.repeat(24));
  const sessions = ids.map((id, index) => ({
    id,
    title: `Session ${index + 1}`,
    updatedAt: Date.now() - index * 60_000,
    current: index === 3,
  }));
  sidebar.receive({
    type: "state",
    status: "Ready",
    runtime: { busy: false, cancellable: false, connected: true },
    sessions,
  });

  sidebar.receive({ type: "showSessionDetail" });
  sidebar.receive({ type: "showSessionsLayer" });

  assert.equal(
    sidebar.element("recent-session-list").children[0]?.focusCount,
    1,
    "the first visible row is the fallback",
  );
  assert.equal(
    sidebar.element("all-session-list").children[3]?.focusCount,
    0,
    "the current row in the hidden browser is not focused",
  );

  sidebar.receive({
    type: "state",
    status: "Ready",
    runtime: { busy: false, cancellable: false, connected: true },
    sessions: sessions.map((session) => ({ ...session, current: false })),
  });
  sidebar.receive({ type: "showSessionDetail" });
  sidebar.receive({ type: "showSessionsLayer" });

  assert.equal(
    sidebar.element("recent-session-list").children[0]?.focusCount,
    1,
    "a missing current session still gets a visible fallback",
  );
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
  sidebar.receive({
    type: "state",
    status: "Ready",
    runtime: { busy: false, cancellable: false, connected: true },
    sessions: [],
  });

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

test("idle host updates preserve local control locks and restore controls when each lock clears", () => {
  for (const lock of [
    "submissionPending",
    "backgroundSubmissionPending",
    "pendingImageReads",
    "recoveredDraftPending",
  ]) {
    const sidebar = createSidebarScriptHarness();
    const state = (locked: boolean, busy = false) =>
      sidebar.receive({
        type: "state",
        status: "Ready",
        backgroundSubmissionPending: lock === "backgroundSubmissionPending" && locked,
        runtime: {
          busy,
          connected: true,
          sessionFile: "/workspace/session.jsonl",
          thinkingLevel: "high",
          availableThinkingLevels: ["off", "high"],
        },
      });
    const controls = ["model-picker", "new-session", "delete-session"];
    state(false);
    for (const id of controls) assert.equal(sidebar.element(id).disabled, false, `${lock}: initially enabled ${id}`);
    const pendingValue =
      lock === "recoveredDraftPending"
        ? '{ id: "draft", text: "recover" }'
        : lock === "pendingImageReads"
          ? "1"
          : "true";
    sidebar.run(`${lock} = ${pendingValue}`);
    state(true);
    for (const id of controls) assert.equal(sidebar.element(id).disabled, true, `${lock}: locked ${id}`);
    assert.equal(sidebar.element("more").disabled, false, "read-only details remain reachable");
    const recovering = lock === "recoveredDraftPending";
    assert.equal(sidebar.element("input").disabled, recovering, `${lock}: input lock`);
    assert.equal(sidebar.element("add-context").disabled, recovering, `${lock}: attachment lock`);
    sidebar.run(`${lock} = ${recovering ? "undefined" : "0"}`);
    state(false);
    for (const id of controls) assert.equal(sidebar.element(id).disabled, false, `${lock}: restored ${id}`);
    assert.equal(sidebar.element("input").disabled, false);
    assert.equal(sidebar.element("add-context").disabled, false);
    state(false, true);
    for (const id of controls) assert.equal(sidebar.element(id).disabled, true, `${lock}: busy ${id}`);
    assert.equal(sidebar.element("add-context").disabled, false, "ordinary work still permits attachment capture");
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
      {
        id: "applied",
        label: "src/applied.ts:1-3",
        status: "applied",
        selected: ["h0", "h1", "h2"],
        totalHunks: 3,
        summary: "Applied 3/3 hunks.",
      },
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

test("combined model control shows thinking and opens host settings without changing the draft", () => {
  const sidebar = createSidebarScriptHarness();
  const model = { name: "A very long active model display name", provider: "provider", id: "full-model-id" };
  sidebar.receive({ type: "setInput", text: "Unsent request" });
  sidebar.receive({
    type: "state",
    runtime: { connected: true, model, thinkingLevel: "high", availableThinkingLevels: ["off", "low", "high"] },
  });
  assert.equal(sidebar.element("model-label").textContent, model.name);
  assert.equal(sidebar.element("thinking-label").textContent, "High");
  const picker = sidebar.element("model-picker");
  assert.match(picker.title, /A very long active model display name.*provider\/full-model-id.*Thinking: High/);
  assert.match((picker as any)["aria-label"], /full-model-id.*Thinking: High.*Change model or thinking level/);
  picker.listeners.get("click")!();
  assert.equal(sidebar.posted.at(-1).type, "pickComposerSettings");
  assert.equal(sidebar.element("input").value, "Unsent request");
  assert.equal(sidebar.run("composerRevision"), 1);
  assert.equal(
    sidebar.posted.some((item) => ["send", "setThinking", "pickModel"].includes(item.type)),
    false,
  );

  sidebar.receive({
    type: "state",
    runtime: { connected: true, thinkingLevel: "off", availableThinkingLevels: ["off"] },
  });
  assert.equal(sidebar.element("thinking-label").textContent, "Off");
  assert.equal(picker.disabled, false, "one thinking level must not disable model changes");
  assert.match(sidebar.element("settings-description").textContent, /Only one thinking level/);
});

test("combined thinking label covers all levels, stale availability and unavailable state", () => {
  const sidebar = createSidebarScriptHarness();
  for (const [level, label] of [
    ["off", "Off"],
    ["minimal", "Minimal"],
    ["low", "Low"],
    ["medium", "Medium"],
    ["high", "High"],
    ["xhigh", "X-high"],
  ]) {
    sidebar.receive({
      type: "state",
      runtime: { connected: true, thinkingLevel: level, availableThinkingLevels: ["off"] },
    });
    assert.equal(sidebar.element("thinking-label").textContent, label, "current value remains authoritative");
    assert.match(sidebar.element("model-picker").title, new RegExp(`Thinking: ${label}`));
  }
  sidebar.receive({ type: "state", runtime: { connected: true } });
  assert.equal(sidebar.element("thinking-label").textContent, "");
  assert.equal(sidebar.element("model-picker").disabled, false);
  assert.match(sidebar.element("model-picker").title, /Thinking: Unavailable/);
  assert.match(sidebar.element("settings-description").textContent, /unavailable for this model/);
});

test("transcript image assets render without HTML injection and preview restores focus after close or Escape", () => {
  const sidebar = createSidebarScriptHarness();
  const bytes = Buffer.alloc(11);
  bytes.write("GIF89a", 0, "ascii");
  bytes.writeUInt16LE(3, 6);
  bytes.writeUInt16LE(2, 8);
  const data = bytes.toString("base64");
  const id = imageAssetId(bytes);
  const image = {
    type: "image",
    assetId: id,
    label: "diagram.gif",
    fullLabel: "screenshots/diagram.gif",
    mimeType: "image/gif",
    width: 3,
    height: 2,
    availability: "available",
  };
  sidebar.receive({
    type: "state",
    status: "Ready",
    runtime: { busy: false, cancellable: false, connected: true },
    messages: [
      {
        role: "user",
        html: "<p>See this</p>",
        attachments: [{ type: "context", label: "…/feature.ts:1-3", fullLabel: "src/deep/feature.ts:1-3" }, image],
      },
    ],
  });
  const contextChip = sidebar.run("messagesElement.children[0].children[2].children[0]") as SidebarTestElement;
  assert.equal(contextChip.textContent, "…/feature.ts:1-3");
  assert.equal(contextChip.title, "src/deep/feature.ts:1-3");
  let trigger = sidebar.run(`imageTargets.get(${JSON.stringify(id)})[0].button`) as SidebarTestElement;
  assert.match(trigger.children[0]!.textContent, /Loading image/);

  sidebar.receive({
    type: "imageAsset",
    id,
    mimeType: "image/gif",
    data,
    byteLength: bytes.length,
    width: 3,
    height: 2,
  });
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
  sidebar.receive({
    type: "state",
    status: "Pi is working…",
    runtime: { busy: true, cancellable: true, connected: true },
    messages: [{ role: "user", html: "<p>See this</p>", attachments: [image] }],
  });
  const detachedTrigger = trigger;
  trigger = sidebar.run(`imageTargets.get(${JSON.stringify(id)})[0].button`) as SidebarTestElement;
  let prevented = false;
  sidebar.element("image-preview").listeners.get("cancel")!({
    preventDefault: () => {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
  assert.equal(detachedTrigger.focusCount, 1, "the detached trigger is not focused again");
  assert.equal(trigger.focusCount, 1, "focus returns to the rerendered visible thumbnail");

  for (let marker = 1; marker <= 100; marker += 1) {
    const other = Buffer.from(bytes);
    other[10] = marker;
    sidebar.receive({
      type: "imageAsset",
      id: imageAssetId(other),
      mimeType: "image/gif",
      data: other.toString("base64"),
      byteLength: other.length,
      width: 3,
      height: 2,
    });
  }
  assert.equal(trigger.disabled, true);
  assert.match(trigger.children[0]!.textContent, /unavailable/i);
  assert.ok(sidebar.posted.some((message) => message.type === "imageAssetEvicted" && message.id === id));

  sidebar.receive({
    type: "state",
    status: "Ready",
    runtime: { busy: false, cancellable: false, connected: true },
    messages: [
      {
        role: "user",
        html: "<p>Missing</p>",
        attachments: [{ ...image, assetId: `unavailable-${"a".repeat(64)}`, availability: "unavailable" }],
      },
    ],
  });
  const unavailable = sidebar.run(
    `imageTargets.get(${JSON.stringify(`unavailable-${"a".repeat(64)}`)})[0].button`,
  ) as SidebarTestElement;
  assert.equal(unavailable.disabled, true);
  assert.match(unavailable.children[0]!.textContent, /unavailable/i);
});

test("composer image attachments use thumbnail cards with preview and remove actions", () => {
  const sidebar = createSidebarScriptHarness();
  const bytes = Buffer.alloc(11);
  bytes.write("GIF89a", 0, "ascii");
  bytes.writeUInt16LE(3, 6);
  bytes.writeUInt16LE(2, 8);
  const data = bytes.toString("base64");
  const id = imageAssetId(bytes);
  const attachment = {
    id: "draft-image",
    image: true,
    type: "image",
    assetId: id,
    label: "image.png",
    fullLabel: "image.png",
    mimeType: "image/gif",
    width: 3,
    height: 2,
    availability: "available",
  };

  sidebar.receive({
    type: "state",
    status: "Ready",
    imageSupported: true,
    runtime: { busy: false, cancellable: false, connected: true },
    attachments: [attachment],
  });
  const card = sidebar.element("attachments").children[0]!;
  assert.equal(card.className, "attachment-image");
  assert.equal(card.children[1]?.textContent, "image.png");
  const preview = sidebar.run(`imageTargets.get(${JSON.stringify(id)})[0].button`) as SidebarTestElement;
  assert.match(preview.children[0]!.textContent, /Loading preview/);

  sidebar.receive({
    type: "imageAsset",
    id,
    mimeType: "image/gif",
    data,
    byteLength: bytes.length,
    width: 3,
    height: 2,
  });
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
  const attachment = {
    id: "draft-image",
    image: true,
    type: "image",
    assetId: `sha256-${"a".repeat(64)}`,
    label: "image.png",
    fullLabel: "image.png",
    mimeType: "image/png",
    availability: "available",
  };
  sidebar.receive({
    type: "state",
    status: "Ready",
    imageSupported: true,
    runtime: { busy: false, cancellable: false, connected: true },
    attachments: [attachment],
  });

  assert.equal(sidebar.element("input").value, "");
  assert.equal(sidebar.element("send").disabled, false);
  assert.equal(sidebar.element("send").title, "Send attachments");
  sidebar.element("send").listeners.get("click")!();
  assert.equal(sidebar.posted.at(-1)?.type, "sendNewSession");
  assert.equal(sidebar.posted.at(-1)?.text, "");
  assert.equal(sidebar.posted.at(-1)?.revision, 0);
});

test("an attachment removal race can release a pending submission", () => {
  const sidebar = createSidebarScriptHarness();
  const attachment = { id: "draft-context", image: false, type: "selection", label: "Selection from example.ts" };
  sidebar.receive({
    type: "state",
    status: "Ready",
    runtime: { busy: false, cancellable: false, connected: true },
    attachments: [attachment],
  });

  sidebar.element("send").listeners.get("click")!();
  assert.equal(sidebar.run("submissionPending"), true);
  assert.equal(sidebar.element("status").textContent, "Sending to Pi…");

  sidebar.receive({
    type: "state",
    status: "Ready",
    runtime: { busy: false, cancellable: false, connected: true },
    attachments: [],
  });
  sidebar.receive({ type: "sendRejected" });
  assert.equal(sidebar.run("submissionPending"), false);
  assert.equal(sidebar.element("status").textContent, "Ready");
});

for (const reason of ["eviction", "rejection"] as const) {
  test(`image ${reason} updates transcript and composer once with separate preview behavior`, () => {
    const sidebar = createSidebarScriptHarness();
    const bytes = Buffer.alloc(11);
    bytes.write("GIF89a", 0, "ascii");
    bytes.writeUInt16LE(3, 6);
    bytes.writeUInt16LE(2, 8);
    const id = imageAssetId(bytes);
    const attachment = {
      type: "image",
      assetId: id,
      label: "shared.gif",
      fullLabel: "shared.gif",
      mimeType: "image/gif",
      width: 3,
      height: 2,
      availability: "available",
    };
    const deliver = (payload: Buffer) =>
      sidebar.receive({
        type: "imageAsset",
        id: imageAssetId(payload),
        mimeType: "image/gif",
        data: payload.toString("base64"),
        byteLength: payload.length,
      });
    sidebar.receive({
      type: "state",
      status: "Ready",
      imageSupported: true,
      runtime: { busy: false, connected: true },
      messages: [{ role: "user", html: "<p>Shared image</p>", attachments: [{ ...attachment }] }],
      attachments: [{ ...attachment, id: "draft-image", image: true }],
    });
    deliver(bytes);
    const targets = sidebar.run(`imageTargets.get(${JSON.stringify(id)})`) as { button: SidebarTestElement }[];
    assert.equal(targets.length, 2);
    assert.equal(sidebar.run("imageAssetCacheBytes"), bytes.length, "one payload serves both surfaces");
    const [transcript, composer] = targets;
    assert.ok(transcript);
    assert.ok(composer);
    const openPreview = sidebar.element("messages").listeners.get("click");
    assert.ok(openPreview);
    openPreview({ target: transcript.button });
    assert.equal(sidebar.element("image-preview").open, true);

    if (reason === "eviction") {
      for (let marker = 1; marker <= 100; marker += 1) {
        const other = Buffer.from(bytes);
        other[10] = marker;
        deliver(other);
      }
    } else {
      const thumbnail = composer.button.children[0];
      assert.ok(thumbnail);
      const rejectAsset = thumbnail.listeners.get("error");
      assert.ok(rejectAsset);
      rejectAsset();
    }
    for (const { button } of targets) {
      assert.equal(button.disabled, true);
      const placeholder = button.children[0];
      assert.ok(placeholder);
      assert.match(placeholder.textContent, /unavailable/i);
    }
    assert.equal(sidebar.run(`imageAssetCache.has(${JSON.stringify(id)})`), false);
    const retainedBytes = reason === "eviction" ? 100 * bytes.length : 0;
    assert.equal(sidebar.run("imageAssetCacheBytes"), retainedBytes);
    assert.equal(sidebar.element("image-preview").open, reason === "eviction");
    const notifications = sidebar.posted.filter((message) => message.id === id);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].type, reason === "eviction" ? "imageAssetEvicted" : "imageAssetRejected");
    sidebar.run(`rejectImageAsset(${JSON.stringify(id)})`);
    assert.equal(sidebar.run("imageAssetCacheBytes"), retainedBytes, "missing rejection does not subtract again");
    assert.equal(sidebar.posted.filter((message) => message.id === id).length, 1, "missing rejection is silent");
    assert.equal(sidebar.element("image-preview").open, reason === "eviction");
  });
}

test("thumbnail and preview decode failures become unavailable without retrying corrupt payloads", () => {
  const bytes = Buffer.alloc(11);
  bytes.write("GIF89a", 0, "ascii");
  bytes.writeUInt16LE(3, 6);
  bytes.writeUInt16LE(2, 8);
  const data = bytes.toString("base64");
  const id = imageAssetId(bytes);
  const attachment = {
    type: "image",
    assetId: id,
    label: "broken.gif",
    fullLabel: "broken.gif",
    mimeType: "image/gif",
    width: 3,
    height: 2,
    availability: "available",
  };

  const thumbnailSidebar = createSidebarScriptHarness();
  thumbnailSidebar.receive({
    type: "state",
    status: "Ready",
    runtime: { busy: false, cancellable: false, connected: true },
    messages: [{ role: "user", html: "<p>Broken</p>", attachments: [attachment] }],
  });
  thumbnailSidebar.receive({
    type: "imageAsset",
    id,
    mimeType: "image/gif",
    data,
    byteLength: bytes.length,
    width: 3,
    height: 2,
  });
  const thumbnail = thumbnailSidebar.run(`imageTargets.get(${JSON.stringify(id)})[0].button`) as SidebarTestElement;
  thumbnail.children[0]!.listeners.get("error")!();
  assert.equal(thumbnail.disabled, true);
  assert.match(thumbnail.children[0]!.textContent, /unavailable/i);
  assert.equal(thumbnailSidebar.posted.at(-1)?.type, "imageAssetRejected");
  assert.equal(thumbnailSidebar.posted.at(-1)?.id, id);

  const previewSidebar = createSidebarScriptHarness();
  previewSidebar.receive({
    type: "state",
    status: "Ready",
    runtime: { busy: false, cancellable: false, connected: true },
    messages: [{ role: "user", html: "<p>Broken preview</p>", attachments: [{ ...attachment }] }],
  });
  previewSidebar.receive({
    type: "imageAsset",
    id,
    mimeType: "image/gif",
    data,
    byteLength: bytes.length,
    width: 3,
    height: 2,
  });
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
  bytes.write("GIF89a", 0, "ascii");
  bytes.writeUInt16LE(3, 6);
  bytes.writeUInt16LE(2, 8);
  const data = bytes.toString("base64");
  const id = imageAssetId(bytes);
  const image = {
    type: "image",
    assetId: id,
    label: "below.gif",
    fullLabel: "below.gif",
    mimeType: "image/gif",
    width: 3,
    height: 2,
    availability: "available",
  };
  sidebar.receive({
    type: "state",
    status: "Ready",
    runtime: { busy: false, cancellable: false, connected: true },
    messages: [{ role: "user", html: "<p>Below</p>", attachments: [image] }],
  });
  const conversation = sidebar.element("conversation");
  conversation.scrollHeight = 300;
  conversation.scrollTop = 50;
  conversation.clientHeight = 100;
  conversation.rect = { top: 0, bottom: 100 };
  const trigger = sidebar.run(`imageTargets.get(${JSON.stringify(id)})[0].button`) as SidebarTestElement;
  trigger.rect = { top: 120, bottom: 190 };

  sidebar.receive({
    type: "imageAsset",
    id,
    mimeType: "image/gif",
    data,
    byteLength: bytes.length,
    width: 3,
    height: 2,
  });
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
  tools.appendChild = (element) => {
    appendTool(element);
    conversation.scrollHeight = 180;
  };
  sidebar.receive({
    type: "state",
    status: "Running read…",
    runtime: { busy: true, cancellable: true, connected: true },
    messages: [{ role: "assistant", html: "<p>Reply</p>" }],
    tools: [{ id: "tool-1", name: "read", status: "running", input: "file.ts", output: "" }],
  });
  assert.equal(conversation.scrollTop, 180);
});

test("tool activity preserves manual group opening but collapses untouched calls at settlement", () => {
  const sidebar = createSidebarScriptHarness();
  const state = (phase: "running" | "tool-complete" | "settled", html: string) =>
    sidebar.receive({
      type: "state",
      status: phase === "running" ? "Running bash…" : phase === "tool-complete" ? "Pi is working…" : "Ready",
      runtime: { busy: phase !== "settled", cancellable: phase !== "settled", connected: true },
      messages: [{ id: "assistant-1", role: "assistant", html }],
      tools: [
        {
          id: "tool-1",
          name: "bash",
          status: phase === "running" ? "running" : "success",
          input: "npm test",
          output: phase === "running" ? "Running" : "Passed",
        },
      ],
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
  assert.equal(group.open, true, "manual opening survives request settlement");
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
  const state = (html: string, output: string, appendMessage = false) =>
    sidebar.receive({
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
  assert.equal(tool.children[3]?.children[1]?.textContent, "one\ntwo");
  assert.equal(sidebar.element("attachments").children[0], attachment);
  assert.equal(sidebar.element("add-context").disabled, false);

  state("<p>First second</p>", "one\ntwo", true);
  assert.equal(
    sidebar.element("attachments").children[0],
    attachment,
    "message-structure updates keep unchanged composer attachments",
  );

  const full = tool.children[3]!.children[2]!;
  full.open = true;
  const output = sidebar.element("conversation");
  output.scrollHeight = 400;
  output.clientHeight = 100;
  output.scrollTop = 40;
  output.listeners.get("scroll")!({ isTrusted: true });
  state("<p>First second third</p>", "one\ntwo\nthree");
  assert.equal(output.scrollTop, 40, "streamed tool output preserves a reader's position");
  assert.equal(full.open, true);
  assert.equal(full.children[1]?.textContent, "one\ntwo\nthree");
  assert.equal(tool.children[2]?.children[1]?.textContent, "file.ts");
  output.scrollTop = 300;
  output.listeners.get("scroll")!({ isTrusted: true });
  state("<p>First second third</p>", "one\ntwo\nthree\nfour");
  assert.equal(output.scrollTop, 400, "tool output follows updates when already at the bottom");
});

test("busy, settling, cancellation, failure, and reconnection states expose one status and every cancellable state exposes Stop", () => {
  const sidebar = createSidebarScriptHarness();
  const state = (
    status: string,
    busy: boolean,
    cancellable: boolean,
    connected = true,
    backgroundSubmissionPending = false,
  ) =>
    sidebar.receive({ type: "state", status, backgroundSubmissionPending, runtime: { busy, cancellable, connected } });
  for (const status of [
    "Sending to Pi…",
    "Pi is working…",
    "Running read…",
    "Finishing Pi response…",
    "Cancelling Pi request…",
  ]) {
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
  assert.equal(
    sidebar.element("status").textContent,
    "Starting background agent…",
    "Ready is not shown beside a wait state",
  );
  state("Disconnected · Reconnect available", false, false, false);
  assert.match(sidebar.element("status").textContent, /Disconnected/);

  state("Pi is working…", true, true);
  sidebar.element("input").listeners.get("paste")!({
    clipboardData: {
      items: [
        {
          kind: "file",
          type: "image/gif",
          getAsFile: () => ({ type: "image/gif", size: 25, name: "during-work.gif" }),
        },
      ],
    },
    preventDefault() {},
  });
  assert.doesNotMatch(
    sidebar.element("notice").textContent,
    /Cancel or wait/,
    "pasting images remains available during active requests",
  );
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
      set() {
        assert.fail("A detached welcome button must not be updated");
      },
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
  assert.equal(
    sidebar.posted.some(
      (message) => message.type === "setInput" || message.type === "setMode" || message.type === "handoffAgent",
    ),
    false,
  );
});

test("composer keyboard submission matches Pi queue behavior on Alt+Enter platforms", () => {
  const sidebar = createSidebarScriptHarness("MacIntel");
  sidebar.receive({ type: "showSessionDetail" });
  const input = sidebar.element("input");
  const keydown = input.listeners.get("keydown")!;
  const press = (fields: Record<string, unknown>) => {
    let prevented = false;
    keydown({
      key: "Enter",
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      isComposing: false,
      preventDefault: () => {
        prevented = true;
      },
      ...fields,
    });
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
  sidebar.receive({
    type: "state",
    status: "Pi is working…",
    runtime: { busy: true, cancellable: true, connected: true, queueable: false },
    attachments: [],
  });
  assert.match(
    sidebar.element("notice").textContent,
    /does not accept queued messages/,
    "stream updates keep text-only queue feedback while busy",
  );
});

test("busy composer queues attachment-only steering and follow-up while preserving image gates", () => {
  const sidebar = createSidebarScriptHarness("MacIntel");
  sidebar.receive({ type: "showSessionDetail" });
  const input = sidebar.element("input");
  const keydown = input.listeners.get("keydown")!;
  const press = (fields: Record<string, unknown> = {}) =>
    keydown({
      key: "Enter",
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      isComposing: false,
      preventDefault() {},
      ...fields,
    });
  sidebar.run(
    "connected = true; busy = true; queueable = true; attachedItems = true; attachedImages = true; imageSupported = true; submissionPending = false; pendingImageReads = 0; updateSendState()",
  );

  input.value = "";
  press();
  const steering = sidebar.posted.at(-1);
  assert.equal(steering.type, "queueInstruction");
  assert.equal(steering.kind, "steer");
  assert.equal(steering.text, "");
  assert.equal(steering.revision, 0);
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
  assert.equal(sidebar.element("composer-hint").textContent, "Choose a model that supports images, or remove them");

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
  assert.equal(sidebar.element("queue-status").textContent, "2 messages queued");
  const pendingRows = sidebar.element("pending-queue").children;
  assert.equal(pendingRows.length, 2);
  assert.deepEqual(
    pendingRows[0]?.children.map((child) => child.textContent),
    ["Next:", "one · with attachments"],
  );
  assert.deepEqual(
    pendingRows[1]?.children.map((child) => child.textContent),
    ["After this:", "two"],
  );
  const contextQueueCount = sidebar.posted.length;
  sidebar.run("submissionPending = false; submit()");
  assert.equal(sidebar.posted.length, contextQueueCount + 1);
  assert.equal(sidebar.posted.at(-1).type, "queueInstruction");
  assert.equal(sidebar.posted.at(-1).text, "", "attachment-only text context is queued instead of deferred");
  assert.equal(sidebar.element("notice").textContent, "");
});

test("pending queue renders plain-language labels, duplicate text and safe bounded previews until delivery", () => {
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
  assert.equal(pending.children[1]?.children[1]?.textContent, `${queuedText} · with attachments`);

  sidebar.receive({
    type: "state",
    status: "Pi is working…",
    runtime: runtime([], [{ id: "later", kind: "followUp", text: "after completion", hasAttachments: false }]),
    messages: [{ id: "delivered", role: "user", html: "<p>continue here</p>" }],
    attachments: [],
  });
  assert.equal(pending.children.length, 1);
  assert.deepEqual(
    pending.children[0]?.children.map((child) => child.textContent),
    ["After this:", "after completion"],
  );
  assert.equal(sidebar.element("queue-status").textContent, "1 message queued");
  assert.equal(sidebar.element("messages").children.length, 1, "delivered input moves into the transcript state");

  sidebar.receive({
    type: "state",
    status: "Ready",
    runtime: { busy: false, connected: true, pendingQueue: { steering: [], followUp: [] } },
    attachments: [],
  });
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
    keydown({
      key: "q",
      shiftKey: false,
      altKey: false,
      ctrlKey: true,
      metaKey: false,
      isComposing: false,
      preventDefault: () => {
        prevented = true;
      },
      ...fields,
    });
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
    sidebar.run(
      `renderBackground([${JSON.stringify({ id: "task", title: "Task", status: "completed", sessionFile: "/session.jsonl", ...task })}])`,
    );
    return sidebar
      .element("background")
      .children[0]!.children.at(-1)!
      .children.map((button) => button.dataset.action);
  };
  assert.ok(actions({}).includes("resumeBackground"));
  const isolated = actions({ worktreePath: "/worktree", origin: {} });
  assert.ok(isolated.includes("openWorktree"));
  assert.equal(isolated.includes("resumeBackground"), false);
  assert.equal(actions({ worktreePath: "/legacy-worktree" }).includes("resumeBackground"), false);
  assert.equal(
    actions({ origin: {} }).includes("resumeBackground"),
    false,
    "cleanup does not make an isolated session resumable here",
  );
  assert.equal(actions({ status: "running" }).includes("resumeBackground"), false);
});

test("keyboard queue and accepted-send messages preserve newer drafts and never create transcript copies", () => {
  const sidebar = createSidebarScriptHarness();
  sidebar.receive({ type: "showSessionDetail" });
  const input = sidebar.element("input");
  const change = input.listeners.get("input")!;
  const keydown = input.listeners.get("keydown")!;
  const pressEnter = () =>
    keydown({
      key: "Enter",
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      isComposing: false,
      preventDefault() {},
    });
  sidebar.run("busy = true; connected = true; queueable = true; updateSendState()");
  input.value = "steer text";
  change();
  pressEnter();
  const queued = sidebar.posted.at(-1);
  assert.equal(queued.type, "queueInstruction");
  assert.equal(queued.kind, "steer");
  assert.equal(queued.text, "steer text");
  assert.equal(queued.revision, 1);
  assert.equal(sidebar.element("recover-queue").disabled, true, "recovery cannot start during queue acceptance");
  assert.equal(sidebar.element("messages").children.length, 0);
  input.value = "new draft";
  change();
  sidebar.receive({ type: "clearInput", expectedText: queued.text, expectedRevision: queued.revision });
  assert.equal(input.value, "new draft");
  const recoveredDraftId = "11111111-1111-4111-8111-111111111111";
  const postedBeforeStaleRecovery = sidebar.posted.length;
  sidebar.receive({ type: "appendDraft", text: "recovered", expectedRevision: 1, recoveredDraftId });
  assert.equal(input.value, "new draft");
  assert.equal(
    sidebar.element("notice").textContent,
    "Your draft changed. The recovered message is still available under Restore drafts.",
  );
  assert.equal(
    sidebar.posted.length,
    postedBeforeStaleRecovery,
    "stale text recovery does not consume its attachment handle",
  );
  sidebar.receive({ type: "appendDraft", text: "recovered", expectedRevision: 2, recoveredDraftId });
  assert.equal(input.value, "new draft", "recovered text waits for successful attachment restoration");
  assert.equal(input.disabled, true, "the composer is locked during the atomic recovery handshake");
  assert.equal(
    sidebar.posted.at(-1)?.type,
    "restoreQueueAttachments",
    "attachments restore only after text revision acceptance",
  );
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
  input.value = "callback continuation";
  change();
  const count = sidebar.posted.length;
  pressEnter();
  assert.equal(sidebar.posted.length, count);
});
