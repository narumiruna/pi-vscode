export type SessionActivityOutcome = "completed" | "failed" | "stopped";
export type SessionActivityStatus = "idle" | "running" | "waiting" | SessionActivityOutcome;

/** Current-window activity and unread results for one owned session. */
export class SessionActivity {
  private currentRequestId: string | undefined;
  private settledOutcome: SessionActivityOutcome | undefined;
  private runtimeBusy = false;
  private pendingDialogs = false;
  private currentResultRevision = 0;
  private currentAcknowledgedRevision = 0;

  public get status(): SessionActivityStatus {
    if (this.pendingDialogs) return "waiting";
    if (this.currentRequestId !== undefined || this.runtimeBusy) return "running";
    return this.settledOutcome ?? "idle";
  }

  public get resultRevision(): number {
    return this.currentResultRevision;
  }

  public get acknowledgedRevision(): number {
    return this.currentAcknowledgedRevision;
  }

  public get unread(): boolean {
    return this.currentResultRevision > this.currentAcknowledgedRevision;
  }

  public get activeRequestId(): string | undefined {
    return this.currentRequestId;
  }

  /** Request IDs must be unique within this instance's lifetime. */
  public begin(requestId: string): void {
    this.currentRequestId = requestId;
    this.settledOutcome = undefined;
  }

  /** The host calls this after request settlement, including queue reconciliation. */
  public finish(requestId: string, outcome: SessionActivityOutcome, hasResult: boolean): void {
    if (requestId !== this.currentRequestId) return;
    this.currentRequestId = undefined;
    this.settledOutcome = outcome;
    if (hasResult) this.currentResultRevision += 1;
  }

  public updateRuntime(state: { readonly busy: boolean; readonly pendingDialogs: boolean }): void {
    this.runtimeBusy = state.busy;
    this.pendingDialogs = state.pendingDialogs;
  }

  /** The caller must also validate the selected, visible, latest-following view. */
  public acknowledge(revision: number): boolean {
    if (!Number.isSafeInteger(revision) || revision < 0 || revision !== this.currentResultRevision) return false;
    this.currentAcknowledgedRevision = revision;
    return true;
  }
}
