import assert from "node:assert/strict";
import { renderSafeMarkdown } from "../markdown";

test("renderSafeMarkdown renders common code-oriented Markdown", () => {
  const html = renderSafeMarkdown(
    ["# Result", "", "- **Changed** parser", "- Added `validate()`", "", "```ts", "const value = 1 < 2;", "```"].join(
      "\n",
    ),
  );

  assert.match(html, /<h1>Result<\/h1>/);
  assert.match(html, /<strong>Changed<\/strong>/);
  assert.match(html, /<code>validate\(\)<\/code>/);
  assert.match(html, /<pre><code class="language-ts">/);
  assert.match(html, /1 &lt; 2/);
});

test("renderSafeMarkdown escapes raw HTML and scripts", () => {
  const html = renderSafeMarkdown('<img src=x onerror="alert(1)">\n<script>alert(2)</script>');

  assert.doesNotMatch(html, /<img|<script/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script&gt;/);
});

test("renderSafeMarkdown does not interpret Markdown inside inline code", () => {
  assert.equal(renderSafeMarkdown("`**literal** <tag>`"), "<p><code>**literal** &lt;tag&gt;</code></p>");
});

test("renderSafeMarkdown keeps empty assistant turns invisible", () => {
  for (const content of ["", " ", "\n\n", "\r\n\t  \r\n"]) {
    assert.equal(renderSafeMarkdown(content), "");
  }
});

test("renderSafeMarkdown separates paragraphs without extra blank-line artifacts", () => {
  assert.equal(
    renderSafeMarkdown("\nFirst paragraph.\n\n\nSecond paragraph.\n\n"),
    "<p>First paragraph.</p><p>Second paragraph.</p>",
  );
  assert.equal(renderSafeMarkdown("- One\n\nAfter the list."), "<ul><li>One</li></ul><p>After the list.</p>");
});

test("renderSafeMarkdown preserves whitespace inside complete and streaming code fences", () => {
  const code = "const x = 1;\n\n  x++;";
  const expected = `<pre><code class="language-ts">${code}</code></pre>`;
  assert.equal(renderSafeMarkdown("```ts\n" + code + "\n```\n\n"), expected);
  assert.equal(renderSafeMarkdown("```ts\n" + code), expected);
});
