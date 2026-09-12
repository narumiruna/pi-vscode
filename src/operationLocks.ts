import path from "node:path";

const operations = new Map<string, string>();
/** Keys are canonical working directories supplied by host adapters. */
export function acquireOperation(root: string, label: string): () => void {
  const key = path.resolve(root);
  const existing = operations.get(key);
  if (existing) throw new Error(`Wait for ${existing} before ${label}.`);
  operations.set(key, label);
  let released = false;
  return () => { if (!released) { released = true; operations.delete(key); } };
}
export function hasOperation(root: string): boolean { return operations.has(path.resolve(root)); }
