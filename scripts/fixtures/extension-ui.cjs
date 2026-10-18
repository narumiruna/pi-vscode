// Pi 1.3.0 public RPC extension UI records. No provider, tool or terminal renderer.
module.exports = [
  { method: "setStatus", statusKey: "second", statusText: "old" },
  { method: "setStatus", statusKey: "first", statusText: "First status" },
  { method: "setStatus", statusKey: "second", statusText: "\u001b[32mUpdated status\u001b[0m" },
  { method: "setWidget", widgetKey: "removed", widgetLines: ["Must be removed"] },
  { method: "setWidget", widgetKey: "removed" },
  {
    method: "setWidget",
    widgetKey: "above",
    widgetLines: [
      "<script>window.extensionInjected=true</script> [run](command:run)",
      "\u001b]8;;https://example.invalid\u0007Visible text\u001b]8;;\u001b\\",
      ...Array(18).fill("x".repeat(1000)),
    ],
  },
  {
    method: "setWidget",
    widgetKey: "below",
    widgetLines: Array(6).fill("y".repeat(1000)),
    widgetPlacement: "belowEditor",
  },
  { method: "setWidget", widgetKey: "empty", widgetLines: [] },
];
