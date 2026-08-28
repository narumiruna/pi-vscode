import type * as vscode from "vscode";
import type { AgentRequestPolicy, ChatReferenceContext } from "./prompts";

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
