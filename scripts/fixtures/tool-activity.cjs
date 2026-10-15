// Verified Pi content/text results, including codemode's serialized result envelope.
const text = (text) => ({ content: [{ type: "text", text }] });
const long = Array.from({ length: 180 }, (_, index) => `line ${index}: ${"long-output ".repeat(8)}`).join("\n");
const calls = [
  ["read", { path: "src/sidebar.ts" }, text(JSON.stringify({ content: [{ type: "text", text: "file contents" }] }))],
  [
    "edit",
    { path: "src/sidebarHtml.ts", edits: [{ oldText: "before", newText: "after" }] },
    text("Successfully replaced 1 block"),
  ],
  ["bash", { command: "npm test\n&& echo done" }, text(long + "\nFINAL: retained command summary")],
  ["codemode", { code: "text(await tools.read(...))" }, text(JSON.stringify(text("wrapped first\nwrapped second")))],
  ["custom", { value: "<script>not executable</script>" }, { result: { unknown: true } }],
  ["read", { path: "missing.ts" }, text("File not found: missing.ts"), true],
  ["bash", { command: "printf ''" }, text("")],
  ["read", { path: "<img src=x onerror=alert(1)>" }, text(String.raw`literal\nbackslashes`)],
  ["write", { path: "docs/example.md", content: "example" }, text("Written")],
  ["read", { path: `src/${"long-path/".repeat(80)}file.ts` }, text("Done")],
  [
    "bash",
    { command: "stream fixture output" },
    text(JSON.stringify({ output: "literal command result", exit_code: 0, wall_time_seconds: 1, truncated: false })),
  ],
];
module.exports = { calls };
