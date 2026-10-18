import assert from "node:assert/strict";
import { StrictJsonLineDecoder } from "../piRpcClient";
import { maxBridgeLineBytes, VscodeBridgeLineDecoder } from "../vscodeBridgeProtocol";

for (const { name, Decoder, limit } of [
  { name: "RPC", Decoder: StrictJsonLineDecoder, limit: 5 * 1024 * 1024 },
  { name: "bridge", Decoder: VscodeBridgeLineDecoder, limit: maxBridgeLineBytes },
]) {
  test(`${name} framing preserves split Unicode, CRLF, empty lines, and incomplete UTF-8 at EOF`, () => {
    const lines: string[] = [];
    const decoder = new Decoder((line) => lines.push(line));
    const text = '一个😀\u2028\u2029\r\n\n{"value":2}\nlast\r';
    const bytes = Buffer.concat([Buffer.from(text), Buffer.from([0xe2, 0x82])]);
    for (const byte of bytes) decoder.push(Buffer.from([byte]));
    decoder.end();
    assert.deepEqual(lines, ["一个😀\u2028\u2029", "", '{"value":2}', "last\r�"]);
  });

  test(`${name} framing counts decoded UTF-8 and CR bytes at the exact line limit`, () => {
    const line = "€".repeat(Math.floor(limit / 3)) + "x".repeat(limit % 3);
    const lines: string[] = [];
    const decoder = new Decoder((value) => lines.push(value));
    const bytes = Buffer.from(line);
    for (let offset = 0; offset < bytes.length; offset += 16_383) decoder.push(bytes.subarray(offset, offset + 16_383));
    decoder.push(Buffer.from("\n"));
    decoder.end();
    assert.deepEqual(lines, [line]);

    for (const suffix of ["\r\n", "\r"]) {
      const oversized = new Decoder(() => assert.fail("oversized line dispatched"));
      oversized.push(bytes);
      assert.throws(() => oversized.push(Buffer.from(suffix)), /exceeded 1 MiB|larger than 5 MiB/);
    }
    const incomplete = new Decoder(() => assert.fail("oversized EOF dispatched"));
    incomplete.push(Buffer.from("x".repeat(limit - 1)));
    incomplete.push(Buffer.from([0xe2]));
    assert.throws(() => incomplete.end(), /exceeded 1 MiB|larger than 5 MiB/);
  });

  test(`${name} framing permits a chunk larger than the limit when each line fits`, () => {
    const line = "x".repeat(limit);
    let delivered = 0;
    const decoder = new Decoder((value) => {
      assert.equal(value, line);
      delivered += 1;
    });
    decoder.push(Buffer.from(`${line}\n${line}\n`));
    decoder.end();
    assert.equal(delivered, 2);
  });

  test(`${name} framing preserves pending-line order during a reentrant push`, () => {
    const lines: string[] = [];
    const decoder = new Decoder((line) => {
      lines.push(line);
      if (line === "one") decoder.push(Buffer.from("three\nfour"));
    });
    decoder.push(Buffer.from("one\ntwo\n"));
    decoder.end();
    assert.deepEqual(lines, ["one", "two", "three", "four"]);
  });

  test(`${name} framing retains later lines when the callback throws`, () => {
    const lines: string[] = [];
    const decoder = new Decoder((line) => {
      lines.push(line);
      if (line === "one") throw new Error("callback failed");
    });
    assert.throws(() => decoder.push(Buffer.from("one\ntwo\n")), /callback failed/);
    decoder.push(Buffer.from("three\n"));
    decoder.end();
    assert.deepEqual(lines, ["one", "two", "three"]);
  });

  test(`${name} framing counts an EOF replacement before reentrant input reaches the limit`, () => {
    let delivered = 0;
    const decoder = new Decoder(() => {
      delivered += 1;
      if (delivered !== 1) return;
      decoder.push(Buffer.from(`\n${"x".repeat(limit - 1)}`));
      decoder.push(Buffer.from("xx"));
    });
    decoder.push(Buffer.from([0xe2]));
    assert.throws(() => decoder.end(), /exceeded 1 MiB|larger than 5 MiB/);
    assert.equal(delivered, 2);
  });

  test(`${name} framing measures fragmented input bytes only a constant number of times`, () => {
    const chunk = Buffer.from("€".repeat(256));
    const count = 256;
    const expected = chunk.toString().repeat(count);
    const lines: string[] = [];
    const decoder = new Decoder((line) => lines.push(line));
    const byteLength = Buffer.byteLength.bind(Buffer);
    const indexOf = String.prototype.indexOf;
    let measuredCharacters = 0;
    let scannedCharacters = 0;
    const scanning = vi.spyOn(String.prototype, "indexOf").mockImplementation(function (this: string, value, offset) {
      if (value === "\n") scannedCharacters += this.length;
      return indexOf.call(this, value, offset);
    });
    const measurement = vi.spyOn(Buffer, "byteLength").mockImplementation((value, encoding) => {
      if (typeof value === "string") measuredCharacters += value.length;
      return byteLength(value, encoding);
    });
    try {
      for (let index = 0; index < count; index += 1) decoder.push(chunk);
      decoder.push(Buffer.from("\n"));
      decoder.end();
    } finally {
      measurement.mockRestore();
      scanning.mockRestore();
    }
    assert.deepEqual(lines, [expected]);
    assert.ok(measuredCharacters <= expected.length * 3 + 1, `repeatedly measured ${measuredCharacters} characters`);
    assert.ok(scannedCharacters <= expected.length * 2 + 1, `repeatedly scanned ${scannedCharacters} characters`);
  });
}
