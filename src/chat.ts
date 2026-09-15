import * as vscode from "vscode";
import { PiInvocationError } from "./piClient";
import {
  buildChatPrompt,
  limitChatHistory,
  limitReferenceContent,
  type ChatHistoryEntry,
  type ChatReferenceContext,
} from "./prompts";
import { invokePiWithCancellation } from "./vscodePi";

const participantId = "picode.chat";
const maxReferenceCharacters = 200_000;
const maxSingleReferenceCharacters = 100_000;
const maxHistoryCharacters = 40_000;

export function registerPiChat(context: vscode.ExtensionContext): void {
  const participant = vscode.chat.createChatParticipant(participantId, handleChatRequest);
  participant.iconPath = new vscode.ThemeIcon("sparkle");

  context.subscriptions.push(participant);
}

const handleChatRequest: vscode.ChatRequestHandler = async (request, chatContext, stream, token) => {
  try {
    stream.progress("Running Pi…");
    const references = await resolveReferences(request.references, stream, token);
    const history = collectHistory(chatContext.history);
    const prompt = buildChatPrompt(request.prompt, request.command, history, references);
    const response = await invokePiWithCancellation(prompt, token, firstReferenceUri(request.references));
    stream.markdown(response.trim());
    return {};
  } catch (error) {
    if (error instanceof PiInvocationError && error.kind === "aborted") {
      return {};
    }
    return {
      errorDetails: {
        message: formatChatError(error),
      },
    };
  }
};

async function resolveReferences(
  promptReferences: readonly vscode.ChatPromptReference[],
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<ChatReferenceContext[]> {
  const references: ChatReferenceContext[] = [];
  let remainingCharacters = maxReferenceCharacters;

  for (const reference of promptReferences) {
    if (token.isCancellationRequested || remainingCharacters <= 0) {
      break;
    }

    const resolved = await resolveReference(reference, remainingCharacters);
    if (!resolved) {
      continue;
    }
    references.push(resolved.context);
    remainingCharacters -= resolved.context.content.length;
    if (resolved.location) {
      stream.reference(resolved.location);
    }
  }

  return references;
}

async function resolveReference(
  reference: vscode.ChatPromptReference,
  remainingCharacters: number,
): Promise<{ context: ChatReferenceContext; location?: vscode.Uri | vscode.Location } | undefined> {
  const value = reference.value;

  if (value instanceof vscode.Location) {
    try {
      const document = await vscode.workspace.openTextDocument(value.uri);
      const content = limitReferenceContent(document.getText(value.range), remainingCharacters, maxSingleReferenceCharacters);
      return {
        context: { label: referenceLabel(reference, value.uri), content },
        location: value,
      };
    } catch {
      return undefined;
    }
  }

  if (value instanceof vscode.Uri) {
    try {
      const document = await vscode.workspace.openTextDocument(value);
      const content = limitReferenceContent(document.getText(), remainingCharacters, maxSingleReferenceCharacters);
      return {
        context: { label: referenceLabel(reference, value), content },
        location: value,
      };
    } catch {
      return undefined;
    }
  }

  if (typeof value === "string") {
    return {
      context: {
        label: sanitizeLabel(reference.modelDescription ?? reference.id),
        content: limitReferenceContent(value, remainingCharacters, maxSingleReferenceCharacters),
      },
    };
  }

  return undefined;
}

function collectHistory(turns: ReadonlyArray<vscode.ChatRequestTurn | vscode.ChatResponseTurn>): ChatHistoryEntry[] {
  const entries = turns.map(historyEntry).filter(entry => entry !== undefined);
  return limitChatHistory(entries, maxHistoryCharacters, 12);
}

function historyEntry(turn: vscode.ChatRequestTurn | vscode.ChatResponseTurn): ChatHistoryEntry | undefined {
  if ("prompt" in turn) {
    return { role: "user", content: turn.prompt };
  }

  const content = turn.response
    .filter(part => part instanceof vscode.ChatResponseMarkdownPart)
    .map(part => part.value.value)
    .join("\n");
  return content ? { role: "assistant", content } : undefined;
}

function firstReferenceUri(references: readonly vscode.ChatPromptReference[]): vscode.Uri | undefined {
  for (const reference of references) {
    if (reference.value instanceof vscode.Location) {
      return reference.value.uri;
    }
    if (reference.value instanceof vscode.Uri) {
      return reference.value;
    }
  }
  return vscode.window.activeTextEditor?.document.uri;
}

function referenceLabel(reference: vscode.ChatPromptReference, uri: vscode.Uri): string {
  return sanitizeLabel(reference.modelDescription ?? vscode.workspace.asRelativePath(uri, false));
}

function sanitizeLabel(label: string): string {
  return label.replace(/[\r\n]+/g, " ").slice(0, 500);
}

function formatChatError(error: unknown): string {
  if (error instanceof PiInvocationError) {
    const details = error.details?.trim();
    return details ? `${error.message} ${details.slice(0, 1000)}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
