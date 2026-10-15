import assert from "node:assert/strict";

export const richFixture = [
  "Native fixture explanation.",
  "",
  "# Rich content",
  "",
  "- **Markdown** with ~~old~~ and *new* text",
  "  - Nested list",
  "- [x] Checked task",
  "",
  "> A quote",
  "",
  "| Name | Value |",
  "| --- | --- |",
  "| Fraction | Math |",
  "",
  "[Documentation](https://example.com)",
  "",
  "Inline $x^2$, \\(y_1\\) and display math:",
  "",
  "$$\\frac{1}{2}+\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}$$",
  "",
  "\\[\\sum_{i=1}^{n} i\\]",
  "",
  "```ts",
  "const value = 1 < 2;",
  "```",
  "",
  "```mermaid",
  "flowchart LR",
  "A[Input] --> B[Output]",
  "```",
  "",
  "```mermaid",
  "sequenceDiagram",
  "Alice->>Bob: Hello",
  "Bob-->>Alice: Ready",
  "```",
].join("\n");

export async function assertRichContent(frame) {
  await frame.locator(".mermaid-preview svg").nth(1).waitFor();
  assert.ok(await frame.locator(".content table").count());
  assert.ok(await frame.locator(".content blockquote").count());
  assert.ok(await frame.locator(".content .hljs-keyword").count());
  assert.equal(await frame.locator(".content .katex").count(), 4);
  assert.equal(await frame.locator(".content math").count(), 4);
  assert.equal(await frame.locator('.content math annotation[encoding="application/x-tex"]').count(), 4);
  const labels = await frame.locator(".mermaid-preview").allTextContents();
  assert.match(labels[0], /Input/);
  assert.match(labels[0], /Output/);
  assert.match(labels[1], /Alice/);
  assert.match(labels[1], /Bob/);
  const evidence = await frame.evaluate(async () => {
    await document.fonts.ready;
    const math = document.querySelector(".katex");
    const matrix = document.querySelector(".katex-display");
    return {
      font: getComputedStyle(math).fontFamily,
      mathHeight: math.getBoundingClientRect().height,
      displayHeight: matrix.getBoundingClientRect().height,
      fonts: performance
        .getEntriesByType("resource")
        .filter((entry) => /\.woff2?(?:\?|$)/.test(entry.name))
        .map((entry) => entry.name),
      diagrams: [...document.querySelectorAll(".mermaid-preview svg")].map((svg) => ({
        width: svg.getBoundingClientRect().width,
        height: svg.getBoundingClientRect().height,
      })),
    };
  });
  assert.match(evidence.font, /KaTeX/);
  assert.ok(evidence.mathHeight > 10);
  assert.ok(evidence.displayHeight > evidence.mathHeight);
  assert.ok(evidence.fonts.length, "packaged math fonts must load");
  assert.ok(evidence.diagrams.every((diagram) => diagram.width > 20 && diagram.height > 20));
  assert.equal(await frame.locator(".content script, .content iframe, .content img, .content svg a").count(), 0);
  return evidence;
}
