import assert from "node:assert/strict";
import { installVscodeMock } from "./vscodeMock";

const vscode = installVscodeMock();
const restored: (() => void)[] = [];
function replace(module: string, name: string, value: unknown): void {
  const exports = require(module);
  const original = exports[name];
  exports[name] = value;
  restored.push(() => {
    exports[name] = original;
  });
}

let failMigration = false;
let failBridge = false;
let createdRuntime = 0;
let migrationChannelCounts: number[] = [];
replace("../legacyBridge", "removeLegacyGlobalBridgeExtensions", async () => {
  migrationChannelCounts.push(vscode.outputChannels.length);
  if (failMigration) throw Object.assign(new Error("PRIVATE_ACTIVATION_SENTINEL"), { code: "EACCES" });
});
replace(
  "../piRuntime",
  "PiRuntimeManager",
  class {
    constructor(
      _context: unknown,
      public logger: unknown,
    ) {
      createdRuntime++;
    }
    async initializeControlOwnership() {}
    async initializeBridge() {
      if (failBridge) throw new Error("PRIVATE_ACTIVATION_SENTINEL");
    }
    clearAnnotations() {}
    broadcastToPi() {
      return 0;
    }
    dispose() {}
  },
);
for (const [module, method] of [
  ["../chat", "registerPiChat"],
  ["../debugContextController", "registerDebugContext"],
  ["../editorActions", "registerEditorActions"],
  ["../extensionUiDialogs", "registerExtensionUiDialogs"],
  ["../gitReviewController", "registerGitReview"],
  ["../nativePiController", "registerNativePiManagement"],
  ["../piCompatibility", "registerPiCompatibility"],
  ["../providerAuth", "registerProviderAuthentication"],
  ["../settingsPanel", "registerSettingsPanel"],
  ["../sidebar", "registerPiSidebar"],
  ["../testRepairController", "registerTestRepair"],
  ["../workspaceDiagnosticsController", "registerWorkspaceDiagnostics"],
])
  replace(module!, method!, () => undefined);
const { activate } = require("../extension") as typeof import("../extension");
afterAll(() => {
  for (const restore of restored.reverse()) restore();
  vscode.restore();
});

function context(): any {
  return {
    extensionUri: vscode.Uri.file(process.cwd()),
    subscriptions: [],
    extension: { packageJSON: { version: "0.12.0" } },
  };
}

beforeEach(() => {
  failMigration = false;
  failBridge = false;
  createdRuntime = 0;
  migrationChannelCounts = [];
  vscode.outputChannels.length = 0;
});

test("activation owns exactly one Pi log channel before migration and inline completion reuses it", async () => {
  const ctx = context();
  const api = await activate(ctx);
  assert.deepEqual(migrationChannelCounts, [1]);
  assert.equal(createdRuntime, 1);
  assert.equal(vscode.outputChannels.length, 1);
  const channel = vscode.outputChannels[0];
  assert.equal(channel.name, "Pi");
  assert.deepEqual(channel.options, { log: true });
  assert.equal(api.broadcast("test", {}), 0);
  assert.deepEqual(channel.shown, []);
  assert.match(channel.records[0].message, /"extensionVersion":"0.12.0"/);
  assert.match(channel.records.at(-1).message, /"result":"ready"/);
  for (const subscription of ctx.subscriptions) subscription.dispose();
  assert.equal(channel.disposeCalls, 1);
});

test.each(["migration", "bridge"])(
  "activation failure logs safe %s stage without masking the original failure",
  async (stage) => {
    failMigration = stage === "migration";
    failBridge = stage === "bridge";
    const ctx = context();
    await assert.rejects(activate(ctx), /PRIVATE_ACTIVATION_SENTINEL/);
    const channel = vscode.outputChannels[0];
    const failure = channel.records.at(-1);
    assert.equal(failure.level, "error");
    assert.match(failure.message, new RegExp(`"stage":"${stage}"`));
    assert.match(failure.message, /"result":"failed"/);
    assert.ok(!JSON.stringify(channel.records).includes("PRIVATE_ACTIVATION_SENTINEL"));
    assert.deepEqual(channel.shown, []);
    if (stage === "migration") assert.equal(createdRuntime, 0);
    for (const subscription of ctx.subscriptions) subscription.dispose();
  },
);

test("channel creation failure does not prevent activation", async () => {
  const create = vscode.window.createOutputChannel;
  vscode.window.createOutputChannel = () => {
    throw new Error("channel unavailable");
  };
  const ctx = context();
  try {
    await activate(ctx);
    assert.equal(createdRuntime, 1);
    assert.deepEqual(migrationChannelCounts, [0]);
  } finally {
    vscode.window.createOutputChannel = create;
    for (const subscription of ctx.subscriptions) subscription.dispose();
  }
});
