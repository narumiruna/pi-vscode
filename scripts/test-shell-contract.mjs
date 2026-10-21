import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// Explicit reference argument only. This is validation, not an extension runtime dependency.
const cli = process.argv[2];
if (!cli) throw new Error("Usage: node scripts/test-shell-contract.mjs <Pi 1.3.0 dist/cli.js>");
const metadata = JSON.parse(await readFile(path.resolve(cli, "../../package.json"), "utf8"));
assert.equal(metadata.version, "1.3.0");
const require = createRequire(import.meta.url);
const { PiRpcClient } = require("../out/piRpcClient.js");
const root = await realpath(await mkdtemp(path.join(tmpdir(), "pi-shell-public-contract-")));
const env = {
  PATH: process.env.PATH,
  HOME: root,
  PI_CODING_AGENT_DIR: path.join(root, "agent"),
  PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1",
  PI_TELEMETRY: "0",
};
await mkdir(env.PI_CODING_AGENT_DIR);
const extension = path.join(root, "contract.ts");
const readOnly = path.resolve("resources/pi-read-only-gate.ts");
const args = [
  path.resolve(cli), "--offline", "--no-mcp", "--no-extensions", "--no-skills",
  "--no-prompt-templates", "--no-context-files", "--no-session",
];
const evidence = [];
const confirmations = (events) => events.filter((event) =>
  event.type === "extension_ui_request" && event.method === "confirm");
