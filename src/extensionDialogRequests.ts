import type { PiRpcEvent } from "./piRpcClient";

export const maxDialogTextCharacters = 100_000;
const maxPendingDialogs = 16;
const maxDialogIdsPerGeneration = 4096;
export type ExtensionDialogResponse = { value: string } | { confirmed: boolean } | { cancelled: true };

/** One origin and session generation. Exhaustion fails closed until the next generation. */
export class ExtensionDialogRequests {
  private readonly seen = new Set<string>();
  private readonly pending = new Set<ExtensionDialogRequest>();

  public accept(
    event: PiRpcEvent,
    send: (response: ExtensionDialogResponse) => void,
  ): ExtensionDialogRequest | undefined {
    const { id, method, timeout } = event;
    if (
      event.type !== "extension_ui_request" ||
      typeof method !== "string" ||
      !["select", "confirm", "input", "editor"].includes(method) ||
      typeof id !== "string" ||
      !id.length ||
      id.length > 256 ||
      this.seen.has(id) ||
      this.seen.size >= maxDialogIdsPerGeneration
    )
      return undefined;
    this.seen.add(id);
    const request = new ExtensionDialogRequest(send, () => this.pending.delete(request));
    if (
      this.pending.size >= maxPendingDialogs ||
      (timeout !== undefined &&
        (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 0 || timeout > 2_147_483_647))
    ) {
      request.respond({ cancelled: true });
      return undefined;
    }
    this.pending.add(request);
    if (typeof timeout === "number") request.expireAfter(timeout);
    return request;
  }

  public get hasPending(): boolean {
    return this.pending.size > 0;
  }

  public cancelPending(): void {
    let failure: unknown;
    for (const request of this.pending) {
      try {
        request.respond({ cancelled: true });
      } catch (error) {
        failure = error;
      }
    }
    if (failure) throw failure;
  }

  public invalidate(): void {
    for (const request of this.pending) request.end();
    this.pending.clear();
    this.seen.clear();
  }
}

export class ExtensionDialogRequest {
  private active = true;
  private timer: NodeJS.Timeout | undefined;
  private deadline: number | undefined;
  private readonly listeners = new Set<() => void>();

  public constructor(
    private readonly send: (response: ExtensionDialogResponse) => void,
    private readonly remove: () => void,
  ) {}

  public get isActive(): boolean {
    if (this.active && this.deadline !== undefined && Date.now() >= this.deadline) this.end();
    return this.active;
  }

  public onDidEnd(listener: () => void): { dispose(): void } {
    if (!this.isActive) listener();
    else this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  public expireAfter(timeout: number): void {
    // Pi owns the timeout default. Never send a late local cancellation.
    this.deadline = Date.now() + timeout;
    this.timer = setTimeout(() => this.end(), timeout);
  }

  public respond(response: ExtensionDialogResponse): void {
    if (!this.isActive) return;
    this.end(); // A failed write cannot make this response retryable.
    this.send(response);
  }

  public end(): void {
    if (!this.active) return;
    this.active = false;
    clearTimeout(this.timer);
    this.remove();
    for (const listener of this.listeners) listener();
    this.listeners.clear();
  }
}
