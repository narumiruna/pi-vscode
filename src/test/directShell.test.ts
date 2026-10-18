import assert from "node:assert/strict";
import {
  cleanShellText,
  formatBashExecutionText,
  maxShellOutputCharacters,
  parseBashResultView,
  parseComposerInput,
} from "../directShell";
import { ImageAssetCache } from "../imageAssets";
import { installVscodeMock } from "./vscodeMock";

installVscodeMock();
const { convertPiMessages } = require("../sidebarHelpers") as typeof import("../sidebarHelpers");

import { persistableSidebarMessages, restoreSidebarMessages } from "../sidebarState";

test("only column-one explicit shell input executes; escapes, prose, slash commands and fences stay prompts", () => {
  for (const text of [
    "ordinary ! prose",
    " !printf hello",
    "\n!printf hello",
    "/command !arg",
    "```sh\n!printf hello\n```",
  ])
    assert.deepEqual(parseComposerInput(text), { kind: "prompt", text });
  assert.deepEqual(parseComposerInput("\\!literal"), { kind: "prompt", text: "!literal" });
  assert.deepEqual(parseComposerInput("\\!!literal"), { kind: "prompt", text: "!!literal" });
  assert.deepEqual(parseComposerInput("! printf hello\nprintf world"), {
    kind: "shell",
    command: " printf hello\nprintf world",
    excludeFromContext: false,
  });
  assert.deepEqual(parseComposerInput("!!printf hello"), {
    kind: "shell",
    command: "printf hello",
    excludeFromContext: true,
  });
  for (const text of ["!", "!!", "! \n\t", "!!\n", `!${"x".repeat(8_001)}`, "!printf \u0000"])
    assert.throws(() => parseComposerInput(text));
});

test("shell output strips terminal and bidi controls, bounds final data and rejects malformed results", () => {
  assert.equal(
    cleanShellText("\u001b[31mred\u001b[0m\u001b]8;;https://invalid\u0007link\u001b]8;;\u0007\r\u0000\u202eevil\n\t"),
    "redlinkevil\n\t",
  );
  const result = parseBashResultView({
    output: "x".repeat(maxShellOutputCharacters + 1),
    exitCode: 7,
    cancelled: false,
    truncated: false,
  });
  assert.equal(result.output.length, maxShellOutputCharacters);
  assert.equal(result.truncated, true);
  assert.match(formatBashExecutionText("printf x", true, result), /Exit: 7 · Output truncated/);
  assert.match(
    formatBashExecutionText("printf x", true, result),
    /Excluded from model context; retained in Pi history/,
  );
  assert.match(formatBashExecutionText("printf x", false, result), /Included in model context on the next prompt/);
  for (const value of [
    {},
    { output: "x", cancelled: false, truncated: false, exitCode: NaN },
    { output: "x", cancelled: "false", truncated: false },
  ])
    assert.throws(() => parseBashResultView(value), /Invalid Pi shell result/);
});

test("direct shell checkpoint coverage is explicitly non-restorable", () => {
  const { WorkspaceChangeTracker } = require("../changeTracker") as typeof import("../changeTracker");
  const tracker = new WorkspaceChangeTracker();
  tracker.recordShellRequest("/canonical-fixture", "fixture-session", "cancelled");
  assert.deepEqual(tracker.changes, []);
  const record = (tracker as any).history.values[0];
  assert.deepEqual(record.files, []);
  assert.equal(record.status, "cancelled");
  assert.match(record.exclusions[0], /all file, process, and external effects are non-restorable/);
  tracker.dispose();
});

test("included and excluded bash history both render as inert shell records and survive bounded persistence", () => {
  const assets = () => new ImageAssetCache({ maxImageBytes: 1024, maxTotalBytes: 1024, maxAssets: 1 });
  const values = [false, true].map((excludeFromContext, index) => ({
    role: "bashExecution",
    command: "printf '<img src=x>'",
    output: "\u001b[31m<img src=x>\u001b[0m",
    exitCode: index,
    cancelled: false,
    truncated: false,
    excludeFromContext,
    timestamp: index,
  }));
  const messages = convertPiMessages(values, { imageAssets: assets() });
  assert.equal(messages.length, 2);
  assert.ok(messages.every((message) => message.role === "shell"));
  assert.match(messages[0].content, /Included in model context/);
  assert.match(messages[1].content, /Excluded from model context; retained in Pi history/);
  assert.ok(messages.every((message) => !message.content.includes("\u001b")));
  assert.deepEqual(restoreSidebarMessages(persistableSidebarMessages(messages), 100, 250_000), messages);
  assert.equal(convertPiMessages(values, { imageAssets: assets(), maxMessages: 1 }).length, 1);
});
