import { randomUUID } from "node:crypto";
import { digest } from "./gitSnapshots";

export interface CheckpointFile { readonly path: string; readonly before: string; readonly after: string; reverted?: boolean }
export interface RequestCheckpoint {
  readonly id: string; readonly repository: string; readonly sessionId: string; readonly startedAt: number; readonly completedAt: number;
  readonly status: "completed" | "cancelled" | "process-exit"; readonly files: CheckpointFile[]; readonly exclusions: readonly string[];
  restoreFailed?: boolean;
}
export class CheckpointHistory {
  private records: RequestCheckpoint[] = [];
  public get values(): readonly RequestCheckpoint[] { return this.records; }
  public get retainedBytes(): number { return this.records.reduce((total, item) => total + item.files.reduce((sum, file) => sum + Buffer.byteLength(file.before) + Buffer.byteLength(file.after), 0), 0); }
  public add(input: Omit<RequestCheckpoint, "id">): RequestCheckpoint {
    const record = { ...input, id: randomUUID(), files: input.files.map(file => ({ ...file })) };
    let bytes = 0;
    const excluded = [...record.exclusions];
    record.files = record.files.filter(file => {
      const before = Buffer.byteLength(file.before), after = Buffer.byteLength(file.after);
      if (before > 2 * 1024 * 1024 || after > 2 * 1024 * 1024 || bytes + before + after > 20 * 1024 * 1024) { excluded.push(`${file.path}: retained snapshot limit`); return false; }
      bytes += before + after;
      return true;
    });
    const stored = { ...record, exclusions: excluded };
    this.records.push(stored);
    while (this.records.length > 20 || this.retainedBytes > 20 * 1024 * 1024) {
      const index = this.records.findIndex(item => !item.restoreFailed);
      if (index < 0) break;
      this.records.splice(index, 1);
    }
    // Recovery-protected older records can force the incoming record out. Do not
    // return its text to a caller that would retain it outside the history budget.
    if (!this.records.includes(stored)) {
      stored.files = [];
      stored.exclusions = [...stored.exclusions, "History capacity reserved for unresolved recovery snapshots; this request was not retained."];
    }
    return stored;
  }
  public require(id: string): RequestCheckpoint {
    const result = this.records.find(item => item.id === id);
    if (!result) throw new Error("Request checkpoint expired (memory-only, bounded history).");
    return result;
  }
  public assertRestorable(id: string, selected: readonly string[], current: (file: string) => { text?: string; dirty: boolean }): void {
    const record = this.require(id);
    if (!selected.length || new Set(selected).size !== selected.length) throw new Error("Select covered checkpoint files.");
    for (const filePath of selected) {
      const file = record.files.find(file => file.path === filePath);
      if (!file || file.reverted) throw new Error("This file is not covered or was already reverted.");
      const later = this.records.slice(this.records.indexOf(record) + 1).some(item => item.repository === record.repository && item.files.some(other => other.path === filePath && !other.reverted));
      if (later) throw new Error("Revert newer dependent checkpoints first.");
      const resource = current(filePath);
      if (resource.dirty || resource.text === undefined || digest(resource.text) !== digest(file.after)) throw new Error("Checkpoint file is stale or has a dirty editor buffer.");
    }
  }
  public clear(): void { this.records = []; }
}

/** Compute exactly what a supported Pi tool announced, independently of event arrival order. */
export function expectedToolText(before: string, tool: string, args: Record<string, unknown>): string | undefined {
  if (tool === "write") return typeof args.content === "string" ? args.content : undefined;
  if (tool !== "edit") return undefined;
  const edits = Array.isArray(args.edits) ? args.edits : [args];
  let text = before;
  for (const item of edits) {
    if (!item || typeof item !== "object") return undefined;
    const edit = item as Record<string, unknown>;
    const oldText = edit.oldText ?? edit.old_text, newText = edit.newText ?? edit.new_text;
    if (typeof oldText !== "string" || !oldText || typeof newText !== "string") return undefined;
    const offset = text.indexOf(oldText);
    if (offset < 0 || text.indexOf(oldText, offset + oldText.length) >= 0) return undefined;
    text = text.slice(0, offset) + newText + text.slice(offset + oldText.length);
  }
  return text;
}
