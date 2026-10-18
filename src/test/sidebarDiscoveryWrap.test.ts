import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createContext, Script } from "node:vm";
import { getSidebarHtml } from "../sidebarHtml";
import { installVscodeMock, MockUri } from "./vscodeMock";

const html = () => getSidebarHtml(100_000, 1024);
function functionsBetween(first: string, next: string): string {
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html())?.[1];
  assert.ok(script);
  const start = script.indexOf(`function ${first}(`);
  const end = script.indexOf(`function ${next}(`, start);
  assert.ok(start >= 0 && end > start);
  return script.slice(start, end);
}

test("file discovery help is available before typing and never advertises shell or unsupported workspaces", () => {
  const hint = { textContent: "" };
  const context = createContext({
    $: () => hint,
    input: { value: "" },
    fileCompletionSupport: { available: true },
  });
  new Script(functionsBetween("updateFileDiscoveryHint", "toggleCodeWrapping")).runInContext(context);
  const run = (source = "") => new Script(`${source}; updateFileDiscoveryHint()`).runInContext(context);
  run();
  assert.match(hint.textContent, /@ selects a file snapshot to attach/);
  assert.match(hint.textContent, /Tab on a visible path suggestion inserts only its path/);
  assert.doesNotMatch(hint.textContent, /Enter/);
  for (const value of ["!ls", "!!ls", "/compact", " /skill:test @file"]) {
    run(`input.value = ${JSON.stringify(value)}`);
    assert.match(hint.textContent, /unavailable/);
    assert.doesNotMatch(hint.textContent, /@ selects|Tab on/);
  }
  run("input.value = ''; fileCompletionSupport = {available:false,reason:'Workspace mismatch.'}");
  assert.equal(hint.textContent, "Workspace mismatch.");
  assert.match(html(), /id="file-discovery-hint"/);
  assert.match(html(), /aria-describedby="[^"]*file-discovery-hint/);
});

class MessageNode {
  children: MessageNode[] = [];
  className = "";
  textContent = "";
  innerHTML = "";
  id = "";
  classList = { toggle() {} };
  thinkingDisclosure?: MessageNode;
  open = false;
  attributes: Record<string, string> = {};
  constructor(
    readonly tagName: string,
    private readonly focusNode: (node: MessageNode) => void,
  ) {}
  append(...nodes: MessageNode[]): void {
    this.children.push(...nodes);
  }
  appendChild(node: MessageNode): void {
    this.append(node);
  }
  replaceChildren(): void {
    this.children = [];
  }
  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
  focus(): void {
    this.focusNode(this);
  }
}

