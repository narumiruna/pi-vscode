/** Shared in-window capacity for editor and auxiliary Sidebar runtimes, including cleanup quarantine. */
export class InteractiveSessionSlots {
  public readonly capacity = 8;
  private used = 0;

  public get count(): number {
    return this.used;
  }

  public check(): void {
    if (this.used >= this.capacity)
      throw new Error("Close a Pi session before opening another. Unverified cleanup still uses a session slot.");
  }

  public acquire(): () => void {
    this.check();
    this.used++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used--;
    };
  }
}
