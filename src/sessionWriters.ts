import { lstat } from "node:fs/promises";
import { canonicalAssignedSessionPath } from "./sessionIdentity";

export class SessionInUseError extends Error {
  public constructor() {
    super("This Pi session is already open or its previous writer has not stopped safely. Use its existing view.");
    this.name = "SessionInUseError";
  }
}

/** In-window RPC ownership only. External processes and other windows are not locked. */
export class SessionWriters {
  private readonly writers = new Map<string, object>();
  private readonly retired = new WeakSet<object>();
  private readonly committed = new WeakMap<object, string>();

  public async reserve(owner: object, sessionFile: string, isCurrent = () => true): Promise<string> {
    if (this.retired.has(owner) || !isCurrent()) throw new SessionInUseError();
    const key = await canonicalAssignedSessionPath(sessionFile);
    const stat = await lstat(key).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (stat && (!stat.isFile() || stat.nlink !== 1))
      throw new Error("Pi sessions require a regular single-link file.");
    if (this.retired.has(owner) || !isCurrent()) throw new SessionInUseError();
    const existing = this.writers.get(key);
    if (existing && existing !== owner) throw new SessionInUseError();
    this.writers.set(key, owner);
    return key;
  }

  /** Keep both reservations until the destination is verified, including cancelled/uncertain switches. */
  public async commit(owner: object, sessionFile: string | undefined, isCurrent = () => true): Promise<void> {
    if (!sessionFile) return;
    const key = await this.reserve(owner, sessionFile, isCurrent);
    if (this.retired.has(owner) || !isCurrent()) throw new SessionInUseError();
    // A refresh of the source cannot release an in-flight switch destination.
    if (this.committed.get(owner) === key) return;
    for (const [file, writer] of this.writers) {
      if (writer === owner && file !== key) this.writers.delete(file);
    }
    this.committed.set(owner, key);
  }

  public async cancelReservation(owner: object, sessionFile: string): Promise<void> {
    const key = await canonicalAssignedSessionPath(sessionFile);
    if (this.retired.has(owner) || this.committed.get(owner) === key) return;
    if (this.writers.get(key) === owner) this.writers.delete(key);
  }

  /** Stop admission before asynchronous cleanup; existing claims remain until verified release. */
  public retire(owner: object): void {
    this.retired.add(owner);
  }

  public release(owner: object): void {
    this.retire(owner);
    this.committed.delete(owner);
    for (const [file, writer] of this.writers) {
      if (writer === owner) this.writers.delete(file);
    }
  }
}