test("message headings retain locally generated identity and focus through streaming and history replacement", () => {
  const document: { activeElement?: MessageNode; createElement: (tag: string) => MessageNode } = {
    createElement: (tag) => new MessageNode(tag, (node) => (document.activeElement = node)),
  };
  const messagesElement = document.createElement("section");
  const context = createContext({
    document,
    messagesElement,
    conversationElement: { scrollTop: 42 },
    conversationPinnedToBottom: false,
    lastTranscriptSignature: "",
    hasNewTranscriptOutput: false,
    renderedMessageStructure: "",
    renderedMessageHtml: [],
    messageHeadingSequence: 0,
    emptyActionButtons: [],
    forgetImageTargets() {},
    setConversationScrollTop() {},
    setMessageContent: (node: MessageNode, value: string) => (node.innerHTML = value),
  });
  new Script(functionsBetween("renderThinking", "renderTranscriptImage")).runInContext(context);
  const render = (messages: unknown[]) =>
    new Script(`renderMessages(${JSON.stringify(messages)})`).runInContext(context);
  const answer = {
    id: "untrusted-id-with spaces",
    role: "assistant",
    html: "<p>Answer</p>",
    thinking: [{ text: "x" }],
  };
  render([answer]);
  const heading = messagesElement.children[0]?.children[0];
  assert.ok(heading);
  assert.equal(heading.tagName, "h2");
  assert.match(heading.id, /^pi-message-heading-\d+$/);
  assert.equal(heading.attributes["aria-label"], "Pi message 1");
  const assertDecorativeMark = () => {
    assert.equal(heading.children.length, 2);
    const mark = heading.children[0];
    assert.equal(mark?.tagName, "span");
    assert.equal(mark.className, "role-icon");
    assert.equal(mark.attributes["aria-hidden"], "true");
    assert.equal(mark.textContent, "π");
    assert.equal(heading.children[1]?.textContent, "Pi");
  };
  assertDecorativeMark();
  assert.doesNotMatch(html(), /\.assistant \.role::before/);
  assert.match(html(), /\.assistant \.role-icon \{ display: grid; place-items: center; width: 18px; height: 18px/);
  assert.equal(messagesElement.children[0]?.attributes["aria-labelledby"], heading.id);
  heading.focus();
  render([{ ...answer, html: "<p>Answer delta</p>" }]);
  assert.equal(messagesElement.children[0]?.children[0], heading);
  assert.equal(document.activeElement, heading);
  render([{ id: "user", role: "user", html: "<p>Earlier</p>" }, answer]);
  assert.equal(messagesElement.children[1]?.children[0], heading);
  assert.equal(heading.attributes["aria-label"], "Pi message 2");
  assertDecorativeMark();
  const userHeading = messagesElement.children[0]?.children[0];
  assert.equal(userHeading?.children.length, 1);
  assert.equal(userHeading.children[0]?.textContent, "You");
  assert.equal(document.activeElement, heading);
  assert.equal(messagesElement.children[1]?.thinkingDisclosure?.open, false);
  render([answer, answer, { id: "shell", role: "shell", html: "<pre>Inert</pre>" }]);
  const ids = messagesElement.children.map((node) => node.children[0]?.id);
  assert.equal(new Set(ids).size, 3, "even duplicate host IDs cannot duplicate DOM heading IDs");
  const shellHeading = messagesElement.children[2]?.children[0];
  assert.equal(shellHeading?.attributes["aria-label"], "Shell message 3");
  assert.equal(shellHeading.children.length, 1);
  assert.equal(shellHeading.children[0]?.textContent, "Shell");
});

test("wrapping is scoped to transcript source and uses no persistence, source rewrite, or CSP expansion", () => {
  const source = html();
  assert.doesNotMatch(source, /id="(?:wrap-code|transcript-controls)"/);
  assert.match(source, /type: 'showMoreActions'.*codeWrapping: messagesElement\.classList\.contains\('wrap-code'\)/);
  assert.match(source, /message\.type === 'toggleCodeWrapping'\) toggleCodeWrapping\(\)/);
  assert.match(source, /#messages\.wrap-code \.message:not\(\.shell\) \.content pre code/);
  assert.match(source, /white-space: pre-wrap; overflow-wrap: anywhere; word-break: normal/);
  const toggle = functionsBetween("toggleCodeWrapping", "renderThinking");
  assert.match(toggle, /const enabled = !messagesElement\.classList\.contains\('wrap-code'\)/);
  assert.match(toggle, /classList\.toggle\('wrap-code', enabled\)/);
  assert.match(toggle, /const readingEdge = bounds\.top;/);
  assert.doesNotMatch(toggle, /transcript-controls|\$\('wrap-code'\)/);
  assert.match(toggle, /conversationElement\.scrollTop \+ after - before/);
  assert.match(toggle, /pi-transcript-layout/);
  assert.doesNotMatch(toggle, /innerHTML\s*=|textContent\s*=|postMessage|setState|localStorage|\.focus\(/);
  assert.match(source, /<section id="messages" aria-live="off">/);
  assert.match(source, /default-src 'none'/);
  assert.doesNotMatch(source, /unsafe-eval|connect-src/);
});

test("menu-driven wrapping preserves reading position and bottom following from class state", () => {
  const classes = new Set<string>();
  const events: string[] = [];
  let followCalls = 0;
  const anchor = {
    tagName: "PRE",
    getBoundingClientRect: () => ({ top: classes.has("wrap-code") ? -30 : -20, bottom: 200 }),
  };
  const conversationElement = {
    scrollTop: 50,
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 300, bottom: 100 }),
  };
  const context = createContext({
    conversationElement,
    conversationPinnedToBottom: false,
    wrapReadingAnchor: undefined,
    wrapReadingTop: 0,
    document: { activeElement: undefined },
    messagesElement: {
      querySelectorAll: () => [anchor],
      contains: (node: unknown) => node === anchor,
      classList: {
        contains: (name: string) => classes.has(name),
        toggle: (name: string, enabled: boolean) => (enabled ? classes.add(name) : classes.delete(name)),
      },
    },
    setConversationScrollTop: (value: number) => {
      conversationElement.scrollTop = value;
    },
    scrollConversationToBottom: () => {
      followCalls++;
    },
    window: { dispatchEvent: (event: { type: string }) => events.push(event.type) },
    Event: class {
      constructor(public type: string) {}
    },
  });
  new Script(functionsBetween("toggleCodeWrapping", "renderThinking")).runInContext(context);
  const toggle = (prefix = "") => new Script(`${prefix}; toggleCodeWrapping()`).runInContext(context);
  assert.equal(classes.has("wrap-code"), false);
  toggle();
  assert.equal(classes.has("wrap-code"), true);
  assert.equal(conversationElement.scrollTop, 40);
  toggle();
  assert.equal(classes.has("wrap-code"), false);
  assert.equal(conversationElement.scrollTop, 50);
  assert.equal(followCalls, 0);
  toggle("conversationPinnedToBottom = true");
  assert.equal(followCalls, 1);
  assert.equal(context.conversationPinnedToBottom, true);
  assert.deepEqual(events, Array(3).fill("pi-transcript-layout"));
});