async function run(source, action, extensions = [extension]) {
  await writeFile(extension, source);
  const client = new PiRpcClient({
    executablePath: process.execPath,
    executableArgs: args,
    cwd: root,
    env,
    unsetEnv: Object.keys(process.env).filter((key) => !(key in env)),
    extensions,
    requestTimeoutMs: 10_000,
  });
  const events = [];
  client.onEvent((event) => events.push(event));
  try {
    await client.start();
    await action(client, events);
    assert.equal(events.some((event) => event.type === "agent_start"), false, "No model requests permitted");
  } finally {
    await client.stop();
  }
}
try {
  for (const [name, handler] of [
    ["handler error", 'throw new Error("fixture denied");'],
    ["invalid tool-call block object", 'return {block:true,reason:"fixture denied"};'],
  ]) {
    await run(`export default function(pi){pi.on("user_bash",()=>{${handler}});}`, async (client, events) => {
      await assert.rejects(
        client.bash("printf CONTRACT_MUST_NOT_EXECUTE", false, () => assert.fail("Denied command streamed output")),
        /fixture denied|Invalid user_bash handler result/,
      );
      assert.equal(events.some((event) => event.type === "extension_error" && event.event === "user_bash"), true);
      assert.deepEqual(await client.getMessages(), []);
      evidence.push(`${name}: fail closed, no bash history/output`);
    });
  }
  await run(`export default function(pi){
    pi.on("user_bash",()=>({result:{output:"replacement",exitCode:23,cancelled:false,truncated:false}}));
    pi.on("user_bash",()=>{throw new Error("must not run later handler")});
  }`, async (client) => {
    const result = await client.bash("printf CONTRACT_MUST_NOT_EXECUTE", false, () => {});
    assert.equal(result.output, "replacement");
    assert.equal(result.exitCode, 23);
    evidence.push("valid result: replaces execution and stops later handlers");
  });
  const projection = `import {convertToLlm} from "@earendil-works/pi-coding-agent";
    export default function(pi){pi.registerCommand("fixture-context",{handler:async(_args,ctx)=>
      ctx.ui.notify(JSON.stringify(convertToLlm(ctx.sessionManager.getBranch()
        .filter(e=>e.type==="message").map(e=>e.message))))});}`;
  await run(projection, async (client, events) => {
    const descriptors = await client.getCommands();
    const markers = descriptors.filter((value) => value.name === "vscode-pi-read-only-ready");
    assert.equal(markers.length, 1);
    assert.equal(markers[0].description, `VS Code read-only direct-shell policy v1; Pi ${metadata.version}`);
    assert.equal(markers[0].source, "extension");
    assert.equal(await realpath(markers[0].sourceInfo.path), await realpath(readOnly));
    assert.equal((await client.bash("printf INCLUDED_FIXTURE", false, () => {})).output, "INCLUDED_FIXTURE");
    await client.prompt("/fixture-context");
    const first = String(events.filter((event) =>
      event.type === "extension_ui_request" && event.method === "notify").at(-1).message);
    assert.match(first, /INCLUDED_FIXTURE/);
    assert.equal((await client.bash("printf EXCLUDED_FIXTURE", true, () => {})).output, "EXCLUDED_FIXTURE");
    await client.prompt("/fixture-context");
    const second = String(events.filter((event) =>
      event.type === "extension_ui_request" && event.method === "notify").at(-1).message);
    assert.match(second, /INCLUDED_FIXTURE/);
    assert.doesNotMatch(second, /EXCLUDED_FIXTURE/);
    assert.equal((await client.getMessages()).filter((value) => value.role === "bashExecution").length, 2);
    assert.equal(confirmations(events).length, 0, "Packaged direct shell must not request approval");
    evidence.push("no bundled approval; two-turn context inclusion/exclusion with retained history, no model calls");
  }, [readOnly, extension]);

  // Invoke only the policy lifecycle callbacks through fixture commands. All user_bash dispatch,
  // denial, output and history handling still run in the actual Pi runtime, without a model.
  await run(`import readOnly from ${JSON.stringify(readOnly)};
    export default function(pi){
      const handlers = new Map();
      readOnly({...pi,on:(name,handler)=>{handlers.set(name,handler);return pi.on(name,handler)}});
      pi.registerCommand("fixture-read-only",{handler:async()=>{
        handlers.get("before_agent_start")({prompt:"<<<PI_VSCODE_POLICY: read-only>>>\\nfixture"});
        if(pi.getActiveTools().includes("bash")) throw new Error("Shell tool was not disabled");
      }});
      pi.registerCommand("fixture-restore",{handler:async()=>{
        handlers.get("agent_settled")();
        if(!pi.getActiveTools().includes("bash")) throw new Error("Shell tool was not restored");
      }});
    }`, async (client, events) => {
    await client.prompt("/fixture-read-only");
    await assert.rejects(
      client.bash("printf CONTRACT_MUST_NOT_EXECUTE", false, () => assert.fail("Read-only command streamed output")),
      /preview-only/,
    );
    assert.equal(events.some((event) => event.type === "extension_error" && event.event === "user_bash"), true);
    assert.deepEqual(await client.getMessages(), []);
    await client.prompt("/fixture-restore");
    assert.equal((await client.bash("printf RESTORED_FIXTURE", false, () => {})).output, "RESTORED_FIXTURE");
    assert.equal(confirmations(events).length, 0);
    assert.equal(events.some((event) => event.type === "extension_error" && event.event !== "user_bash"), false);
    evidence.push("packaged read-only policy: synthetic lifecycle activation denies real RPC shell; settlement restores it");
  });

  await run(`export default function(pi){pi.on("user_bash",async(event,ctx)=>{
    if(await ctx.ui.confirm("Fixture extension shell approval",event.command)!==true)
      throw new Error("Fixture extension denied shell");
  });}`, async (client, events) => {
    let allow = false;
    client.onEvent((event) => {
      if (event.type === "extension_ui_request" && event.method === "confirm") {
        assert.equal(event.title, "Fixture extension shell approval");
        client.sendExtensionUiResponse(event.id, { confirmed: allow });
      }
    });
    await assert.rejects(
      client.bash("printf CONTRACT_MUST_NOT_EXECUTE", false, () => assert.fail("Unapproved command streamed output")),
      /Fixture extension denied shell/,
    );
    assert.deepEqual(await client.getMessages(), []);
    allow = true;
    assert.equal((await client.bash("printf EXTENSION_APPROVED", false, () => {})).output, "EXTENSION_APPROVED");
    assert.equal(confirmations(events).length, 2);
    assert.deepEqual(confirmations(events).map((event) => event.message), [
      "printf CONTRACT_MUST_NOT_EXECUTE", "printf EXTENSION_APPROVED",
    ]);
    assert.equal((await client.getMessages()).filter((value) => value.role === "bashExecution").length, 1);
    evidence.push("Pi-extension-owned confirmation: denial blocks execution; approval continues execution");
  }, [readOnly, extension]);
  console.log("PI_SHELL_PUBLIC_CONTRACT", JSON.stringify({ version: metadata.version, evidence }));
} finally {
  await rm(root, { recursive: true, force: true });
}
