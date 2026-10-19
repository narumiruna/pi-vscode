import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";

type Context = { cwd: string; sessionManager: { getSessionId(): string } };
type Request = { id: string; token: string; method: string; params: Record<string, unknown> };
type Emission = { channel: string; data: unknown };

class Socket extends EventEmitter {
  public destroyed = false;
  public writes: Request[] = [];
  public error?: Error;

  public write(value: string): void {
    this.writes.push(JSON.parse(value) as Request);
  }

  public destroy(error?: Error): void {
    // Deliberately defer all events. Tests deliver queued callbacks after API invalidation.
    this.destroyed = true;
    this.error = error;
  }

  public record(value: unknown): void {
    this.emit("data", Buffer.from(`${JSON.stringify(value)}\n`));
  }

  public authenticate(): void {
    this.emit("connect");
    this.record({ id: this.writes[0].id, ok: true, result: {} });
  }
}

// Execute the packaged source, replacing only its external SDK/schema and TCP dependencies.
// Real AbortController, promises, framing, timers, registration and cleanup remain in use.
async function fixture() {
  vi.useFakeTimers();
  vi.stubEnv("PI_VSCODE_BRIDGE_PORT", "12345");
  vi.stubEnv("PI_VSCODE_BRIDGE_TOKEN", "disposable-window-token");
  const source = stripTypeScriptTypes(readFileSync(path.resolve(__dirname, "../../resources/pi-bridge.ts"), "utf8"))
    .replace('import net from "node:net";', "let net; export function setNetwork(value) { net = value; }")
    .replace('import { StringEnum } from "@earendil-works/pi-ai";', "const StringEnum = () => ({});")
    .replace(
      'import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";',
      "const DEFAULT_MAX_BYTES = 50000, DEFAULT_MAX_LINES = 2000, formatSize = String, truncateHead = () => ({});",
    )
    .replace('import { Type } from "typebox";', "const Type = new Proxy({}, { get: () => () => ({}) });");
  const { default: initialize, setNetwork } = await import(
    `data:text/javascript,${encodeURIComponent(source)}#${randomUUID()}`
  );
  const sockets: Socket[] = [];
  setNetwork({
    createConnection(options: { host: string; port: number }) {
      assert.deepEqual(options, { host: "127.0.0.1", port: 12345 });
      const socket = new Socket();
      sockets.push(socket);
      return socket;
    },
  });
  const handlers = new Map<string, (event: unknown, ctx: Context) => void>();
  const listeners = new Map<string, (value: unknown) => void>();
  const emissions: Emission[] = [];
  const staleEmissions: Emission[] = [];
  let active = true;
  let onEmission: ((channel: string) => void) | undefined;
  initialize({
    registerCommand: () => {},
    registerTool: () => {},
    on: (name: string, handler: (event: unknown, ctx: Context) => void) => handlers.set(name, handler),
    events: {
      on: (name: string, handler: (value: unknown) => void) => listeners.set(name, handler),
      emit(channel: string, data: unknown) {
        // Record rather than throw: regressions fail assertions, not the test worker's event loop.
        (active ? emissions : staleEmissions).push({ channel, data });
        onEmission?.(channel);
      },
    },
  });
  const ctx = (sessionId: string): Context => ({ cwd: "/fixture", sessionManager: { getSessionId: () => sessionId } });
  return {
    sockets,
    emissions,
    staleEmissions,
    start(sessionId = "first") {
      const handler = handlers.get("session_start");
      assert.ok(handler);
      handler({}, ctx(sessionId));
      const socket = sockets.at(-1);
      assert.ok(socket);
      return socket;
    },
    shutdown() {
      const handler = handlers.get("session_shutdown");
      assert.ok(handler);
      handler({}, ctx("unused"));
    },
    invalidate() {
      active = false;
    },
    onEmission(handler: (channel: string) => void) {
      onEmission = handler;
    },
    request(value: unknown = { id: "correlated", method: "context", params: {} }) {
      const listener = listeners.get("vscode:request");
      assert.ok(listener);
      listener(value);
      const socket = sockets.at(-1);
      assert.ok(socket);
      return socket;
    },
  };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

test.each([false, true])("shutdown suppresses queued socket callbacks (authenticated: %s)", async (authenticated) => {
  const f = await fixture();
  const socket = f.start();
  if (authenticated) socket.authenticate();
  const before = [...f.emissions];
  const writes = socket.writes.length;
  f.shutdown();
  f.shutdown();
  f.invalidate();
  assert.equal(socket.destroyed, true);
  socket.emit("connect");
  socket.record({ id: socket.writes[0]?.id, ok: true });
  socket.record({ type: "event", event: "obsolete", data: {} });
  socket.emit("error", new Error("queued failure"));
  socket.emit("close");
  assert.equal(socket.writes.length, writes, "disposed sockets must not authenticate again");
  assert.deepEqual(f.emissions, before);
  assert.deepEqual(f.staleEmissions, []);
});

test("replacement suppresses old callbacks and subscribes with fresh session metadata", async () => {
  const f = await fixture();
  for (let index = 0; index < 3; index++) {
    const previous = f.sockets.at(-1);
    const socket = f.start(`session-${index}`);
    const before = [...f.emissions];
    if (previous) {
      assert.equal(previous.destroyed, true);
      previous.record({ type: "event", event: "obsolete" });
      previous.emit("close");
      assert.deepEqual(f.emissions, before);
    }
    socket.authenticate();
    assert.deepEqual(socket.writes[0], {
      id: socket.writes[0].id,
      token: "disposable-window-token",
      method: "subscribe",
      params: { cwd: "/fixture", sessionId: `session-${index}` },
    });
    assert.deepEqual(f.emissions.at(-1), {
      channel: "vscode:connected",
      data: { cwd: "/fixture", sessionId: `session-${index}` },
    });
  }
  f.shutdown();
  assert.ok(f.sockets.every((socket) => socket.destroyed));
});

test("active subscriptions forward split UTF-8 events and disconnect once on close", async () => {
  const f = await fixture();
  const socket = f.start();
  socket.authenticate();
  const bytes = Buffer.from(`${JSON.stringify({ type: "event", event: "editor.changed", data: "λ" })}\r\n`);
  const split = bytes.indexOf(Buffer.from("λ")) + 1;
  socket.emit("data", bytes.subarray(0, split));
  socket.emit("data", bytes.subarray(split));
  assert.deepEqual(f.emissions.at(-1), { channel: "vscode:event", data: { event: "editor.changed", data: "λ" } });
  socket.emit("close");
  socket.emit("error", new Error("late error after close"));
  assert.deepEqual(
    f.emissions.filter((event) => event.channel === "vscode:disconnected"),
    [{ channel: "vscode:disconnected", data: {} }],
  );
  f.shutdown();
});

test.each([false, true])("active connection errors disconnect once (authenticated: %s)", async (authenticated) => {
  const f = await fixture();
  const socket = f.start();
  if (authenticated) socket.authenticate();
  socket.emit("error", new Error("connection failed"));
  socket.emit("close");
  socket.record({ type: "event", event: "obsolete" });
  assert.deepEqual(
    f.emissions.filter((event) => event.channel === "vscode:disconnected"),
    [{ channel: "vscode:disconnected", data: { error: "connection failed" } }],
  );
  assert.equal(
    f.emissions.some((event) => event.channel === "vscode:event"),
    false,
  );
  f.shutdown();
});

test("shutdown during an event stops the rest of an already received batch", async () => {
  const f = await fixture();
  const socket = f.start();
  socket.authenticate();
  f.onEmission((channel) => {
    if (channel === "vscode:event") {
      f.shutdown();
      f.invalidate();
    }
  });
  socket.emit("data", Buffer.from('{"type":"event","event":"first"}\n{"type":"event","event":"obsolete"}\n'));
  assert.equal(f.emissions.filter((event) => event.channel === "vscode:event").length, 1);
  assert.deepEqual(f.staleEmissions, []);
});

test.each(["invalid JSON", "non-object", "rejected subscription", "oversized"])(
  "%s stops the subscription without forwarding trailing events",
  async (failure) => {
    const f = await fixture();
    const socket = f.start();
    socket.emit("connect");
    const invalid =
      failure === "invalid JSON"
        ? "{invalid}\n"
        : failure === "non-object"
          ? "null\n"
          : failure === "oversized"
            ? "x".repeat(1024 * 1024 + 1)
            : '{"id":"wrong","ok":true}\n';
    socket.emit("data", Buffer.from(`${invalid}{"type":"event","event":"obsolete"}\n`));
    assert.equal(socket.destroyed, true);
    assert.ok(socket.error);
    socket.emit("error", socket.error);
    socket.emit("close");
    assert.equal(f.emissions.length, 1);
    assert.equal(f.emissions[0].channel, "vscode:disconnected");
    f.shutdown();
  },
);

test.each([true, false])("active event-bus requests keep correlated responses (success: %s)", async (ok) => {
  const f = await fixture();
  f.start();
  const socket = f.request();
  socket.emit("connect");
  assert.equal(socket.writes[0].token, "disposable-window-token");
  assert.equal(socket.writes[0].method, "context");
  const reply = ok ? { ok: true, result: { selection: "fixture" } } : { ok: false, error: "fixture rejected" };
  socket.record({ id: socket.writes[0].id, ...reply });
  await vi.advanceTimersByTimeAsync(0);
  assert.deepEqual(f.emissions, [{ channel: "vscode:response", data: { id: "correlated", ...reply } }]);
  assert.equal(socket.destroyed, true);
  assert.equal(vi.getTimerCount(), 0);
  f.shutdown();
});

test.each(["pending", "success", "failure"])(
  "shutdown cancels requests and suppresses queued %s responses across generations",
  async (outcome) => {
    const f = await fixture();
    f.start();
    const request = f.request();
    request.emit("connect");
    const response = { id: request.writes[0].id, ok: outcome !== "failure", result: {}, error: "fixture rejected" };
    if (outcome !== "pending") request.record(response);
    f.shutdown();
    f.invalidate();
    assert.equal(request.destroyed, true, "shutdown must release the request socket without waiting for its timeout");
    assert.equal(vi.getTimerCount(), 0, "shutdown must release pending request timers");
    request.record(response);
    request.emit("error", new Error("late transport failure"));
    request.emit("end");
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(f.emissions, []);
    assert.deepEqual(f.staleEmissions, []);
  },
);

test("a new session does not reactivate continuations from an older session", async () => {
  const f = await fixture();
  f.start();
  const request = f.request();
  request.emit("connect");
  request.record({ id: request.writes[0].id, ok: true, result: "obsolete" });
  f.start("second");
  await vi.advanceTimersByTimeAsync(0);
  assert.deepEqual(f.emissions, []);
  const fresh = f.request({ id: "fresh", method: "context", params: {} });
  fresh.emit("connect");
  fresh.record({ id: fresh.writes[0].id, ok: true, result: "current" });
  await vi.advanceTimersByTimeAsync(0);
  assert.deepEqual(f.emissions, [{ channel: "vscode:response", data: { id: "fresh", ok: true, result: "current" } }]);
  f.shutdown();
  assert.equal(vi.getTimerCount(), 0);
});

test("requests after shutdown and malformed event-bus messages create no new sockets", async () => {
  const f = await fixture();
  f.start();
  f.request(null);
  f.request({ method: 123 });
  assert.equal(f.sockets.length, 1);
  f.shutdown();
  f.invalidate();
  f.request();
  await Promise.resolve();
  assert.equal(f.sockets.length, 1);
  assert.deepEqual(f.staleEmissions, []);
});