test("file completion support checks canonical workspace metadata without discovery or a Pi request", async () => {
  const vscode = installVscodeMock();
  const root = await mkdtemp(path.join(tmpdir(), "pi-discovery-support-"));
  const alias = `${root}-alias`;
  try {
    await symlink(root, alias, "junction");
    const { SidebarFileCompletion } = require("../sidebarFileCompletion") as typeof import("../sidebarFileCompletion");
    const folder = (uri: MockUri) => ({ uri, name: "fixture", index: 0 });
    vscode.workspace.workspaceFolders = [folder(MockUri.file(alias))];
    vscode.workspace.findFiles = () => assert.fail("passive support must not search files");
    let callbacks = 0;
    let cwd = root;
    const completion = new SidebarFileCompletion({
      cwd: () => cwd,
      session: () => "fixture",
      attachments: {} as import("../sidebarAttachments").SidebarAttachmentManager,
      post: () => assert.fail("passive support must not post completion results"),
      onSupportChange: () => (callbacks += 1),
    });
    const refresh = async () => {
      const before = callbacks;
      void completion.support;
      for (let count = 0; count < 100 && callbacks === before; count += 1)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.ok(callbacks > before, "support resolves and notifies the host");
      return completion.support;
    };
    assert.equal((await refresh()).available, true, "workspace-root aliases are supported");
    assert.equal(completion.support.available, true, "the resolved binding is retained");
    vscode.workspace.isTrusted = false;
    assert.match((await refresh()).reason ?? "", /trusted workspace/);
    vscode.workspace.isTrusted = true;
    vscode.workspace.workspaceFolders = [folder(new MockUri("memfs", "/virtual"))];
    assert.match((await refresh()).reason ?? "", /file-backed/);
    vscode.workspace.workspaceFolders = [folder(MockUri.file(root))];
    cwd = tmpdir();
    assert.match((await refresh()).reason ?? "", /matching the Pi working directory/);
    cwd = root;
    void completion.support;
    completion.dispose();
    const before = callbacks;
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(callbacks, before, "late support cannot update a disposed view");
  } finally {
    vscode.restore();
    await rm(alias, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});
