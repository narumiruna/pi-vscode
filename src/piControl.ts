import { realpath } from "node:fs/promises";

export const controlCommand = "vscode-pi-control";
export const controlResultPrefix = "PI_VSCODE_CONTROL_RESULT:";
export const packagedCommands = [
  [controlCommand, "pi-control.ts"],
  ["vscode-pi-bridge-ready", "pi-bridge.ts"],
  ["vscode-pi-permission-ready", "pi-permission-gate.ts"],
  ["vscode-pi-read-only-ready", "pi-read-only-gate.ts"],
] as const;

/** Discovery is read-only. Never dispatch an absent or shadowed command as a prompt. */
export async function verifyPackagedCommands(commands: readonly unknown[], resources: string): Promise<void> {
  const path = await import("node:path");
  for (const [name, file] of packagedCommands) {
    const matches = commands.filter((value) => isRecord(value) && value.name === name);
    const command = matches[0];
    if (matches.length !== 1 || !isRecord(command) || command.source !== "extension" || !isRecord(command.sourceInfo))
      throw new Error(`Unsupported Pi control route: missing or conflicting ${name}. Pi 1.3.0 metadata is required.`);
    const source = command.sourceInfo.path;
    if (typeof source !== "string" || (await realpath(source)) !== (await realpath(path.join(resources, file))))
      throw new Error(`Unsupported Pi control route: ${name} is not owned by the packaged resource.`);
  }
}

export interface PiTreeEntry {
  readonly id: string;
  readonly parentId: string | null;
  readonly type: string;
  readonly role?: string;
  readonly text: string;
  readonly label?: string;
  readonly depth: number;
}
export interface PiSessionTree {
  readonly entries: readonly PiTreeEntry[];
  readonly leafId: string | null;
}

/** Iterative, bounded validation; never recurse through extension-supplied trees. */
export function parseSessionTree(data: unknown): PiSessionTree {
  if (!isRecord(data) || !Array.isArray(data.tree) || !validLeaf(data.leafId))
    throw new Error("Invalid Pi session tree.");
  const entries: PiTreeEntry[] = [];
  const ids = new Set<string>();
  const objects = new Set<unknown>();
  const stack = data.tree
    .map((node: unknown) => ({ node, depth: 0, parent: undefined as string | undefined }))
    .reverse();
  while (stack.length) {
    const { node, depth, parent } = stack.pop()!;
    if (entries.length >= 2_000 || depth > 100 || objects.has(node))
      throw new Error("Pi session tree exceeds 2,000 entries / 100 levels or contains a cycle.");
    objects.add(node);
    if (!isRecord(node) || !isRecord(node.entry) || !Array.isArray(node.children))
      throw new Error("Invalid Pi session tree node.");
    const entry = node.entry;
    if (!validId(entry.id) || !validLeaf(entry.parentId) || typeof entry.type !== "string" || ids.has(entry.id))
      throw new Error("Invalid or duplicate Pi entry identity.");
    if (parent !== undefined && entry.parentId !== parent) throw new Error("Pi tree parent mismatch.");
    ids.add(entry.id);
    const message = isRecord(entry.message) ? entry.message : undefined;
    entries.push({
      id: entry.id,
      parentId: entry.parentId,
      type: entry.type.slice(0, 100),
      role: typeof message?.role === "string" ? message.role.slice(0, 100) : undefined,
      text: contentText(
        message?.content ?? entry.content ?? entry.summary,
        message?.role === "user" || entry.type === "custom_message",
      ),
      label: typeof node.label === "string" ? node.label.slice(0, 200) : undefined,
      depth,
    });
    if (stack.length + node.children.length + entries.length > 2_000)
      throw new Error("Pi session tree exceeds 2,000 entries.");
    for (let index = node.children.length - 1; index >= 0; index--)
      stack.push({ node: node.children[index], depth: depth + 1, parent: entry.id });
  }
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  for (const entry of entries) {
    const parent = entry.parentId === null ? undefined : byId.get(entry.parentId);
    if (parent && entry.depth !== parent.depth + 1) throw new Error("Pi tree parent chain is cyclic or inconsistent.");
  }
  if (data.leafId !== null && !ids.has(data.leafId)) throw new Error("Pi tree leaf is missing.");
  return { entries, leafId: data.leafId };
}
export function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9._-]{1,200}$/.test(value);
}
function validLeaf(value: unknown): value is string | null {
  return value === null || validId(value);
}
function contentText(content: unknown, complete: boolean): string {
  const limit = complete ? 50_000 : 10_000;
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    for (const part of content) {
      if (isRecord(part) && part.type === "text" && typeof part.text === "string") text += part.text;
      if (text.length > limit) break;
    }
  }
  if (complete && text.length > limit) throw new Error("Pi branch draft exceeds 50,000 characters.");
  return text.slice(0, limit);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
