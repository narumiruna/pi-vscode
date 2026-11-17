import path from "node:path";

interface AgentLease {
  readonly label: string;
  readonly onOverlap: () => void;
  overlapped: boolean;
}
interface AgentOperations {
  readonly kind: "agents";
  readonly leases: Set<AgentLease>;
}
interface OperationObserver {
  readonly listener: (owner?: object) => void;
}
const operations = new Map<string, { readonly kind: "exclusive"; readonly label: string } | AgentOperations>();
const observers = new Map<string, Set<OperationObserver>>();

/** Keys are caller-canonical working directories; this gate does not cover other windows or external writers. */
export function acquireOperation(root: string, label: string, owner?: object): () => void {
  const key = path.resolve(root);
  const existing = operations.get(key);
  if (existing) throw new Error(`Wait for ${operationLabel(existing)} before ${label}.`);
  const operation = { kind: "exclusive", label } as const;
  operations.set(key, operation);
  const release = () => {
    if (operations.get(key) === operation) operations.delete(key);
  };
  try {
    notifyAdmission(key, owner);
  } catch (error) {
    release();
    throw error;
  }
  return release;
}

/** Agent leases share only with agents, and each callback runs synchronously on that lease's first overlap. */
export function acquireAgentOperation(root: string, label: string, onOverlap: () => void, owner?: object): () => void {
  const key = path.resolve(root);
  const existing = operations.get(key);
  if (existing?.kind === "exclusive") throw new Error(`Wait for ${existing.label} before ${label}.`);
  const operation: AgentOperations = existing ?? { kind: "agents", leases: new Set() };
  const lease: AgentLease = { label, onOverlap, overlapped: false };
  operation.leases.add(lease);
  operations.set(key, operation);
  const release = () => {
    operation.leases.delete(lease);
    if (!operation.leases.size && operations.get(key) === operation) operations.delete(key);
  };
  const callbacks: (() => void)[] = [];
  if (operation.leases.size > 1) {
    for (const active of operation.leases) {
      if (active.overlapped) continue;
      active.overlapped = true;
      callbacks.push(active.onOverlap);
    }
  }
  try {
    notifyAdmission(key, owner, callbacks);
  } catch (error) {
    release();
    throw error;
  }
  return release;
}

/** Observe successful local admissions; owner identifies the caller without granting operation authority. */
export function observeOperations(root: string, listener: (owner?: object) => void): { dispose(): void } {
  const key = path.resolve(root);
  const registrations = observers.get(key) ?? new Set<OperationObserver>();
  const observer = { listener };
  registrations.add(observer);
  observers.set(key, registrations);
  return {
    dispose: () => {
      registrations.delete(observer);
      if (!registrations.size && observers.get(key) === registrations) observers.delete(key);
    },
  };
}

export function hasOperation(root: string): boolean {
  return operations.has(path.resolve(root));
}

function operationLabel(operation: NonNullable<ReturnType<typeof operations.get>>): string {
  return operation.kind === "exclusive" ? operation.label : (operation.leases.values().next().value?.label ?? "agents");
}

function notifyAdmission(key: string, owner?: object, overlaps: readonly (() => void)[] = []): void {
  const callbacks = [...(observers.get(key) ?? [])].map((observer) => () => observer.listener(owner));
  const errors: unknown[] = [];
  for (const callback of [...callbacks, ...overlaps]) {
    try {
      callback();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "Workspace operation notification failed; admission cancelled.");
}
