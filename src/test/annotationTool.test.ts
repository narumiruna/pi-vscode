import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import net from "node:net";
import path from "node:path";

type Request = { id: string; token: string; method: string; params: Record<string, unknown> };
type Reply = { ok: true; result: unknown } | { ok: false; error: string };
type Context = { cwd: string; sessionManager: { getSessionId(): string } };
type Tool = {
  name: string;
  description: string;
  promptGuidelines: string[];
  parameters: {
    properties: {
      path: { type: string };
      annotations: {
        maxItems: number;
        items: {
          properties: Record<
            "startLine" | "endLine" | "expectedText" | "message",
            { minimum?: number; maxLength?: number }
          >;
        };
      };
    };
  };
  execute(
    id: string,
    params: { path: string; annotations: typeof annotations },
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: Context,
  ): Promise<{ content: { type: string; text: string }[]; details: unknown }>;
};

const bridgeToken = "fixture-window-authentication";
const credential = "private-launch-credential-not-for-output";
const origin = "a".repeat(64);
const annotations = [{ startLine: 2, endLine: 3, expectedText: "line two\nline three", message: "Passage note" }];
const environmentKeys = ["PI_VSCODE_BRIDGE_PORT", "PI_VSCODE_BRIDGE_TOKEN", "PI_VSCODE_ANNOTATION_TOKEN"] as const;

// Only the external Pi SDK/schema imports are replaced: registration, execute, path resolution,
// cancellation, serialization and the actual authenticated TCP transport run from the packaged source.
async function registeredTool(): Promise<Tool> {
  const source = stripTypeScriptTypes(readFileSync(path.resolve(__dirname, "../../resources/pi-bridge.ts"), "utf8"))
    .replace(
      'import { StringEnum } from "@earendil-works/pi-ai";',
      "const StringEnum = (values) => ({ enum: values });",
    )
    .replace(
      'import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";',
      `const DEFAULT_MAX_BYTES = 50000, DEFAULT_MAX_LINES = 2000;
       const formatSize = (size) => String(size);
       const truncateHead = (content) => ({ content, truncated: false });`,
    )
    .replace(
      'import { Type } from "typebox";',
      `const Type = {
        Object: (properties) => ({ type: "object", properties }),
        String: (options) => ({ type: "string", ...options }),
        Integer: (options) => ({ type: "integer", ...options }),
        Boolean: (options) => ({ type: "boolean", ...options }),
        Optional: (schema) => schema,
        Array: (items, options) => ({ type: "array", items, ...options }),
      };`,
    );
  const { default: initialize } = await import(`data:text/javascript,${encodeURIComponent(source)}#${randomUUID()}`);
  const tools = new Map<string, Tool>();
  initialize({
    registerCommand: () => {},
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    events: { on: () => {} },
    on: () => {},
  });
  const tool = tools.get("vscode_annotate");
  assert.ok(tool);
  assert.equal(tools.size, 5, "The annotation tool is part of the existing packaged bridge");
  return tool;
}

