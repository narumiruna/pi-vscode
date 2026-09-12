import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseRpcQueue, PiRpcClient, StrictJsonLineDecoder, type PiRpcEvent } from "../piRpcClient";

test("RPC queue fixtures preserve duplicates, ack before delivery, clear-before-abort and unsupported/ambiguous responses", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-queue-"));
  const script = path.join(directory, "queue.cjs");
  await writeFile(script, `
let buffer = '', steering = [], followUp = [];
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
 buffer += chunk;
 while (buffer.includes('\\n')) {
  const end = buffer.indexOf('\\n'), request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
  emit({type:'command_seen', command:request.type});
  if(request.message === 'crash') process.exit(7);
  if(request.message === 'timeout') continue;
  if(request.message === 'unsupported') { emit({type:'response', id:request.id, command:request.type, success:false, error:'Unknown command'}); continue; }
  let data = {};
  if(request.type === 'steer') steering.push(request.message);
  if(request.type === 'follow_up') followUp.push(request.message);
  if(request.type === 'clear_queue') { data = {steering, followUp}; steering = []; followUp = []; }
  if(['steer','follow_up','clear_queue'].includes(request.type)) emit({type:'queue_update', steering, followUp});
  emit({type:'response', id:request.id, command:request.type, success:true, data});
  if(request.type === 'abort') {
    emit({type:'delivered', messages:[...steering, ...followUp]});
    emit({type:'agent_settled'});
  }
 }
});`);
  const events: PiRpcEvent[] = [];
  const client = new PiRpcClient({ executablePath: process.execPath, executableArgs: [script], cwd: directory, requestTimeoutMs: 100 });
  client.onEvent(event => events.push(event));
  try {
    await client.start();
    await client.steer("same"); await client.steer("same"); await client.followUp("last");
    assert.equal(events.some(event => event.type === "delivered"), false);
    assert.deepEqual(await client.clearQueue(), { steering: ["same", "same"], followUp: ["last"] });
    await client.abort();
    assert.deepEqual(events.filter(event => event.type === "command_seen").map(event => event.command).slice(-2), ["clear_queue", "abort"]);
    await assert.rejects(client.steer("/skill:example"), /plain text/);
    await assert.rejects(client.steer("unsupported"), /Unknown command/);
    await assert.rejects(client.followUp("timeout"), /Timed out/);
    assert.equal(events.filter(event => event.type === "command_seen" && event.command === "follow_up").length, 2);
    await assert.rejects(client.steer("crash"), /exited/);
  } finally { await client.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("queue state rejects malformed and oversized payloads without normalizing duplicate text", () => {
  assert.deepEqual(parseRpcQueue({ steering: ["x", "x"], followUp: [] }).steering, ["x", "x"]);
  for (const value of [{}, { steering: [null], followUp: [] }, { steering: Array(11).fill("x"), followUp: [] }, { steering: [], followUp: ["x".repeat(50001)] }]) assert.throws(() => parseRpcQueue(value));
});

test("RPC framing bounds complete, partial and EOF lines before dispatch", () => {
  const oversized = "x".repeat(5 * 1024 * 1024 + 1);
  for (const input of [oversized, oversized + "\n"]) {
    const decoder = new StrictJsonLineDecoder(() => assert.fail("oversized input dispatched"));
    assert.throws(() => decoder.push(Buffer.from(input)), /larger than 5 MiB/);
  }
  const eof = new StrictJsonLineDecoder(() => assert.fail("oversized EOF dispatched"));
  (eof as any).buffer = oversized;
  assert.throws(() => eof.end(), /larger than 5 MiB/);
});

test("forced RPC shutdown emits settlement-breaking process exit once even when SIGTERM is ignored", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-rpc-forced-stop-"));
  const script = path.join(directory, "fixture.cjs");
  await writeFile(script, `process.on('SIGTERM',()=>{});require('readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);process.stdout.write(JSON.stringify({type:'response',id:r.id,command:r.type,success:true,data:{}})+'\\n');});`);
  const client = new PiRpcClient({ executablePath: process.execPath, executableArgs: [script], cwd: directory });
  const events: PiRpcEvent[] = []; client.onEvent(event => events.push(event));
  try {
    await client.start(); await Promise.all([client.stop(), client.stop()]);
    assert.equal(client.isRunning, false);
    assert.equal(events.filter(event => event.type === "process_exit").length, 1);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(events.filter(event => event.type === "process_exit").length, 1);
  } finally { await client.stop(); await rm(directory, { recursive: true, force: true }); }
});
