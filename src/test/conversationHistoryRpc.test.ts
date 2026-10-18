import assert from "node:assert/strict";
import { PiRpcClient, StrictJsonLineDecoder } from "../piRpcClient";

test("public get_messages transports a complete >100-message response without pagination", async () => {
  const source = `
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        if (!['get_state','get_messages'].includes(request.type)) throw new Error('Unexpected request: ' + request.type);
        const messages = Array.from({length: 205}, (_, index) => ({role:'user',content:'message '+index,timestamp:index}));
        process.stdout.write(JSON.stringify({type:'response',command:request.type,id:request.id,success:true,data:request.type==='get_messages'?{messages}:{}})+'\\n');
      }
    });`;
  const client = new PiRpcClient({
    executablePath: process.execPath,
    executableArgs: ["-e", source, "--"],
    cwd: process.cwd(),
  });
  try {
    await client.start();
    const messages = (await client.getMessages()) as Array<{ content: string }>;
    assert.equal(messages.length, 205);
    assert.equal(messages[0]?.content, "message 0");
    assert.equal(messages[204]?.content, "message 204");
  } finally {
    await client.stop();
  }
});

test("history responses retain the unchanged 5 MiB RPC line boundary", () => {
  const limit = 5 * 1024 * 1024;
  let accepted = 0;
  const decoder = new StrictJsonLineDecoder(() => {
    accepted += 1;
  });
  decoder.push(Buffer.from(`${"x".repeat(limit)}\n`));
  assert.equal(accepted, 1);
  assert.throws(() => new StrictJsonLineDecoder(() => {}).push(Buffer.from(`${"x".repeat(limit + 1)}\n`)), /5 MiB/);
  assert.throws(() => new StrictJsonLineDecoder(() => {}).push(Buffer.from("x".repeat(limit + 1))), /5 MiB/);
});
