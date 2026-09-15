export interface CompletionContext {
  readonly file: string;
  readonly languageId: string;
  readonly prefix: string;
  readonly suffix: string;
}

const completionStart = "<<<PICODE_COMPLETION_START>>>";
const completionEnd = "<<<PICODE_COMPLETION_END>>>";

export function buildCompletionPrompt(context: CompletionContext): string {
  return [
    "Complete the code at the cursor inside VS Code.",
    "Return only the text that should be inserted at the cursor.",
    "Match the existing style and avoid repeating text already present before or after the cursor.",
    `Return exactly ${completionStart}, a newline, the insertion, another newline, and ${completionEnd}.`,
    "Do not use Markdown fences and do not explain the completion.",
    "",
    `File: ${context.file}`,
    `Language: ${context.languageId}`,
    "",
    "<<<PICODE_PREFIX_START>>>",
    context.prefix,
    "<<<PICODE_PREFIX_END>>>",
    "<<<PICODE_CURSOR>>>",
    "<<<PICODE_SUFFIX_START>>>",
    context.suffix,
    "<<<PICODE_SUFFIX_END>>>",
  ].join("\n");
}

export function extractCompletion(output: string): string | undefined {
  const normalized = output.replace(/\r\n/g, "\n");
  const match = /^\s*<<<PICODE_COMPLETION_START>>>\n([\s\S]*?)\n<<<PICODE_COMPLETION_END>>>\s*$/.exec(normalized);
  return match?.[1];
}

export function boundCompletionContext(
  prefix: string,
  suffix: string,
  maxPrefixCharacters: number,
  maxSuffixCharacters: number,
): { prefix: string; suffix: string } {
  return {
    prefix: maxPrefixCharacters <= 0 ? "" : prefix.slice(-maxPrefixCharacters),
    suffix: maxSuffixCharacters <= 0 ? "" : suffix.slice(0, maxSuffixCharacters),
  };
}
