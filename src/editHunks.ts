export interface EditHunk {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
  readonly label: string;
}
export interface EditHunks { readonly hunks: readonly EditHunk[]; readonly fallback: boolean }

/** Line-based bounded LCS. One fallback hunk is safer than a guessed or unbounded diff. */
export function computeEditHunks(original: string, replacement: string, maxCells = 1_000_000): EditHunks {
  if (original.length + replacement.length > 800_000) throw new Error("Edit proposal exceeds the 800,000-character diff limit.");
  if (original === replacement) return { hunks: [], fallback: false };
  const before = original.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const after = replacement.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  if ((before.length + 1) * (after.length + 1) > maxCells) {
    return { hunks: [{ id: "h0", start: 0, end: original.length, replacement, label: "Whole target (bounded diff fallback)" }], fallback: true };
  }
  const width = after.length + 1;
  const table = new Uint32Array((before.length + 1) * width);
  for (let i = before.length - 1; i >= 0; i--) for (let j = after.length - 1; j >= 0; j--) {
    table[i * width + j] = before[i] === after[j] ? table[(i + 1) * width + j + 1]! + 1
      : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
  }
  const hunks: EditHunk[] = [];
  let i = 0, j = 0, offset = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) { offset += before[i++]!.length; j++; continue; }
    const start = offset, firstLine = i + 1;
    let text = "";
    while ((i < before.length || j < after.length) && !(i < before.length && j < after.length && before[i] === after[j])) {
      if (j < after.length && (i === before.length || table[i * width + j + 1]! > table[(i + 1) * width + j]!)) text += after[j++];
      else offset += before[i++]!.length;
    }
    hunks.push({ id: `h${hunks.length}`, start, end: offset, replacement: text, label: `Target lines ${firstLine}–${Math.max(firstLine, i)}` });
  }
  return { hunks, fallback: false };
}
export function selectedReplacement(original: string, hunks: readonly EditHunk[], ids: readonly string[]): string {
  const selected = new Set(ids);
  if (selected.size !== ids.length || ids.some(id => !hunks.some(hunk => hunk.id === id))) throw new Error("Invalid hunk selection.");
  let result = "", offset = 0;
  for (const hunk of hunks) {
    if (hunk.start < offset || hunk.end < hunk.start || hunk.end > original.length) throw new Error("Invalid deterministic hunk range.");
    result += original.slice(offset, hunk.start) + (selected.has(hunk.id) ? hunk.replacement : original.slice(hunk.start, hunk.end));
    offset = hunk.end;
  }
  return result + original.slice(offset);
}