async function fixture(reply: (request: Request) => Reply | undefined, launchCredential: string | null = credential) {
  const previous = new Map(environmentKeys.map((key) => [key, process.env[key]]));
  const sockets = new Set<net.Socket>();
  const requests: Request[] = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as Request;
      buffer = buffer.slice(newline + 1);
      assert.equal(request.token, bridgeToken, "Existing bridge authentication is unchanged");
      assert.equal(typeof request.id, "string");
      requests.push(request);
      const response = reply(request);
      if (response) socket.end(`${JSON.stringify({ id: request.id, ...response })}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as net.AddressInfo;
  process.env.PI_VSCODE_BRIDGE_PORT = String(address.port);
  process.env.PI_VSCODE_BRIDGE_TOKEN = bridgeToken;
  if (launchCredential === null) delete process.env.PI_VSCODE_ANNOTATION_TOKEN;
  else process.env.PI_VSCODE_ANNOTATION_TOKEN = launchCredential;
  const tool = await registeredTool();
  const ctx: Context = {
    cwd: path.resolve("fixture-workspace"),
    sessionManager: { getSessionId: () => "session-one" },
  };
  return {
    tool,
    ctx,
    requests,
    execute: (target = "@src/example.ts", values = annotations, signal?: AbortSignal) =>
      tool.execute("tool-call", { path: target, annotations: values }, signal, undefined, ctx),
    async dispose() {
      for (const key of environmentKeys) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

function assertPrivateError(error: unknown): boolean {
  assert.ok(error instanceof Error);
  assert.match(error.message, /VS Code annotation request failed/);
  assert.doesNotMatch(error.message, new RegExp(`${credential}|${origin}|host-secret`));
  return true;
}

test("packaged annotation tool declares bounded editor-only input and useful-passage guidance", async () => {
  const tool = await registeredTool();
  const schema = tool.parameters.properties;
  assert.deepEqual(Object.keys(schema), ["path", "annotations"]);
  assert.equal(schema.path.type, "string");
  assert.equal(schema.annotations.maxItems, 20);
  const item = schema.annotations.items.properties;
  assert.deepEqual(Object.keys(item), ["startLine", "endLine", "expectedText", "message"]);
  assert.equal(item.startLine.minimum, 1);
  assert.equal(item.endLine.minimum, 1);
  assert.equal(item.expectedText.maxLength, 10_000);
  assert.equal(item.message.maxLength, 1_000);
  const guidance = `${tool.description} ${tool.promptGuidelines.join(" ")}`;
  for (const required of [
    /temporary/i,
    /memory-only/,
    /no file writes/,
    /focus/,
    /foreground-only/,
    /already-open/,
    /inclusive/,
    /LF/,
    /trailing newline/,
    /replaces/,
    /empty array clears/,
    /not annotate every/,
    /200 lines/,
  ])
    assert.match(guidance, required);
  assert.doesNotMatch(JSON.stringify(tool), /PI_VSCODE_ANNOTATION_TOKEN|annotationOrigin|credential|origin/);
});

test("registered annotation tool captures launch/session/cwd, resolves @paths and returns final metadata only", async () => {
  let sessionReads = 0;
  const f = await fixture((request) => {
    if (request.method === "annotationOrigin") {
      f.ctx.cwd = path.resolve("replacement-workspace");
      f.ctx.sessionManager.getSessionId = () => "replacement-session";
      return { ok: true, result: { origin } };
    }
    return { ok: true, result: { count: 1, visible: false, origin, credential, message: "host-secret" } };
  });
  const cwd = f.ctx.cwd;
  f.ctx.sessionManager.getSessionId = () => {
    sessionReads++;
    return "session-one";
  };
  process.env.PI_VSCODE_ANNOTATION_TOKEN = "changed-after-initialization";
  try {
    const result = await f.execute();
    assert.equal(sessionReads, 1);
    assert.deepEqual(
      f.requests.map(({ method, params }) => ({ method, params })),
      [
        { method: "annotationOrigin", params: { credential, sessionId: "session-one", cwd } },
        { method: "annotate", params: { origin, path: path.resolve(cwd, "src/example.ts"), annotations } },
      ],
    );
    assert.deepEqual(JSON.parse(result.content[0].text), { count: 1, visible: false });
    assert.deepEqual(result.details, { truncated: false });
    assert.doesNotMatch(JSON.stringify(result), /private-launch|host-secret|Passage note|line two/);
  } finally {
    await f.dispose();
  }
});

test("registered annotation tool resolves ordinary relative and absolute paths and passes empty clearing", async () => {
  const f = await fixture((request) => ({
    ok: true,
    result: request.method === "annotationOrigin" ? { origin } : { count: 0, visible: true },
  }));
  try {
    for (const target of ["docs/note.md", path.resolve("absolute-note.md")]) {
      assert.deepEqual(JSON.parse((await f.execute(target, [])).content[0].text), { count: 0, visible: true });
      assert.deepEqual(f.requests.at(-1)?.params, { origin, path: path.resolve(f.ctx.cwd, target), annotations: [] });
    }
    assert.deepEqual(
      f.requests.map((item) => item.method),
      ["annotationOrigin", "annotate", "annotationOrigin", "annotate"],
    );
  } finally {
    await f.dispose();
  }
});

test("annotation tool fails clearly without its launch credential even if terminal metadata and window auth exist", async () => {
  const f = await fixture(() => assert.fail("Terminal must not request a scope"), null);
  try {
    process.env.PI_VSCODE_ANNOTATION_TOKEN = credential;
    await assert.rejects(f.execute(), /foreground sidebar session; terminal calls are unavailable/);
    assert.equal(f.requests.length, 0, "A later environment change cannot grant a launch credential");
  } finally {
    await f.dispose();
  }
});

test("annotation tool cancels before transport and during scope acquisition without submitting annotations", async () => {
  const controller = new AbortController();
  const f = await fixture(() => {
    controller.abort();
    return { ok: true, result: { origin } };
  });
  try {
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(f.execute(undefined, undefined, aborted.signal), /cancelled/);
    assert.equal(f.requests.length, 0);
    await assert.rejects(f.execute(undefined, undefined, controller.signal), /cancelled/);
    assert.deepEqual(
      f.requests.map((item) => item.method),
      ["annotationOrigin"],
    );
  } finally {
    await f.dispose();
  }
});

test("annotation tool cancels a pending annotate transport without retry", async () => {
  const controller = new AbortController();
  const f = await fixture((request) => {
    if (request.method === "annotationOrigin") return { ok: true, result: { origin } };
    controller.abort();
    return undefined;
  });
  try {
    await assert.rejects(f.execute(undefined, undefined, controller.signal), /cancelled/);
    assert.deepEqual(
      f.requests.map((item) => item.method),
      ["annotationOrigin", "annotate"],
    );
  } finally {
    await f.dispose();
  }
});

test("malformed annotation origins fail closed and do not expose private fields or retry", async () => {
  for (const malformed of [
    null,
    {},
    { origin: "" },
    { origin: 7 },
    { origin: credential },
    { origin: "a".repeat(65) },
  ]) {
    const f = await fixture(() => ({ ok: true, result: { ...((malformed ?? {}) as object), credential } }));
    try {
      await assert.rejects(f.execute(), assertPrivateError);
      assert.deepEqual(
        f.requests.map((item) => item.method),
        ["annotationOrigin"],
      );
    } finally {
      await f.dispose();
    }
  }
});

test("annotation scope and apply errors are sanitized and never retried", async () => {
  for (const failingMethod of ["annotationOrigin", "annotate"]) {
    const f = await fixture((request) =>
      request.method === failingMethod
        ? { ok: false, error: `host-secret ${credential} ${origin}` }
        : { ok: true, result: { origin } },
    );
    try {
      await assert.rejects(f.execute(), assertPrivateError);
      assert.equal(f.requests.length, failingMethod === "annotationOrigin" ? 1 : 2);
    } finally {
      await f.dispose();
    }
  }
});

test("annotation tool accepts inclusive 200-line ranges and rejects larger or reversed ranges before transport", async () => {
  const f = await fixture((request) => ({
    ok: true,
    result: request.method === "annotationOrigin" ? { origin } : { count: 1, visible: true },
  }));
  try {
    for (const [startLine, endLine] of [
      [2, 202],
      [3, 2],
    ]) {
      await assert.rejects(f.execute("source.ts", [{ ...annotations[0], startLine, endLine }]), /1 to 200 whole lines/);
    }
    assert.equal(f.requests.length, 0);
    await f.execute("source.ts", [{ ...annotations[0], startLine: 2, endLine: 201 }]);
    assert.equal(f.requests.length, 2);
  } finally {
    await f.dispose();
  }
});

test("malformed annotation result metadata cannot expose host response text", async () => {
  for (const result of [
    null,
    { count: 21, visible: true },
    { count: 1.5, visible: true },
    { count: 1, visible: credential },
  ]) {
    const f = await fixture((request) => ({
      ok: true,
      result: request.method === "annotationOrigin" ? { origin } : result,
    }));
    try {
      await assert.rejects(f.execute(), assertPrivateError);
      assert.equal(f.requests.length, 2);
    } finally {
      await f.dispose();
    }
  }
});
