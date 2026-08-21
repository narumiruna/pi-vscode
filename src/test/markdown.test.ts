import assert from "node:assert/strict";
import test from "node:test";
import { renderSafeMarkdown } from "../markdown";

test("renderSafeMarkdown renders common code-oriented Markdown", () => {
  const html = renderSafeMarkdown([
    "# Result",
    "",
    "- **Changed** parser",
    "- Added `validate()`",
    "",
    "```ts",
    "const value = 1 < 2;",
    "```",
  ].join("\n"));

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
