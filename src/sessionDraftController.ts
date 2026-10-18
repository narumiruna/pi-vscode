import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { draftLimits, type SessionDraftStore, sessionDraftOwner } from "./sessionDraftStore";

export type SessionDraftMessage =
  | { readonly type: "draftSelect"; readonly scope: "sessions" | "session" }
  | { readonly type: "draftEnable" | "draftDisable"; readonly binding: string }
  | { readonly type: "draftChanged"; readonly binding: string; readonly revision: number; readonly text: string }
  | {
      readonly type: "draftRestore" | "draftDiscard" | "draftOversized";
      readonly binding: string;
      readonly revision: number;
    };

export function isSessionDraftMessage(input: unknown): input is SessionDraftMessage {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  const type = value.type;
  if (type === "draftSelect")
    return Object.keys(value).length === 2 && ["sessions", "session"].includes(String(value.scope));
  if (typeof value.binding !== "string" || !/^[a-f0-9-]{36}$/.test(value.binding)) return false;
  if (type === "draftEnable" || type === "draftDisable") return Object.keys(value).length === 2;
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) return false;
  if (type === "draftChanged")
    return (
      Object.keys(value).length === 4 && typeof value.text === "string" && value.text.length <= draftLimits.perDraft
    );
  return (
    (type === "draftRestore" || type === "draftDiscard" || type === "draftOversized") && Object.keys(value).length === 3
  );
}

interface Binding {
  readonly id: string;
  readonly owner: string | undefined;
  revision: number;
  accepted: number;
  recovery: boolean;
  restoration?: { readonly revision: number; readonly text: string };
}
interface Submission {
  readonly binding: Binding;
  readonly revision: number;
  readonly text: string;
}

export class SessionDraftController {
  private binding: Binding | undefined;
  private scope: "sessions" | "session" = "sessions";
  private alive = false;
  private consentPending = false;
  private consentGeneration = 0;
  private readonly submission = new AsyncLocalStorage<Submission>();
  private readonly recordWriters = new Map<string, Binding>();
  private readonly deleted = new Set<string>();

  public constructor(
    private readonly store: SessionDraftStore,
    private readonly sessionFile: () => string | undefined,
    private readonly post: (message: Record<string, unknown>) => void,
    private readonly consent: () => Promise<boolean>,
  ) {}

  public beginView(): void {
    this.alive = true;
    this.scope = "sessions";
    this.binding = undefined;
    this.refresh();
  }
  public endView(): void {
    this.alive = false;
    this.binding = undefined;
    this.consentGeneration += 1;
  }
  public refresh(): void {
    if (!this.alive) return;
    const owner = this.scope === "sessions" ? "sessions" : sessionDraftOwner(this.sessionFile());
    if (this.binding && this.binding.owner === owner) return;
    this.binding = {
      id: randomUUID(),
      owner,
      revision: -1,
      accepted: -1,
      recovery: Boolean(owner && this.store.get(owner)),
    };
    this.publish(true);
  }
  public ready(): void {
    this.publish(true);
  }
  private publish(reset = false): void {
    if (!this.alive || !this.binding) return;
    this.post({
      type: "draftState",
      binding: this.binding.id,
      enabled: this.store.enabled,
      available: this.binding.recovery,
      writable: Boolean(this.binding.owner),
      reset,
    });
  }
  public async handle(message: SessionDraftMessage): Promise<void> {
    if (!this.alive) return;
    if (message.type === "draftSelect") {
      this.scope = message.scope;
      this.refresh();
      this.publish();
      return;
    }
    const binding = this.binding;
    if (!binding || binding.id !== message.binding) return;
    if (message.type === "draftEnable") {
      if (this.store.enabled || this.consentPending) return;
      this.consentPending = true;
      const generation = ++this.consentGeneration;
      try {
        const approved = await this.consent();
        if (approved && generation === this.consentGeneration && this.alive && this.binding === binding)
          this.store.enable();
      } finally {
        this.consentPending = false;
      }
      this.publish();
      return;
    }
    if (message.type === "draftDisable") {
      this.consentGeneration += 1;
      this.store.disable();
      this.recordWriters.clear();
      this.binding = {
        ...binding,
        id: randomUUID(),
        revision: -1,
        accepted: -1,
        recovery: false,
        restoration: undefined,
      };
      this.publish();
      return;
    }
    if (!("revision" in message)) return;
    if (
      message.revision < binding.revision ||
      message.revision <= binding.accepted ||
      !binding.owner ||
      this.deleted.has(binding.owner)
    )
      return;
    if (message.type === "draftChanged" && message.revision === binding.revision) return;
    binding.revision = message.revision;
    if (message.type === "draftOversized") return;
    if (message.type === "draftChanged") {
      if (
        binding.restoration &&
        message.revision === binding.restoration.revision + 1 &&
        message.text === binding.restoration.text
      ) {
        binding.recovery = false;
        binding.restoration = undefined;
        this.publish();
      }
      if (!binding.recovery) {
        this.recordWriters.set(binding.owner, binding);
        this.store.put(binding.owner, message.text);
        for (const owner of this.recordWriters.keys()) if (!this.store.get(owner)) this.recordWriters.delete(owner);
      }
    } else if (message.type === "draftDiscard") {
      this.store.remove(binding.owner);
      binding.recovery = false;
      this.publish();
    } else if (message.type === "draftRestore") {
      const draft = this.store.get(binding.owner);
      if (!binding.recovery || !draft) {
        binding.recovery = false;
        this.publish();
        return;
      }
      binding.restoration = { revision: message.revision, text: draft.text };
      this.post({ type: "draftRestored", binding: binding.id, expectedRevision: message.revision, text: draft.text });
      // Keep the record protected until the browser confirms insertion with the next revision.
    }
  }
  public runMessage(message: unknown, operation: () => Promise<void>): Promise<void> {
    const item = message as Record<string, unknown> | null;
    if (
      !this.binding ||
      !item ||
      typeof item !== "object" ||
      !["send", "sendNewSession", "queueInstruction", "runBackground", "showMoreActions"].includes(String(item.type)) ||
      !Number.isSafeInteger(item.revision) ||
      typeof item.text !== "string"
    )
      return operation();
    return this.submission.run(
      { binding: this.binding, revision: item.revision as number, text: item.text },
      operation,
    );
  }
  public accepted(revision: number, text: string): string | undefined {
    const submission = this.submission.getStore();
    if (!submission || submission.revision !== revision || submission.text !== text) return undefined;
    const binding = submission.binding;
    binding.accepted = Math.max(binding.accepted, revision);
    const owner = binding.owner;
    const writer = owner && this.recordWriters.get(owner);
    if (owner && (!writer || writer === binding) && binding.revision <= revision && !binding.recovery) {
      this.store.remove(owner);
      if (this.binding?.owner === owner && this.binding !== binding) {
        this.binding.recovery = false;
        this.publish();
      }
    }
    return binding.id;
  }
  public deleteSession(sessionFile: string | undefined): void {
    const owner = sessionDraftOwner(sessionFile);
    if (!owner) return;
    this.deleted.add(owner);
    // Old messages also need the current random binding. Tombstones are an additional bounded guard.
    if (this.deleted.size > draftLimits.records) {
      const oldest = this.deleted.values().next().value;
      if (oldest) this.deleted.delete(oldest);
    }
    this.recordWriters.delete(owner);
    this.store.remove(owner);
    if (this.binding?.owner === owner) {
      this.binding.recovery = false;
      this.publish();
    }
  }
}
