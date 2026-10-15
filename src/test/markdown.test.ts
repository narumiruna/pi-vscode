import assert from "node:assert/strict";
import { renderSafeMarkdown, safeMarkdownUrl } from "../markdown";

const render = renderSafeMarkdown;
test("Markdown supports headings, nested lists, tasks, tables, quotes, links and strikethrough", () => {
  const html = render(
    "# Result\n\n- **Changed** parser\n  - Added `validate()`\n- [x] Done\n\n> Quote\n\n| A | B |\n| - | - |\n| x | y |\n\n~~old~~ *new* [docs](https://example.com)",
  );
  for (const expected of [
    "<h1>Result</h1>",
    "<strong>Changed</strong>",
    "<code>validate()</code>",
    "<table>",
    "<blockquote>",
    "<del>old</del>",
    "<em>new</em>",
    'aria-label="Completed"',
    'href="https://example.com"',
  ])
    assert.ok(html.includes(expected), expected);
  assert.equal((html.match(/<ul>/g) ?? []).length, 2);
});
test("raw HTML, scripts, external images and unsafe links cannot become active markup", () => {
  const html = render(
    '<img src=x onerror="alert(1)">\n<script>alert(2)</script>\n\n![image](https://bad.invalid/a) [bad](javascript:alert(1)) [encoded](java&#x73;cript:alert(1)) [data](data:text/html,x)',
  );
  assert.doesNotMatch(html, /<img|<script|<a /);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script&gt;/);
  for (const url of [
    "javascript:alert(1)",
    "command:picode.openChat",
    "file:///tmp/a",
    "//example.com",
    "https://example.com\nfoo",
  ])
    assert.equal(safeMarkdownUrl(url), false);
  for (const url of ["https://example.com", "http://localhost:1234/a", "mailto:example@example.com"])
    assert.equal(safeMarkdownUrl(url), true);
});
test("inline code is literal and known code languages are highlighted", () => {
  assert.equal(render("`**literal** <tag> $x$`"), "<p><code>**literal** &lt;tag&gt; $x$</code></p>");
  const html = render("```ts\nconst value = 1 < 2;\n```");
  assert.match(html, /class="language-ts"/);
  assert.match(html, /class="hljs-keyword"/);
  assert.match(html, /&lt;/);
  assert.equal(
    render("```unknown\n<img onerror=x>\n```"),
    '<pre><code class="language-unknown">&lt;img onerror=x&gt;</code></pre>',
  );
});
test("empty assistant turns stay invisible and blank lines add no visible artifacts", () => {
  for (const value of ["", " ", "\n\n", "\r\n\t  \r\n"]) assert.equal(render(value), "");
  assert.equal(
    render("\nFirst paragraph.\n\n\nSecond paragraph.\n\n"),
    "<p>First paragraph.</p>\n<p>Second paragraph.</p>",
  );
  assert.match(render("- One\n\nAfter the list."), /<ul>\s*<li>One<\/li>\s*<\/ul>\s*<p>After the list.<\/p>/);
});
test("complete and streaming code fences preserve meaningful whitespace", () => {
  const code = "line one\n\n  line two";
  const expected = `<pre><code class="language-unknown">${code}</code></pre>`;
  assert.equal(render("```unknown\n" + code + "\n```\n\n"), expected);
  assert.equal(render("```unknown\n" + code), expected);
});
test("all four math delimiters render with accessible MathML and bounded KaTeX", () => {
  for (const value of [
    "$x^2$",
    "$X$",
    "$$\\frac{1}{2}$$",
    "\\(x_1\\)",
    "\\[\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}\\]",
    "$$\nx+y\n$$",
  ]) {
    const html = render(value);
    assert.match(html, /class="katex/);
    assert.match(html, /<math /);
    assert.match(html, /<annotation encoding="application\/x-tex">/);
  }
});
test("money, shell variables, escapes, code, invalid and pending math keep readable source", () => {
  for (const value of [
    "Cost $5 and $10.",
    "$PATH and $HOME",
    "$PATH:$HOME",
    "\\$x\\$",
    "`$x$`",
    "```tex\n$x$\n```",
    "$\\unsupported{x}$",
    "$\\href{javascript:alert(1)}{x}$",
    "$\\includegraphics{https://bad.invalid/a}$",
    "$\\def\\a{\\a}\\a$",
    "$" + "x".repeat(4001) + "$",
  ])
    assert.doesNotMatch(render(value), /class="katex/);
  for (const value of ["\\(x^2", "\\[x+y", "$$\\frac{1}{", "$x^2"]) assert.ok(render(value).includes(value), value);
  const many = render(Array.from({ length: 51 }, () => "$x^2$").join(" "));
  assert.equal((many.match(/class="katex"/g) ?? []).length, 50);
  assert.match(many, /\$x\^2\$/);
});
test("only closed Mermaid fences are marked for diagram rendering", () => {
  const source = "flowchart LR\nA-->B";
  assert.match(render("```mermaid\n" + source + "\n```"), /class="mermaid-source"/);
  assert.doesNotMatch(render("```mermaid\n" + source), /class="mermaid-source"/);
  assert.doesNotMatch(render("```text\n" + source + "\n```"), /class="mermaid-source"/);
});
