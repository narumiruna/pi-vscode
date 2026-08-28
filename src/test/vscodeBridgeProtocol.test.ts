import assert from "node:assert/strict";
import test from "node:test";
import {
  parseVscodeBridgeRequest,
  VscodeBridgeLineDecoder,
} from "../vscodeBridgeProtocol";

test("VscodeBridgeLineDecoder uses strict LF framing across UTF-8 chunks", () => {
  const lines: string[] = [];
  const decoder = new VscodeBridgeLineDecoder(line => lines.push(line));
  const unicodeSeparator = String.fromCharCode(0x2028);
  const firstLine = `{"text":"編輯器${unicodeSeparator}context"}`;
  const payload = Buffer.from(`${firstLine}\r\n{"next":true}\n`, "utf8");

  decoder.push(payload.subarray(0, 13));
  decoder.push(payload.subarray(13));
  decoder.end();

  assert.deepEqual(lines, [firstLine, '{"next":true}']);
});

test("parseVscodeBridgeRequest validates and normalizes requests", () => {
  assert.deepEqual(
    parseVscodeBridgeRequest(JSON.stringify({
      id: "request-1",
      token: "secret",
      method: "context",
    })),
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
