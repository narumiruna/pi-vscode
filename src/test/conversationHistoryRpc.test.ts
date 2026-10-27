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

test("get_messages restores the reported-size image-bearing history and keeps RPC usable", async () => {
  const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrXcAAAAASUVORK5CYII=";
  const source = `
    const messages = Array.from({length:856}, (_, index) => ({
      role:'user',content:[{type:'text',text:'message '+index}],timestamp:index
    }));
    messages[0].content.push({type:'image',mimeType:'image/png',data:${JSON.stringify(image)}});
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const request = JSON.parse(line);
      if (!['get_state','get_messages'].includes(request.type)) throw new Error('Unexpected request');
      const response = {type:'response',id:request.id,command:request.type,success:true,data:{}};
      if (request.type === 'get_messages') {
        messages[855].content[0].text = 'last message';
        response.data.messages = messages;
        messages[855].content[0].text += 'x'.repeat(5297452 - Buffer.byteLength(JSON.stringify(response)));
      }
      process.stdout.write(JSON.stringify(response)+'\\n');
    });`;
  const client = new PiRpcClient({
    executablePath: process.execPath,
    executableArgs: ["-e", source, "--"],
    cwd: process.cwd(),
  });
  const events: unknown[] = [];
  client.onEvent((event) => events.push(event));
  try {
    await client.start();
    const pid = client.processId;
    for (let refresh = 0; refresh < 2; refresh++) {
      const messages = (await client.getMessages()) as Array<{ content: Array<{ text?: string; data?: string }> }>;
      assert.equal(messages.length, 856);
      assert.equal(messages[0]?.content[0]?.text, "message 0");
      assert.equal(messages[0]?.content[1]?.data, image);
      assert.ok(messages[855]?.content[0]?.text?.startsWith("last message"));
      assert.deepEqual(await client.getState(), {});
      assert.equal(client.processId, pid);
      assert.equal(client.isRunning, true);
    }
    assert.deepEqual(events, []);
  } finally {
    await client.stop();
  }
});

test("history responses enforce a finite 64 MiB RPC line boundary", () => {
  const limit = 64 * 1024 * 1024;
  let accepted = 0;
  const decoder = new StrictJsonLineDecoder(() => {
    accepted += 1;
  });
  decoder.push(Buffer.from(`${"x".repeat(limit)}\n`));
  assert.equal(accepted, 1);
  assert.throws(() => new StrictJsonLineDecoder(() => {}).push(Buffer.from(`${"x".repeat(limit + 1)}\n`)), /64 MiB/);
  assert.throws(() => new StrictJsonLineDecoder(() => {}).push(Buffer.from("x".repeat(limit + 1))), /64 MiB/);
});

test("an oversized decoder releases retained input and ignores all later chunks and EOF", () => {
  const decoder = new StrictJsonLineDecoder(() => assert.fail("failed decoder dispatched a line"));
  assert.throws(() => decoder.push(Buffer.alloc(64 * 1024 * 1024 + 1, "x")), /JSON line larger than/);
  assert.doesNotThrow(() => {
    decoder.push(Buffer.from('{"ignored":true}\n'));
    decoder.end();
  });
  const retained = decoder as unknown as { buffer: string; bufferedBytes: number; newlineIndex: number };
  assert.equal(retained.buffer, "");
  assert.equal(retained.bufferedBytes, 0);
  assert.equal(retained.newlineIndex, -1);
});
