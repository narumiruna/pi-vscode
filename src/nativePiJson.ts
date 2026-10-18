/** Strict native JSON with bounded nesting and duplicate-key rejection. No JSONC conversion. */
export function nativeObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
interface Member {
  key: string;
  start: number;
  valueStart: number;
  end: number;
}

function members(text: string): Member[] {
  const result: Member[] = [];
  let i = text.indexOf("{") + 1;
  const white = () => {
    while (/\s/.test(text[i] ?? "") && i < text.length) i++;
  };
  const stringEnd = () => {
    i++;
    while (i < text.length) {
      if (text[i++] === "\\") i++;
      else if (text[i - 1] === '"') return;
    }
  };
  white();
  while (i < text.length && text[i] !== "}") {
    const start = i;
    stringEnd();
    const key = JSON.parse(text.slice(start, i)) as string;
    white();
    i++; // colon (syntax is checked by JSON.parse before scanning)
    white();
    const valueStart = i;
    let depth = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '"') stringEnd();
      else if (ch === "{" || ch === "[") {
        depth++;
        i++;
      } else if (ch === "}" || ch === "]") {
        if (depth === 0) break;
        depth--;
        i++;
      } else if (ch === "," && depth === 0) break;
      else i++;
    }
    let end = i;
    while (/\s/.test(text[end - 1] ?? "")) end--;
    result.push({ key, start, valueStart, end });
    white();
    if (text[i] !== ",") break;
    i++;
    white();
  }
  if (new Set(result.map((member) => member.key)).size !== result.length)
    throw new Error("Duplicate native configuration keys are not supported.");
  return result;
}

export function parseNativeJson(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    let depth = 0;
    // Reject deep input before JSON.parse/reviver recursion. Strings are skipped.
    const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}[\]]/g) ?? [];
    for (const token of tokens) {
      if (token === "{" || token === "[") {
        if (++depth > 32) throw new Error();
      } else if (token === "}" || token === "]") depth--;
    }
    value = JSON.parse(text);
  } catch {
    throw new Error("Native configuration must be a JSON object (maximum depth 32).");
  }
  if (!nativeObject(value)) throw new Error("Native configuration must be a JSON object.");
  const inspect = (source: string, object: Record<string, unknown>) => {
    for (const member of members(source)) {
      if (["__proto__", "constructor", "prototype"].includes(member.key))
        throw new Error("Unsafe native configuration key.");
      const child = object[member.key];
      if (nativeObject(child)) inspect(source.slice(member.valueStart, member.end), child);
    }
  };
  inspect(text, value);
  return value;
}

/** Change only the selected member. Untouched member bytes and ordering remain intact. */
export function patchNativeJson(text: string, keys: readonly string[], value: unknown): string {
  const object = parseNativeJson(text);
  const [key, ...rest] = keys;
  if (!key || ["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Unsupported native key.");
  const entries = members(text);
  const index = entries.findIndex((member) => member.key === key);
  const member = entries[index];
  if (rest.length) {
    if (member && !nativeObject(object[key])) throw new Error("The selected native parent is not an object.");
    if (!member && value === undefined) return text;
    const nested = patchNativeJson(member ? text.slice(member.valueStart, member.end) : "{}", rest, value);
    return member
      ? text.slice(0, member.valueStart) + nested + text.slice(member.end)
      : patchNativeJson(text, [key], JSON.parse(nested));
  }
  if (member) {
    if (value !== undefined) return text.slice(0, member.valueStart) + JSON.stringify(value) + text.slice(member.end);
    if (entries.length === 1) return text.slice(0, member.start) + text.slice(member.end);
    if (index < entries.length - 1) return text.slice(0, member.start) + text.slice(entries[index + 1].start);
    return text.slice(0, entries[index - 1].end) + text.slice(member.end);
  }
  if (value === undefined) return text;
  const end = text.lastIndexOf("}");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indent = text.match(/\n([\t ]+)"/)?.[1] ?? "  ";
  return `${text.slice(0, end).trimEnd()}${entries.length ? "," : ""}${eol}${indent}${JSON.stringify(key)}: ${JSON.stringify(value)}${eol}${text.slice(end)}`;
}
