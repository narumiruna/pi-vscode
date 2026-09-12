export function renderSafeMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const output: string[] = [];
  let inCode = false;
  let codeLanguage = "";
  let codeLines: string[] = [];
  let inList = false;

  const closeList = (): void => {
    if (inList) {
      output.push("</ul>");
      inList = false;
    }
  };

  for (const line of lines) {
    const fence = /^```([A-Za-z0-9_+-]*)\s*$/.exec(line);
    if (fence) {
      if (inCode) {
        output.push(`<pre><code${codeLanguage ? ` class="language-${codeLanguage}"` : ""}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        inCode = false;
        codeLanguage = "";
        codeLines = [];
      } else {
        closeList();
        inCode = true;
        codeLanguage = fence[1];
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      output.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }
    const listItem = /^\s*[-*]\s+(.+)$/.exec(line);
    if (listItem) {
      if (!inList) {
        output.push("<ul>");
        inList = true;
      }
      output.push(`<li>${renderInline(listItem[1])}</li>`);
      continue;
    }

    closeList();
    // Paragraph/list margins provide spacing; blank lines must not become
    // visible content for empty or tool-only assistant messages.
    if (line.trim()) {
      output.push(`<p>${renderInline(line)}</p>`);
    }
  }

  closeList();
  if (inCode) {
    output.push(`<pre><code${codeLanguage ? ` class="language-${codeLanguage}"` : ""}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
  }
  return output.join("");
}

function renderInline(value: string): string {
  const codeSegments: string[] = [];
  let escaped = escapeHtml(value).replace(/`([^`]+)`/g, (_match, code: string) => {
    const index = codeSegments.push(`<code>${code}</code>`) - 1;
    return `\u0000${index}\u0000`;
  });
  escaped = escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  escaped = escaped.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return escaped.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => codeSegments[Number(index)] ?? "");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
