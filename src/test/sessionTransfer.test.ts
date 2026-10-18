import assert from "node:assert/strict";
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gistCreateArguments, gistUrl, redactSessionPayload, uploadSessionGist } from "../sessionShare";
import {
  assertSessionJsonlWorkspace,
  hashSessionEntries,
  readTransferFile,
  validateSessionJsonl,
  writeTransferFile,
} from "../sessionTransfer";

test("entry digest bounds reject excessive count and serialized bytes", () => {
  assert.throws(() => hashSessionEntries(Array(50_001).fill(null)), /50,000/);
  assert.throws(() => hashSessionEntries(Array(33).fill("x".repeat(1024 * 1024))), /32 MiB/);
  assert.notEqual(hashSessionEntries([{ x: "a" }, { x: "b" }]), hashSessionEntries([{ x: "ab" }]));
});

const timestamp = "2026-01-01T00:00:00.000Z";
function sessionFixture(cwd = process.cwd(), entries?: Record<string, unknown>[]): Buffer {
  return Buffer.from(
    [
      { type: "session", version: 3, id: "fixture-session", timestamp, cwd },
      ...(entries ?? [
        {
          type: "message",
          id: "a",
          parentId: null,
          timestamp,
          message: { role: "user", content: "fixture-secret", timestamp: 0 },
        },
        {
          type: "message",
          id: "b",
          parentId: "a",
          timestamp,
          message: {
            role: "bashExecution",
            command: "!! fixture",
            output: "sensitive-output",
            cancelled: false,
            truncated: false,
            excludeFromContext: true,
            timestamp: 1,
          },
        },
        { type: "custom", id: "c", parentId: "a", timestamp, customType: "fixture", data: { abandoned: true } },
      ]),
    ]
      .map((value) => JSON.stringify(value))
      .join("\n") + "\n",
  );
}
function mutate(change: (values: Record<string, any>[]) => void): Buffer {
  const values = sessionFixture()
    .toString()
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  change(values);
  return Buffer.from(values.map((value) => JSON.stringify(value)).join("\n") + "\n");
}
test("complete Pi v3 tree preserves abandoned branches, shell entries and opaque metadata", () => {
  const validated = validateSessionJsonl(sessionFixture());
  assert.deepEqual(
    validated.entries.map((entry) => entry.id),
    ["a", "b", "c"],
  );
  assert.equal(((validated.entries[1]?.message ?? {}) as Record<string, unknown>).excludeFromContext, true);
  assert.equal(((validated.entries[2]?.data ?? {}) as Record<string, unknown>).abandoned, true);
});
for (const [name, change] of Object.entries({
  legacy: (values: Record<string, any>[]) => {
    values[0]!.version = 2;
  },
  future: (values: Record<string, any>[]) => {
    values[0]!.version = 4;
  },
  duplicate: (values: Record<string, any>[]) => {
    values[2]!.id = "a";
  },
  orphan: (values: Record<string, any>[]) => {
    values[2]!.parentId = "missing";
  },
  cycle: (values: Record<string, any>[]) => {
    values[1]!.parentId = "b";
  },
  header: (values: Record<string, any>[]) => {
    values[0]!.cwd = "relative";
  },
  entry: (values: Record<string, any>[]) => {
    values[1]!.type = "future-entry";
  },
  message: (values: Record<string, any>[]) => {
    values[1]!.message = { role: "user", timestamp: 0 };
  },
  signature: (values: Record<string, any>[]) => {
    values[1]!.timestamp = "invalid";
  },
  compaction: (values: Record<string, any>[]) => {
    values.push({
      type: "compaction",
      id: "d",
      parentId: "c",
      timestamp,
      summary: "bad cross-branch ref",
      firstKeptEntryId: "b",
      tokensBefore: 10,
    });
  },
  edit: (values: Record<string, any>[]) => {
    values.push({ type: "context_edit", id: "d", parentId: "c", timestamp, targetId: "b", replacement: null });
  },
})) {
  test(`import rejects ${name} without migration, execution, or silent dropping`, () =>
    assert.throws(() => validateSessionJsonl(mutate(change))));
}
test("empty, truncated, invalid UTF-8 and oversized session data fail closed", () => {
  for (const bytes of [
    Buffer.alloc(0),
    sessionFixture().subarray(0, -1),
    Buffer.from([255, 10]),
    Buffer.alloc(32 * 1024 * 1024 + 1, 10),
    Buffer.from(`${JSON.stringify({ type: "session" })}\n\n`),
  ])
    assert.throws(() => validateSessionJsonl(bytes));
  assert.throws(() =>
    validateSessionJsonl(
      mutate((values) => {
        values[1]!.message.content = "x".repeat(8 * 1024 * 1024);
      }),
    ),
  );
});
test("image, depth and reference bounds apply to the complete file, not only visible messages", () => {
  assert.throws(() =>
    validateSessionJsonl(
      mutate((values) => {
        values[3]!.data = { type: "image", data: "AA=", mimeType: "image/png" };
      }),
    ),
  );
  assert.throws(() =>
    validateSessionJsonl(
      mutate((values) => {
        values[3]!.data = {
          type: "image",
          data: Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64"),
          mimeType: "image/png",
        };
      }),
    ),
  );
  assert.throws(() =>
    validateSessionJsonl(
      mutate((values) => {
        let object: any = {};
        for (let index = 0; index < 70; index++) object = { object };
        values[3]!.data = object;
      }),
    ),
  );
  const valid = validateSessionJsonl(
    mutate((values) => {
      values[3]!.data = { type: "thinking", redacted: true, thinkingSignature: "opaque-sensitive-replay-data" };
    }),
  );
  assert.ok(JSON.stringify(valid.entries).includes("opaque-sensitive-replay-data"));
});
for (const size of [4, 5]) {
  test(`canonical ${size} MiB session images do not exhaust the regex stack`, () => {
    const data = Buffer.alloc(size * 1024 * 1024).toString("base64");
    const bytes = mutate((values) => {
      values[1]!.message.content = [{ type: "image", mimeType: "image/png", data }];
    });
    const validated = validateSessionJsonl(bytes);
    const message = validated.entries[0]?.message as { content: { data: string }[] };
    assert.equal(message.content[0]?.data, data);
  });
}
test("stack-safe image checks retain canonical base64 and decoded-byte limits", () => {
  for (const data of ["AA=", "AA", "AB==", "AA==AA==", "A===", "AA==\\n", "AA-_", "AAé=", ""]) {
    assert.throws(
      () =>
        validateSessionJsonl(
          mutate((values) => {
            values[1]!.message.content = [{ type: "image", mimeType: "image/png", data }];
          }),
        ),
      /session image|Session images/,
    );
  }
  assert.throws(
    () =>
      validateSessionJsonl(
        mutate((values) => {
          values[1]!.message.content = [
            {
              type: "image",
              mimeType: "image/png",
              data: Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64"),
            },
          ];
        }),
      ),
    /Session images exceed 5 MiB/,
  );
});
test("multiple roots are valid Pi tree semantics, not silently joined", () => {
  assert.equal(
    validateSessionJsonl(
      mutate((values) => {
        values[3]!.parentId = null;
      }),
    ).entries[2]?.parentId,
    null,
  );
});
test("bounded descriptor snapshots reject links, path aliases, directories, changed source and oversized files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-transfer-files-"));
  try {
    const source = path.join(root, "source.jsonl");
    await writeFile(source, sessionFixture(root));
    await assertSessionJsonlWorkspace(validateSessionJsonl(await readTransferFile(source)), root);
    await mkdir(path.join(root, "other"));
    await assert.rejects(
      assertSessionJsonlWorkspace(validateSessionJsonl(await readTransferFile(source)), path.join(root, "other")),
      /another workspace/,
    );
    await symlink(source, path.join(root, "symlink.jsonl"));
    await assert.rejects(readTransferFile(path.join(root, "symlink.jsonl")), /links|aliases/);
    await link(source, path.join(root, "hardlink.jsonl"));
    await assert.rejects(readTransferFile(source), /unsupported/);
    await assert.rejects(readTransferFile(root));
    await assert.rejects(readTransferFile(path.join(root, "missing.jsonl")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("exclusive local writes never replace a concurrent destination or follow a destination symlink", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-transfer-write-"));
  try {
    const target = path.join(root, "output.jsonl");
    const original = sessionFixture(root);
    await writeTransferFile(target, original);
    await assert.rejects(writeTransferFile(target, Buffer.from("replacement")), /EEXIST/);
    assert.deepEqual(await readFile(target), original);
    await symlink(target, path.join(root, "link.jsonl"));
    await assert.rejects(writeTransferFile(path.join(root, "link.jsonl"), Buffer.from("unsafe")));
    assert.deepEqual(await readFile(target), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("share literal redaction changes exact JSON string values without dropping entries or shell metadata", () => {
  const source = sessionFixture();
  const redacted = redactSessionPayload(source, "fixture-secret");
  assert.ok(!redacted.includes(Buffer.from("fixture-secret")));
  assert.ok(redacted.includes(Buffer.from("[REDACTED]")));
  assert.ok(redacted.includes(Buffer.from("sensitive-output")));
  assert.equal(validateSessionJsonl(redacted).entries.length, 3);
  assert.ok(source.includes(Buffer.from("fixture-secret")), "redaction must not modify source snapshot");
  assert.throws(() => redactSessionPayload(source, ""));
});
test("public gh adapter uses exact approved stdin payload and explicit non-public visibility, not a private API", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-gist-fixture-"));
  try {
    const executable = path.join(root, "gh-fixture.mjs");
    const captured = path.join(root, "captured.json");
    await writeFile(
      executable,
      `#!/usr/bin/env node\nimport{writeFileSync}from'node:fs';let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{writeFileSync(${JSON.stringify(captured)},JSON.stringify({args:process.argv.slice(2),input,host:process.env.GH_HOST}));console.log('https://gist.github.com/fixture/abcdef123456')});\n`,
    );
    await chmod(executable, 0o700);
    const payload = redactSessionPayload(sessionFixture(root), "fixture-secret");
    const url = await uploadSessionGist(payload, root, undefined, executable);
    assert.equal(url, "https://gist.github.com/fixture/abcdef123456");
    const capture = JSON.parse(await readFile(captured, "utf8"));
    assert.deepEqual(capture.args, gistCreateArguments);
    assert.equal(capture.input, payload.toString());
    assert.equal(capture.host, "github.com");
    assert.ok(!capture.args.join(" ").includes("fixture-secret"));
    await writeFile(executable, "#!/usr/bin/env node\nprocess.stderr.write('secret-token');process.exit(1);\n");
    await assert.rejects(
      uploadSessionGist(payload, root, undefined, executable),
      (error: unknown) =>
        error instanceof Error &&
        /unknown|before retrying/.test(error.message) &&
        !error.message.includes("secret-token"),
    );
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(uploadSessionGist(payload, root, cancelled.signal, executable), /Nothing was sent/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("returned gist URLs reject lookalike hosts, arbitrary schemes, query tokens and fragments", () => {
  for (const value of [
    "https://gist.github.com.evil.invalid/u/abcd",
    "command:bad",
    "https://gist.github.com/u/abcd?secret=x",
    "https://gist.github.com/u/abcd#x",
    "https://user:secret@gist.github.com/u/abcd",
    "https://gist.github.com/u/not-hex",
  ])
    assert.throws(() => gistUrl(value));
});
