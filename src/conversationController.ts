import type * as vscode from "vscode";
import type { ChatReferenceContext } from "./prompts";

export interface ConversationRequestOptions {
  readonly instructions?: string;
  readonly resource?: vscode.Uri;
}

export interface EditProposalInput {
  readonly label: string;
  readonly onPreview: () => Promise<void>;
  readonly onApply: () => Promise<void>;
  readonly onReject?: () => Promise<void> | void;
}

export interface PiConversationController {
  sendRequest(
    request: string,
    contexts: readonly ChatReferenceContext[],
    options?: ConversationRequestOptions,
  ): Promise<string>;
  addEditProposal(input: EditProposalInput): string;
}
