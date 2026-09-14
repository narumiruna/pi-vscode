export interface SelectionContext {
  readonly file: string;
  readonly languageId: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly code: string;
}

export interface ChatHistoryEntry {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface ChatReferenceContext {
  readonly label: string;
  readonly content: string;
}

export type AgentRequestPolicy = "read-only";

const replacementStart = "<<<PI_REPLACEMENT_START>>>";
const replacementEnd = "<<<PI_REPLACEMENT_END>>>";

export function buildSelectionReference(context: SelectionContext): ChatReferenceContext {
  return {
    label: `${context.file}:${context.startLine}-${context.endLine}`,
    content: [
      `File: ${context.file}`,
      `Language: ${context.languageId}`,
      `Lines: ${context.startLine}-${context.endLine}`,
      "",
      context.code,
    ].join("\n"),
  };
}

function describeSelection(context: SelectionContext): string {
  return [
    `File: ${context.file}`,
    `Language: ${context.languageId}`,
    `Lines: ${context.startLine}-${context.endLine}`,
    "",
    "<<<PI_SELECTED_CODE_START>>>",
    context.code,
    "<<<PI_SELECTED_CODE_END>>>",
  ].join("\n");
}

export function buildAskPrompt(context: SelectionContext, question: string): string {
  return [
    "Answer the user's question about the selected code.",
    "Be concrete and concise.",
    "Use Markdown when it improves readability.",
    "Do not modify files.",
    "",
    `Question: ${question}`,
    "",
    describeSelection(context),
  ].join("\n");
}

export function buildModifyPrompt(context: SelectionContext, instruction: string): string {
  return [
    "Rewrite only the selected code according to the user's instruction.",
    "The replacement must fit in the same location and preserve surrounding behavior unless requested otherwise.",
    "Do not modify files and do not explain the result.",
    `Return exactly ${replacementStart}, then a newline, the replacement text, another newline, and ${replacementEnd}.`,
    "Do not use Markdown code fences.",
    "",
    `Instruction: ${instruction}`,
    "",
    describeSelection(context),
  ].join("\n");
}

export function limitChatHistory(
  history: readonly ChatHistoryEntry[],
  maxCharacters: number,
  maxEntries: number,
): ChatHistoryEntry[] {
  if (maxEntries <= 0 || maxCharacters <= 0) {
    return [];
  }

  const limited: ChatHistoryEntry[] = [];
  let remainingCharacters = maxCharacters;

  for (const entry of history.slice(-maxEntries).reverse()) {
    if (remainingCharacters <= 0) {
      break;
    }
    const content = entry.content.slice(-remainingCharacters);
    limited.unshift({ role: entry.role, content });
    remainingCharacters -= content.length;
  }

  return limited;
}

export function limitReferenceContent(content: string, remainingCharacters: number, maxCharacters: number): string {
  return content.slice(0, Math.max(0, Math.min(remainingCharacters, maxCharacters)));
}

export function buildAgentPrompt(
  request: string,
  references: readonly ChatReferenceContext[],
  instructions?: string,
  policy?: AgentRequestPolicy,
): string {
  const sections: string[] = [];
  if (policy) {
    sections.push(`<<<PI_VSCODE_POLICY: ${policy}>>>`);
  }
  for (const reference of references) {
    sections.push(
      `<<<PI_VSCODE_CONTEXT_START: ${reference.label.replace(/[\r\n]+/g, " ")}>>>`,
      reference.content,
      "<<<PI_VSCODE_CONTEXT_END>>>",
    );
  }
  if (instructions) {
    sections.push("<<<PI_VSCODE_INSTRUCTIONS_START>>>", instructions, "<<<PI_VSCODE_INSTRUCTIONS_END>>>");
  }
  sections.push("<<<PI_VSCODE_REQUEST_START>>>", request, "<<<PI_VSCODE_REQUEST_END>>>");
  return sections.join("\n");
}

export function parseAgentPrompt(prompt: string, maxContextLabels = Number.MAX_SAFE_INTEGER): { request: string; contextLabels: string[] } {
  const requestMatch = /<<<PI_VSCODE_REQUEST_START>>>\n([\s\S]*?)\n<<<PI_VSCODE_REQUEST_END>>>\s*$/.exec(prompt);
  const contextLabels: string[] = [];
  for (const match of prompt.matchAll(/<<<PI_VSCODE_CONTEXT_START: ([^\r\n>]*)>>>/g)) {
    if (contextLabels.length >= maxContextLabels) break;
    contextLabels.push(match[1]);
  }
  return {
    request: requestMatch?.[1] ?? prompt,
    contextLabels,
  };
}

export function buildChatPrompt(
  question: string,
  command: string | undefined,
  history: readonly ChatHistoryEntry[],
  references: readonly ChatReferenceContext[],
): string {
  const commandInstruction = chatCommandInstruction(command);
  const sections = [
    "You are Pi Coding Agent responding inside the native VS Code Chat view.",
    "Answer in concise Markdown.",
    "Do not claim to have modified files or run commands because tools are disabled for this chat request.",
  ];

  if (history.length > 0) {
    sections.push(
      "Conversation history:",
      history.map(entry => `${entry.role === "user" ? "User" : "Assistant"}:\n${entry.content}`).join("\n\n"),
    );
  }

  if (references.length > 0) {
    sections.push(
      "Referenced context:",
      references
        .map(reference => `<<<PI_REFERENCE_START: ${reference.label}>>>\n${reference.content}\n<<<PI_REFERENCE_END>>>`)
        .join("\n\n"),
    );
  }

  sections.push("Current request:", [commandInstruction, question].filter(Boolean).join("\n"));
  return sections.join("\n\n");
}

export function extractReplacement(output: string): string | undefined {
  const normalized = output.replace(/\r\n/g, "\n");
  const pattern = new RegExp(
    `^\\s*${escapeRegExp(replacementStart)}\\n([\\s\\S]*?)\\n${escapeRegExp(replacementEnd)}\\s*$`,
  );
  return pattern.exec(normalized)?.[1];
}

function chatCommandInstruction(command: string | undefined): string {
  switch (command) {
    case "explain":
      return "Explain the relevant code or concept, including important behavior and assumptions.";
    case "review":
      return "Review the relevant code for correctness, security, maintainability, and missing tests. Prioritize actionable findings.";
    case "fix":
      return "Suggest a concrete fix for the described problem. Include replacement code or a patch-style example when useful.";
    default:
      return "";
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
