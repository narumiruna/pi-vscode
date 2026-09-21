import assert from "node:assert/strict";
import {
  maxBridgeLineBytes,
  parseVscodeBridgeRequest,
  serializeVscodeBridgeEvent,
  VscodeBridgeLineDecoder,
} from "../vscodeBridgeProtocol";

test("VscodeBridgeLineDecoder uses strict LF framing across UTF-8 chunks", () => {
  const lines: string[] = [];
  const decoder = new VscodeBridgeLineDecoder((line) => lines.push(line));
  const unicodeSeparator = String.fromCharCode(0x2028);
  const firstLine = `{"text":"編輯器${unicodeSeparator}context"}`;
  const payload = Buffer.from(`${firstLine}\r\n{"next":true}\n`, "utf8");

  decoder.push(payload.subarray(0, 13));
  decoder.push(payload.subarray(13));
  decoder.end();

  assert.deepEqual(lines, [firstLine, '{"next":true}']);
});

test("VscodeBridgeLineDecoder fails closed for oversized partial, framed, and EOF input", () => {
  const partialLines: string[] = [];
  const partial = new VscodeBridgeLineDecoder((line) => partialLines.push(line));
  assert.throws(() => partial.push(Buffer.alloc(maxBridgeLineBytes + 1, "a")), /exceeded 1 MiB/);
  assert.throws(() => partial.end(), /no longer usable/);
  assert.deepEqual(partialLines, []);

  const framedLines: string[] = [];
  const framed = new VscodeBridgeLineDecoder((line) => framedLines.push(line));
  assert.throws(() => framed.push(Buffer.from(`${"a".repeat(maxBridgeLineBytes + 1)}\n`)), /exceeded 1 MiB/);
  assert.deepEqual(framedLines, []);

  const eofLines: string[] = [];
  const eof = new VscodeBridgeLineDecoder((line) => eofLines.push(line));
  eof.push(Buffer.concat([Buffer.alloc(maxBridgeLineBytes, "a"), Buffer.from([0xe2])]));
  assert.throws(() => eof.end(), /exceeded 1 MiB/);
  assert.deepEqual(eofLines, []);
});

test("serializeVscodeBridgeEvent validates names, JSON data, and size", () => {
  assert.equal(
    serializeVscodeBridgeEvent("editor.changed", { path: "/tmp/example.ts" }),
    '{"type":"event","event":"editor.changed","data":{"path":"/tmp/example.ts"}}\n',
  );
  assert.throws(() => serializeVscodeBridgeEvent("", {}), /invalid name/);
  assert.throws(() => serializeVscodeBridgeEvent("invalid event", {}), /invalid name/);
  assert.throws(() => serializeVscodeBridgeEvent("event", 1n), /JSON-serializable/);
  assert.throws(() => serializeVscodeBridgeEvent("event", "a".repeat(maxBridgeLineBytes)), /exceeded 1 MiB/);
});

test("parseVscodeBridgeRequest validates and normalizes requests", () => {
  assert.deepEqual(
    parseVscodeBridgeRequest(
      JSON.stringify({
        id: "request-1",
        token: "secret",
        method: "context",
      }),
    ),
    {
      id: "request-1",
      token: "secret",
      method: "context",
      params: {},
    },
  );
  assert.throws(
    () => parseVscodeBridgeRequest('{"id":"request-1","token":"secret","method":"context","params":[]}'),
    /params must be an object/,
  );
  assert.throws(() => parseVscodeBridgeRequest("not json"), /not valid JSON/);
});
