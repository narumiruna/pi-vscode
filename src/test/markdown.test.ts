import assert from "node:assert/strict";
import { MarkdownRenderer, renderSafeMarkdown, safeMarkdownUrl } from "../markdown";

const render = renderSafeMarkdown;

test("batch cache retains useful hits across 100-message scans and streaming updates", () => {
  let parses = 0;
  const renderer = new MarkdownRenderer((markdown) => {
    parses++;
    return render(markdown);
  });
  const messages = Array.from({ length: 100 }, (_, index) => `Message ${index}: $x^2$ and \`code\``);
  const first = renderer.renderBatch(messages);
  assert.equal(parses, 100);
  assert.deepEqual(renderer.renderBatch(messages), first);
  assert.equal(parses, 136, "the second scan must reuse all 64 hits before eviction");
  for (let update = 0; update < 5; update++) {
    messages[99] = `Streaming update ${update}: $x^2$`;
    const before: number = parses;
    const html = renderer.renderBatch(messages);
    assert.ok(parses - before <= 37, "64-entry cache keeps at least 63 stable hits when the last message changes");
    assert.deepEqual(html, messages.map(render));
  }
});

test("batch cache reuses duplicate sources and obeys its character limit", () => {
  let parses = 0;
  const renderer = new MarkdownRenderer((markdown) => {
    parses++;
    return markdown + "x".repeat(650_000);
  });
  renderer.renderBatch(["A", "B", "C", "D"]);
  assert.equal(parses, 4);
  renderer.renderBatch(["A", "B", "C", "D"]);
  assert.equal(parses, 5, "three hits survive a scan that exceeds the character budget");
  const before = parses;
  renderer.renderBatch(["duplicate", "duplicate"]);
  assert.equal(parses - before, 1);
  const oversized = new MarkdownRenderer((markdown) => {
    parses++;
    return markdown + "x".repeat(2_000_001);
  });
  const beforeOversized = parses;
  oversized.renderBatch(["large"]);
  oversized.renderBatch(["large"]);
  assert.equal(parses - beforeOversized, 2, "oversized output is not retained");
});

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
test("math closers use only the adjacent backslash run for escape parity", () => {
  for (const [opening, closing] of [
    ["$", "$"],
    ["$$", "$$"],
    ["\\(", "\\)"],
    ["\\[", "\\]"],
  ]) {
    for (let count = 0; count <= 4; count++) {
      const source = `${opening}x^2${"\\".repeat(count)}${closing}`;
      const html = render(source);
      if (count % 2 === 0) assert.match(html, /class="katex/, source);
      else {
        assert.doesNotMatch(html, /class="katex/, source);
        assert.ok(html.includes(source), source);
      }
    }
    const expression = `x^2\\${closing} + y`;
    const source = opening + expression + closing;
    const html = render(source);
    assert.ok(
      html.includes(source) || html.includes(`<annotation encoding="application/x-tex">${expression}</annotation>`),
      "an escaped candidate must not close the formula early",
    );
  }
});

test("a bounded message with many escaped math closers does not rescan its prefixes", () => {
  const source = `$${"\\$".repeat(49_999)}`;
  const start = performance.now();
  const html = render(source);
  const elapsed = performance.now() - start;
  assert.equal(html, `<p>${"$".repeat(50_000)}</p>`);
  // The original prefix scan takes several seconds. Allow ample time for CI.
  assert.ok(elapsed < 1000, `99,999 characters took ${elapsed} ms`);
});

test("unmatched prices preserve later Markdown throughout streaming", () => {
  for (const price of ["5", "5.99", "1,000.50"]) {
    for (const suffix of ["*cheap*", "**cheap**", "[details](https://example.com)", "~~old~~", "`code`", "_cheap_"]) {
      const prefix = `Price is $${price} and `;
      for (let length = 0; length <= suffix.length; length++) {
        const tail = suffix.slice(0, length);
        const expected = render(`Price is ${price} and ${tail}`).replace(`Price is ${price}`, `Price is $${price}`);
        assert.equal(render(prefix + tail), expected);
      }
    }
  }
  for (const source of ["$2+2$", "$2^3$", "$2^3", "$x^2"]) {
    const html = render(source);
    if (source.endsWith("$")) assert.match(html, /class="katex/);
    else assert.ok(html.includes(source), "pending math must remain source");
  }
});

test("pending numeric math keeps its source when clear math syntax follows whitespace", () => {
  for (const expression of [
    "2 \\times *x*",
    "2 \\\\times *x*",
    "2 \\frac{*x*}{2}",
    "2 + *x*",
    "2 = *x*",
    "2 ^ *x*",
    "2 _ *x*",
    "2 * *x*",
    "2 / *x*",
    "2 - *x*",
    "2.5 \\times *x*",
  ]) {
    const source = `$${expression}`;
    assert.equal(render(source), `<p>${source}</p>`, source);
  }
  assert.match(render("$2 \\times x$"), /class="katex/);
});

test("pending factorial formulas keep their source before clear math continuations", () => {
  for (const expression of [
    "5! + *x*",
    "5!+ *x*",
    "5!! + *x*",
    "5! = *x*",
    "5! ^ *x*",
    "5! _ *x*",
    "5! * *x*",
    "5! / *x*",
    "5! - *x*",
    "5! \\times *x*",
    "5!\\times *x*",
  ]) {
    const source = `$${expression}`;
    assert.equal(render(source), `<p>${source}</p>`, source);
  }
  for (const source of ["$5! + x$", "$5!! + x$", "$5! \\times x$"]) assert.match(render(source), /class="katex/);
});

test("underscore emphasis directly after prices remains Markdown during streaming", () => {
  for (const price of ["5", "5.99", "1,000.50"]) {
    for (const punctuation of ["", "!", "!!"]) {
      for (const suffix of ["_cheap_", "__cheap__", "*cheap*", "**cheap**"]) {
        for (let length = 0; length <= suffix.length; length++) {
          const tail = suffix.slice(0, length);
          const plain = `Only ${price}${punctuation} ${tail}`;
          const source = plain.replace(`Only ${price}`, `Only $${price}`);
          const expected = render(plain).replace(`Only ${price}`, `Only $${price}`);
          assert.equal(render(source), expected, source);
        }
      }
    }
  }
  for (const source of ["$2 _ *x*", "$2 _{*x*}"]) assert.equal(render(source), `<p>${source}</p>`);
});

test("pending numeric inequalities keep Markdown syntax as escaped source", () => {
  for (const number of ["2", "2.5", "5!"]) {
    for (const operator of ["<", ">", "<=", ">=", "<<", ">>"]) {
      for (const suffix of ["*x*", "**x**", "`x`", "[x](https://example.com)", "_x_"]) {
        const source = `$${number} ${operator} ${suffix}`;
        const escaped = source.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
        assert.equal(render(source), `<p>${escaped}</p>`, source);
      }
      assert.match(render(`$${number} ${operator} x$`), /class="katex/);
    }
  }
});

test("prices with punctuation boundaries retain later Markdown during streaming", () => {
  for (const price of ["5", "5.99", "1,000.50"]) {
    for (const punctuation of ["),", ")", "]", "}", ":", ";", "!", "?", ",", ".", "'", '"']) {
      for (const suffix of ["**cheap**", "*cheap*", "[details](https://example.com)", "`code`", "_cheap_"]) {
        for (let length = 0; length <= suffix.length; length++) {
          const tail = suffix.slice(0, length);
          const plain = `Costs (${price}${punctuation} ${tail}`;
          const source = plain.replace(`(${price}`, `($${price}`);
          const expected = render(plain).replace(`(${price}`, `($${price}`);
          assert.equal(render(source), expected, source);
        }
      }
    }
  }
  assert.equal(render("Costs ($5), **cheap**"), "<p>Costs ($5), <strong>cheap</strong></p>");
});

test("only closed Mermaid fences are marked for diagram rendering", () => {
  const source = "flowchart LR\nA-->B";
  assert.match(render("```mermaid\n" + source + "\n```"), /class="mermaid-source"/);
  assert.doesNotMatch(render("```mermaid\n" + source), /class="mermaid-source"/);
  assert.doesNotMatch(render("```text\n" + source + "\n```"), /class="mermaid-source"/);
});
