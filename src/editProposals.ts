import { randomUUID } from "node:crypto";
import type { EditProposalInput } from "./conversationController";
import { acquireOperation } from "./operationLocks";

export type EditProposalStatus =
  | "ready"
  | "previewing"
  | "previewed"
  | "applying"
  | "rejecting"
  | "applied"
  | "rejected"
  | "stale"
  | "failed";

export interface EditProposalState {
  readonly id: string;
  readonly label: string;
  readonly status: EditProposalStatus;
  readonly error?: string;
  readonly selectionRevision?: number;
  readonly selected?: readonly string[];
  readonly totalHunks?: number;
  readonly summary?: string;
}

interface EditProposalEntry {
  state: EditProposalState;
  input?: EditProposalInput;
  disposed: boolean;
}

const maxTerminalProposals = 20;

export class EditProposalStore {
  private readonly proposals = new Map<string, EditProposalEntry>();
  private applyInProgress = false;

  public constructor(
    private readonly onChange: () => void,
    private readonly onNotice: (message: string, level: "info" | "warning" | "error") => void,
  ) {}

  public get states(): EditProposalState[] {
    return [...this.proposals.values()].map((proposal) => proposal.state);
  }

  public add(input: EditProposalInput): string {
    const id = randomUUID();
    this.proposals.set(id, {
      state: {
        id,
        label: input.label,
        status: "ready",
        ...(input.hunks
          ? { selectionRevision: 0, selected: input.hunks.map((hunk) => hunk.id), totalHunks: input.hunks.length }
          : {}),
      },
      input,
      disposed: false,
    });
    this.onChange();
    return id;
  }

  public hunkChoices(id: string): readonly { id: string; label: string; picked: boolean }[] {
    const proposal = this.proposals.get(id);
    if (!proposal?.input?.hunks) throw new Error("Hunk selection is unavailable for this proposal.");
    return proposal.input.hunks.map((hunk) => ({
      ...hunk,
      picked: proposal.state.selected?.includes(hunk.id) ?? false,
    }));
  }

  public select(id: string, ids: readonly string[]): void {
    const proposal = this.proposals.get(id);
    if (!proposal?.input?.hunks || !["ready", "previewed", "failed"].includes(proposal.state.status))
      throw new Error("This proposal cannot change selection now.");
    if (new Set(ids).size !== ids.length || ids.some((id) => !proposal.input!.hunks!.some((hunk) => hunk.id === id)))
      throw new Error("Invalid hunk identifiers.");
    proposal.state = {
      ...proposal.state,
      selected: [...ids],
      selectionRevision: (proposal.state.selectionRevision ?? 0) + 1,
      status: "ready",
      error: undefined,
    };
    this.onChange();
  }

  public async handleLockedAction(id: string, action: "preview" | "apply" | "reject", root: string): Promise<void> {
    // Multi-file adapters own their captured-root Apply lock; never acquire it twice.
    const adapterOwnsLock = action === "apply" && this.proposals.get(id)?.input?.managesApplyLock;
    const release = adapterOwnsLock ? undefined : acquireOperation(root, "edit proposal action");
    try {
      await this.handleAction(id, action);
    } finally {
      release?.();
    }
  }

  public async handleAction(id: string, action: "preview" | "apply" | "reject"): Promise<void> {
    const proposal = this.proposals.get(id);
    if (!proposal) {
      throw new Error("This edit proposal is no longer available. Regenerate it from the conversation.");
    }
    if (action === "apply" && this.applyInProgress) {
      throw new Error("Wait for the current edit Apply operation to finish.");
    }
    if (["previewing", "applying", "rejecting"].includes(proposal.state.status)) {
      throw new Error(`Wait for the current ${proposal.state.status} operation to finish.`);
    }
    if (["applied", "rejected", "stale"].includes(proposal.state.status)) {
      throw new Error(`This edit proposal is already ${proposal.state.status}.`);
    }
    const input = proposal.input;
    if (!input) {
      throw new Error("This edit proposal is no longer available. Regenerate it from the conversation.");
    }

    if (action === "reject") {
      proposal.state = { ...proposal.state, status: "rejecting", error: undefined };
      this.onChange();
      try {
        await input.onReject?.();
        proposal.state = { ...proposal.state, status: "rejected" };
        this.release(proposal);
        this.pruneTerminalStates();
      } catch (error) {
        proposal.state = { ...proposal.state, status: "failed", error: formatError(error) };
      }
      this.onChange();
      return;
    }

    if (action === "preview") {
      if (proposal.state.selected?.length === 0) {
        throw new Error("Select at least one hunk before Preview.");
      }
      proposal.state = { ...proposal.state, status: "previewing", error: undefined };
      this.onChange();
      try {
        await input.onPreview(proposal.state.selected);
        if (proposal.disposed) return;
        proposal.state = { ...proposal.state, status: "previewed" };
      } catch (error) {
        const message = formatError(error);
        const stale = isStaleError(message);
        proposal.state = { ...proposal.state, status: stale ? "stale" : "failed", error: message };
        if (stale) {
          this.release(proposal);
          this.pruneTerminalStates();
        }
        this.onNotice(message, "error");
      }
      this.onChange();
      return;
    }

    if (proposal.state.status !== "previewed") {
      throw new Error("Preview the edit before applying it.");
    }
    this.applyInProgress = true;
    proposal.state = { ...proposal.state, status: "applying", error: undefined };
    this.onChange();
    try {
      await input.onApply(proposal.state.selected);
      if (proposal.disposed) return;
      const selectedCount = proposal.state.selected?.length;
      const totalHunks = proposal.state.totalHunks;
      const summary =
        selectedCount === undefined || totalHunks === undefined
          ? "Applied whole edit."
          : selectedCount === totalHunks
            ? `Applied ${selectedCount}/${totalHunks} hunks.`
            : `Applied ${selectedCount}/${totalHunks} hunks; ${totalHunks - selectedCount} not applied.`;
      proposal.state = { ...proposal.state, status: "applied", summary };
      this.release(proposal);
      this.pruneTerminalStates();
      this.onNotice("Pi edit applied. Use Undo to revert it.", "info");
    } catch (error) {
      const message = formatError(error);
      const stale = isStaleError(message);
      proposal.state = { ...proposal.state, status: stale ? "stale" : "failed", error: message };
      if (stale) {
        this.release(proposal);
        this.pruneTerminalStates();
      }
      this.onNotice(message, "error");
    } finally {
      this.applyInProgress = false;
      this.onChange();
    }
  }

  public clear(): void {
    for (const proposal of this.proposals.values()) {
      this.release(proposal);
    }
    this.proposals.clear();
    this.onChange();
  }

  private release(proposal: EditProposalEntry): void {
    const input = proposal.input;
    proposal.input = undefined;
    if (proposal.disposed || !input) return;
    proposal.disposed = true;
    try {
      const result = input.onDispose?.();
      if (result) void result.catch((error) => this.onNotice(formatError(error), "warning"));
    } catch (error) {
      this.onNotice(formatError(error), "warning");
    }
  }

  private pruneTerminalStates(): void {
    const terminalIds = [...this.proposals.values()]
      .filter((proposal) => ["applied", "rejected", "stale"].includes(proposal.state.status))
      .map((proposal) => proposal.state.id);
    for (const id of terminalIds.slice(0, -maxTerminalProposals)) {
      this.proposals.delete(id);
    }
  }
}

function isStaleError(message: string): boolean {
  return /changed|stale|regenerate/i.test(message);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
