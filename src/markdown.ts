import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import katex from "katex";

type TokenizerExtension = import("marked", { with: { "resolution-mode": "import" }}).TokenizerExtension;

// Bundled to CJS for the Extension Host; marked itself is ESM-only.
const { Marked } = require("marked") as typeof import("marked", { with: { "resolution-mode": "import" }});
for (const [name, language] of Object.entries({ bash, css, javascript, json, python, typescript, xml })) {
  hljs.registerLanguage(name, language);
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function safeMarkdownUrl(value: string): boolean {
  return (
    /^(?:https?:\/\/|mailto:)/i.test(value) &&
    !Array.from(value).some(
      (character) => /\s/.test(character) || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  );
}

let mathCount = 0;
function mathExtension(block: boolean): TokenizerExtension {
  return {
    name: block ? "mathBlock" : "mathInline",
    level: block ? "block" : "inline",
    start(source) {
      return source.search(block ? /(?:^|\n) {0,3}(?:\$\$|\\\[)/ : /\$|\\[([]/);
    },
    tokenizer(source) {
      const opening = (block ? /^(?: {0,3})(\$\$|\\\[)/ : /^(\$\$|\$|\\\(|\\\[)/).exec(source);
      if (!opening) return undefined;
      const delimiter = opening[1];
      const close = delimiter === "\\(" ? "\\)" : delimiter === "\\[" ? "\\]" : delimiter;
      const start = opening[0].length;
      let end = source.indexOf(close, start);
      while (end >= 0 && /(?:^|[^\\])(?:\\\\)*\\$/.test(source.slice(0, end)))
        end = source.indexOf(close, end + close.length);
      if (end < 0) {
        const text = source.slice(start);
        if (
          delimiter.startsWith("\\") ||
          ((delimiter === "$$" || delimiter === "$") && /\\[A-Za-z]+|[_^=+*/]/.test(text))
        ) {
          return { type: block ? "mathBlock" : "mathInline", raw: source, text, pending: true };
        }
        return undefined;
      }
      const text = source.slice(start, end);
      if (!text.trim() || (!block && text.includes("\n"))) return undefined;
      if (
        delimiter === "$" &&
        (/^\s|\s$/.test(text) ||
          /^\d/.test(source.slice(end + 1)) ||
          text.includes("`") ||
          (/^[A-Z_][A-Z0-9_]*(?:[^A-Za-z0-9_\s])?$/.test(text) &&
            /^[A-Za-z_][A-Za-z0-9_]*/.test(source.slice(end + 1))))
      )
        return undefined;
      const raw = source.slice(0, end + close.length);
      return {
        type: block ? "mathBlock" : "mathInline",
        raw,
        text,
        display: block || delimiter === "$$" || delimiter === "\\[",
      };
    },
  };
}

const parser = new Marked({ gfm: true, breaks: false });
parser.use({
  extensions: [mathExtension(true), mathExtension(false)].map((extension) => ({
    ...extension,
    renderer(token) {
      if (
        token.pending ||
        ++mathCount > 50 ||
        token.text.length > 4000 ||
        /\\(?:href|url|includegraphics|html[A-Za-z]*)\b/.test(token.text)
      )
        return escapeHtml(token.raw);
      try {
        return katex.renderToString(token.text, {
          displayMode: token.display,
          trust: false,
          strict: "error",
          throwOnError: true,
          maxExpand: 200,
          maxSize: 10,
          output: "htmlAndMathml",
        });
      } catch {
        return escapeHtml(token.raw);
      }
    },
  })),
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    link({ href, tokens }) {
      const label = this.parser.parseInline(tokens);
      return safeMarkdownUrl(href) ? `<a href="${escapeHtml(href)}" rel="noreferrer noopener">${label}</a>` : label;
    },
    image({ text }) {
      return escapeHtml(text);
    },
    code({ text, lang, raw }) {
      const language = lang?.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
      const highlighted = hljs.getLanguage(language)
        ? hljs.highlight(text, { language, ignoreIllegals: true }).value
        : escapeHtml(text);
      const code = `<pre><code${language && /^[a-z0-9_+-]+$/.test(language) ? ` class="language-${language}"` : ""}>${highlighted}</code></pre>`;
      // An open fence remains source text while streaming.
      const fence = /^ {0,3}(`{3,}|~{3,})/.exec(raw)?.[1];
      const closed = fence && new RegExp(`\\n {0,3}${fence[0]}{${fence.length},}\\s*$`).test(raw);
      return language === "mermaid" && closed ? `<div class="mermaid-source">${code}</div>` : code;
    },
    checkbox({ checked }) {
      return `<span class="task-checkbox" aria-label="${checked ? "Completed" : "Not completed"}">${checked ? "☑" : "☐"}</span> `;
    },
  },
});

export function renderSafeMarkdown(markdown: string): string {
  if (!markdown.trim()) return "";
  mathCount = 0;
  let html: string;
  try {
    html = (parser.parse(markdown, { async: false }) as string).trim();
  } catch {
    html = `<pre>${escapeHtml(markdown)}</pre>`;
  }
  return html;
}

export class MarkdownRenderer {
  private readonly cache = new Map<string, string>();
  private cachedCharacters = 0;

  public constructor(private readonly parse: (markdown: string) => string = renderSafeMarkdown) {}

  public renderBatch(messages: readonly string[]): string[] {
    // Capture hits before any miss can evict a later message in this transcript.
    const available = new Map(this.cache);
    return messages.map((markdown) => {
      let html = available.get(markdown);
      if (html === undefined) {
        html = this.parse(markdown);
        available.set(markdown, html);
      }
      const cost = markdown.length + html.length;
      if (!this.cache.has(markdown) && cost <= 2_000_000) {
        while (this.cache.size >= 64 || this.cachedCharacters + cost > 2_000_000) {
          const oldest = this.cache.keys().next().value;
          if (oldest === undefined) break;
          this.cachedCharacters -= oldest.length + (this.cache.get(oldest)?.length ?? 0);
          this.cache.delete(oldest);
        }
        this.cache.set(markdown, html);
        this.cachedCharacters += cost;
      }
      return html;
    });
  }
}
