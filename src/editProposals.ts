import { randomUUID } from "node:crypto";
import type { EditProposalInput } from "./conversationController";

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
}

interface EditProposalEntry {
  state: EditProposalState;
  readonly input: EditProposalInput;
  disposed: boolean;
}

export class EditProposalStore {
  private readonly proposals = new Map<string, EditProposalEntry>();

  public constructor(
    private readonly onChange: () => void,
    private readonly onNotice: (message: string, level: "info" | "warning" | "error") => void,
  ) {}

  public get states(): EditProposalState[] {
    return [...this.proposals.values()].map(proposal => proposal.state);
  }

  public add(input: EditProposalInput): string {
    const id = randomUUID();
    this.proposals.set(id, {
      state: { id, label: input.label, status: "ready" },
      input,
      disposed: false,
    });
    this.onChange();
    return id;
  }

  public async handleAction(id: string, action: "preview" | "apply" | "reject"): Promise<void> {
    const proposal = this.proposals.get(id);
    if (!proposal) {
      throw new Error("This edit proposal is no longer available. Regenerate it from the conversation.");
    }
    if (["previewing", "applying", "rejecting"].includes(proposal.state.status)) {
      throw new Error(`Wait for the current ${proposal.state.status} operation to finish.`);
    }
    if (["applied", "rejected", "stale"].includes(proposal.state.status)) {
      throw new Error(`This edit proposal is already ${proposal.state.status}.`);
    }

    if (action === "reject") {
      proposal.state = { ...proposal.state, status: "rejecting", error: undefined };
      this.onChange();
      try {
        await proposal.input.onReject?.();
        proposal.state = { ...proposal.state, status: "rejected" };
        this.release(proposal);
      } catch (error) {
        proposal.state = { ...proposal.state, status: "failed", error: formatError(error) };
      }
      this.onChange();
      return;
    }

    if (action === "preview") {
      proposal.state = { ...proposal.state, status: "previewing", error: undefined };
      this.onChange();
      try {
        await proposal.input.onPreview();
        proposal.state = { ...proposal.state, status: "previewed" };
      } catch (error) {
        const message = formatError(error);
        const stale = isStaleError(message);
        proposal.state = { ...proposal.state, status: stale ? "stale" : "failed", error: message };
        if (stale) this.release(proposal);
        this.onNotice(message, "error");
      }
      this.onChange();
      return;
    }

    if (proposal.state.status !== "previewed") {
      throw new Error("Preview the edit before applying it.");
    }
    proposal.state = { ...proposal.state, status: "applying", error: undefined };
    this.onChange();
    try {
      await proposal.input.onApply();
      proposal.state = { ...proposal.state, status: "applied" };
      this.release(proposal);
      this.onNotice("Pi edit applied. Use Undo to revert it.", "info");
    } catch (error) {
      const message = formatError(error);
      const stale = isStaleError(message);
      proposal.state = { ...proposal.state, status: stale ? "stale" : "failed", error: message };
      if (stale) this.release(proposal);
      this.onNotice(message, "error");
    }
    this.onChange();
  }

  public clear(): void {
    for (const proposal of this.proposals.values()) {
      this.release(proposal);
    }
    this.proposals.clear();
    this.onChange();
  }

  private release(proposal: EditProposalEntry): void {
    if (proposal.disposed) return;
    proposal.disposed = true;
    try {
      const result = proposal.input.onDispose?.();
      if (result) void result.catch(error => this.onNotice(formatError(error), "warning"));
    } catch (error) {
      this.onNotice(formatError(error), "warning");
    }
  }
}

function isStaleError(message: string): boolean {
  return /changed|stale|regenerate/i.test(message);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
