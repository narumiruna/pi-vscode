import type * as vscode from "vscode";
import type { AgentRequestPolicy, ChatReferenceContext } from "./prompts";
import type { PiAgentMode } from "./runtimeProfiles";

export interface ConversationRequestOptions {
  readonly instructions?: string;
  readonly resource?: vscode.Uri;
  readonly policy?: AgentRequestPolicy;
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

export class ConversationRequestGate {
  private pending = false;

  public acquire(): () => void {
    if (this.pending) {
      throw new Error("Pi is already working. Cancel or wait for the active request before starting another one.");
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

export function assistantTextAfter(messages: readonly unknown[], boundary: number): string {
  for (const message of messages.slice(boundary).reverse()) {
    if (!isRecord(message) || message.role !== "assistant") {
      continue;
    }
    if (typeof message.content === "string") {
      return message.content;
    }
    if (Array.isArray(message.content)) {
      return message.content
        .filter(part => isRecord(part) && part.type === "text" && typeof part.text === "string")
        .map(part => String(part.text))
        .join("\n");
    }
  }
  throw new Error("Pi completed without an assistant response for this request.");
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

  public completeExecution(): void {
    this.completed = true;
  }
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
