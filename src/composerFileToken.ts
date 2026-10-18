export interface ComposerFileToken {
  readonly kind: "attachment" | "path";
  readonly start: number;
  readonly end: number;
  readonly cursor: number;
  readonly query: string;
}

/** Self-contained so the host and inline webview use exactly the same grammar. */
export function composerFileToken(
  text: string,
  cursor: number,
  selectionEnd = cursor,
  composing = false,
): ComposerFileToken | undefined {
  if (
    composing ||
    text.length > 100_000 ||
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    cursor > text.length ||
    selectionEnd !== cursor ||
    /^[!/]/.test(text.trimStart())
  )
    return undefined;
  // Tokens start after whitespace or an opening bracket. Quotes must enclose a whole path.
  const pattern = /(?:^|[\s([{])(@?"[^"\r\n]*"?|@?'[^'\r\n]*'?|[^\s()[\]{},;!?"']+)/gu;
  for (const match of text.matchAll(pattern)) {
    const raw = match[1];
    if (!raw || match.index === undefined) continue;
    const start = match.index + match[0].length - raw.length;
    const end = start + raw.length;
    if (cursor <= start || cursor > end) continue;
    const attachment = raw.startsWith("@");
    let value = raw.slice(attachment ? 1 : 0);
    const quote = value[0] === '"' || value[0] === "'" ? value[0] : "";
    const contentStart = start + (attachment ? 1 : 0) + (quote ? 1 : 0);
    if (cursor < contentStart) continue;
    if (quote) value = value.slice(1).replace(new RegExp(`${quote}$`), "");
    if (value.includes("@") || /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(value)) continue;
    if (!attachment && !/[./\\]/.test(value)) continue;
    let query = text.slice(contentStart, cursor).replace(/['"]$/, "").replace(/\\/g, "/");
    query = query.replace(/^\.\//, "");
    if (query.length > 256 || /[:*?{}[\]]/.test(query) || query.startsWith("/") || query.split("/").includes(".."))
      continue;
    return { kind: attachment ? "attachment" : "path", start, end, cursor, query };
  }
  return undefined;
}

export interface FileCompletionRequest {
  readonly type: "fileCompletionQuery";
  readonly id: number;
  readonly revision: number;
  readonly text: string;
  readonly token: ComposerFileToken;
}

export type FileCompletionMessage =
  | FileCompletionRequest
  | { readonly type: "fileCompletionCancel" }
  | {
      readonly type: "fileCompletionSelect";
      readonly id: number;
      readonly revision: number;
      readonly candidateId: string;
    };

export function isFileCompletionMessage(
  value: Record<string, unknown>,
): value is Record<string, unknown> & FileCompletionMessage {
  if (value.type === "fileCompletionCancel") return true;
  if (!["fileCompletionQuery", "fileCompletionSelect"].includes(String(value.type))) return false;
  if (
    !Number.isSafeInteger(value.id) ||
    Number(value.id) < 1 ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 0
  )
    return false;
  if (value.type === "fileCompletionSelect")
    return typeof value.candidateId === "string" && /^[a-f0-9-]{36}$/.test(value.candidateId);
  if (typeof value.text !== "string" || value.text.length > 100_000 || !value.token || typeof value.token !== "object")
    return false;
  const token = value.token as ComposerFileToken;
  const parsed = composerFileToken(value.text, token.cursor);
  return (
    !!parsed &&
    ["kind", "start", "end", "cursor", "query"].every(
      (key) => parsed[key as keyof ComposerFileToken] === token[key as keyof ComposerFileToken],
    )
  );
}
