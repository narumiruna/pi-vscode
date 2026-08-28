import type * as vscode from "vscode";
import type { AgentRequestPolicy, ChatReferenceContext } from "./prompts";
import type { PiAgentMode } from "./runtimeProfiles";

export interface ConversationRequestOptions {
  readonly instructions?: string;
  readonly resource?: vscode.Uri;
  readonly policy?: AgentRequestPolicy;
  readonly onResponse?: (response: string) => Promise<void> | void;
}

export interface EditProposalInput {
  readonly label: string;
  readonly onPreview: () => Promise<void>;
  readonly onApply: () => Promise<void>;
  readonly onReject?: () => Promise<void> | void;
  readonly onDispose?: () => Promise<void> | void;
}

export interface PiConversationController {
  sendRequest(
    request: string,
    contexts: readonly ChatReferenceContext[],
    options?: ConversationRequestOptions,
  ): Promise<string>;
  addEditProposal(input: EditProposalInput): string;
}

export class ExclusiveOperationGate {
  private pending = false;

  public constructor(private readonly conflictMessage: string) {}

  public get isPending(): boolean {
    return this.pending;
  }

  public acquire(): () => void {
    if (this.pending) {
      throw new Error(this.conflictMessage);
    }
    this.pending = true;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.pending = false;
      }
    };
  }
}

export class ConversationRequestGate extends ExclusiveOperationGate {
  public constructor() {
    super("Pi is already working. Cancel or wait for the active request before starting another one.");
  }
}

export type ConversationRequestOrigin = "editor" | "composer" | "retry";

export interface ConversationRequestBehavior {
  readonly retryable: boolean;
  readonly clearComposerOnAccepted: boolean;
}

export function conversationRequestBehavior(origin: ConversationRequestOrigin): ConversationRequestBehavior {
  return {
    retryable: origin !== "editor",
    clearComposerOnAccepted: origin === "composer",
  };
}

export class ConversationResponseCapture {
  private assistantText: string | undefined;

  public accept(event: unknown): void {
    if (!isRecord(event) || event.type !== "message_end") {
      return;
    }
    const text = assistantMessageText(event.message);
    if (text !== undefined) {
      this.assistantText = text;
    }
  }

  public get response(): string | undefined {
    return this.assistantText;
  }
}

export class ConversationRequestLifecycle {
  private cancellationRequested = false;
  private completed = false;

  public get wasCancelled(): boolean {
    return this.cancellationRequested;
  }

  public get executionCompleted(): boolean {
    return this.completed;
  }

  public get canRetry(): boolean {
    return !this.completed;
  }

  public begin(): void {
    this.cancellationRequested = false;
    this.completed = false;
  }

  public cancel(): void {
    this.cancellationRequested = true;
  }

  public throwIfCancelled(): void {
    if (this.cancellationRequested) {
      throw new Error("Pi request was cancelled.");
    }
  }

  public completeExecution(): void {
    this.completed = true;
  }
}

function assistantMessageText(message: unknown): string | undefined {
  if (!isRecord(message) || message.role !== "assistant") {
    return undefined;
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .filter(part => isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map(part => String(part.text))
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function shouldTrackConversationChanges(
  policy: AgentRequestPolicy | undefined,
  mode: PiAgentMode,
): boolean {
  return policy !== "read-only" && (mode === "edit" || mode === "agent");
}

export function requestMayHaveProducedSideEffects(
  policy: AgentRequestPolicy | undefined,
  mode: PiAgentMode,
  toolNames: readonly string[],
): boolean {
  return shouldTrackConversationChanges(policy, mode)
    && toolNames.some(name => name === "bash" || name === "edit" || name === "write");
}

export class ConversationSideEffectTracker {
  private detected = false;

  public get mayHaveSideEffects(): boolean {
    return this.detected;
  }

  public reset(): void {
    this.detected = false;
  }

  public record(policy: AgentRequestPolicy | undefined, mode: PiAgentMode, toolName: string): void {
    this.detected ||= requestMayHaveProducedSideEffects(policy, mode, [toolName]);
  }
}
