import { createHash } from "node:crypto";

export const sessionDraftStorageKey = "pi.sidebar.drafts.v1";
export const draftLimits = { perDraft: 50_000, records: 20, total: 250_000, age: 7 * 24 * 60 * 60 * 1000 } as const;

export interface SessionDraft {
  readonly owner: string;
  readonly text: string;
  readonly updated: number;
}
interface DraftEnvelope {
  readonly version: 1;
  readonly consent: true;
  readonly records: readonly SessionDraft[];
}
export interface DraftMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

// Pi assigns a file before saving its header. That path, not its temporary ID, owns the draft.
export function sessionDraftOwner(sessionFile: string | undefined): string | undefined {
  return sessionFile && sessionFile.length <= 8192
    ? `session:${createHash("sha256").update(sessionFile).digest("hex")}`
    : undefined;
}
function validOwner(value: unknown): value is string {
  return value === "sessions" || (typeof value === "string" && /^session:[a-f0-9]{64}$/.test(value));
}
function record(value: unknown, now: number): SessionDraft | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).sort().join(",") !== "owner,text,updated" ||
    !validOwner(item.owner) ||
    typeof item.text !== "string" ||
    !item.text.length ||
    item.text.length > draftLimits.perDraft ||
    typeof item.updated !== "number" ||
    !Number.isSafeInteger(item.updated) ||
    item.updated > now ||
    item.updated <= now - draftLimits.age
  )
    return undefined;
  return { owner: item.owner, text: item.text, updated: item.updated };
}

/** Only allowlisted text records cross this persistence boundary. No browser object is stored. */
export class SessionDraftStore {
  private records: SessionDraft[] = [];
  private approved = false;
  private generation = 0;
  private written = 0;
  private writing: Promise<void> | undefined;

  public constructor(
    private readonly state: DraftMemento,
    private readonly failed: () => void,
    private readonly now: () => number = Date.now,
  ) {
    const value = state.get<unknown>(sessionDraftStorageKey);
    if (!value || typeof value !== "object") return;
    const envelope = value as Record<string, unknown>;
    if (
      envelope.version !== 1 ||
      envelope.consent !== true ||
      !Array.isArray(envelope.records) ||
      Object.keys(envelope).sort().join(",") !== "consent,records,version"
    )
      return;
    this.approved = true;
    // Bound processing even if the workspace memento was corrupted.
    this.records = envelope.records.slice(0, draftLimits.records).flatMap((item) => record(item, this.now()) ?? []);
    this.prune();
    // Existing approval permits bounded cleanup on activation, including expiry and malformed records.
    this.changed();
  }

  public get enabled(): boolean {
    return this.approved;
  }
  public enable(): void {
    this.approved = true;
    this.changed();
  }
  public disable(): void {
    this.approved = false;
    this.records = [];
    this.changed();
  }
  public get(owner: string): SessionDraft | undefined {
    const count = this.records.length;
    this.prune();
    if (count !== this.records.length && this.approved) this.changed();
    const found = this.records.find((item) => item.owner === owner);
    return found && { ...found };
  }
  public put(owner: string, text: string): void {
    if (!this.approved || !validOwner(owner) || typeof text !== "string" || text.length > draftLimits.perDraft) return;
    this.records = this.records.filter((item) => item.owner !== owner);
    if (text.length) this.records.push({ owner, text, updated: this.now() });
    this.prune();
    this.changed();
  }
  public remove(owner: string): void {
    if (!this.approved) return;
    this.records = this.records.filter((item) => item.owner !== owner);
    this.changed();
  }
  private prune(): void {
    const seen = new Set<string>();
    let characters = 0;
    this.records = this.records
      .filter((item) => item.updated > this.now() - draftLimits.age)
      .sort((a, b) => b.updated - a.updated || (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0))
      .filter((item) => {
        if (
          seen.has(item.owner) ||
          seen.size >= draftLimits.records ||
          characters + item.text.length > draftLimits.total
        )
          return false;
        seen.add(item.owner);
        characters += item.text.length;
        return true;
      });
  }
  private changed(): void {
    this.generation += 1;
    if (!this.writing) {
      // Coalesce synchronous mutations, including acceptance immediately following an update.
      this.writing = Promise.resolve()
        .then(() => this.drain())
        .finally(() => {
          this.writing = undefined;
          if (this.written !== this.generation) this.changed();
        });
    }
  }
  private async drain(): Promise<void> {
    while (this.written !== this.generation) {
      const generation = this.generation;
      this.prune();
      const value: DraftEnvelope | undefined = this.approved
        ? { version: 1, consent: true, records: this.records.map((item) => ({ ...item })) }
        : undefined;
      try {
        await this.state.update(sessionDraftStorageKey, value);
      } catch {
        this.failed();
        // Never retry an obsolete snapshot. A later explicit mutation can retry current state.
        if (generation === this.generation) {
          this.written = generation;
          return;
        }
      }
      this.written = generation;
    }
  }
  public async flush(): Promise<void> {
    while (this.writing) await this.writing;
  }
}
