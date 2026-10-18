import { stripVTControlCharacters } from "node:util";

// Limits count UTF-16 code units, including raw keys. Rejected updates keep the previous entry.
export const extensionUiLimits = {
  statusKeys: 16,
  widgetKeys: 16,
  keyCharacters: 128,
  lines: 20,
  lineCharacters: 1_000,
  retainedCharacters: 32_000,
} as const;

export interface ExtensionStatus {
  readonly key: string;
  readonly text: string;
}

export interface ExtensionWidget {
  readonly key: string;
  readonly lines: readonly string[];
  readonly placement: "aboveEditor" | "belowEditor";
}

export interface SidebarExtensionUiState {
  readonly statuses: readonly ExtensionStatus[];
  readonly widgets: readonly ExtensionWidget[];
  readonly diagnostic?: string;
}

/** Memory-only, insertion-ordered state for one foreground client/session generation. */
export class SidebarExtensionUi {
  private readonly statuses = new Map<string, ExtensionStatus>();
  private readonly widgets = new Map<string, ExtensionWidget>();
  private rejected = false;

  public get state(): SidebarExtensionUiState {
    return {
      statuses: [...this.statuses.values()].map((entry) => ({ ...entry, key: extensionUiText(entry.key) })),
      widgets: [...this.widgets.values()].map((entry) => ({ ...entry, key: extensionUiText(entry.key) })),
      ...(this.rejected
        ? { diagnostic: "Some extension status or widget updates were ignored because data or limits were invalid." }
        : {}),
    };
  }

  public clear(): void {
    this.statuses.clear();
    this.widgets.clear();
    this.rejected = false;
  }

  /** Returns true only when visible state changed. No dialog response is required. */
  public update(event: Record<string, unknown>): boolean {
    const status = event.method === "setStatus";
    if (!status && event.method !== "setWidget") return false;
    const key = status ? event.statusKey : event.widgetKey;
    if (typeof key !== "string" || !key.length || key.length > extensionUiLimits.keyCharacters) return this.reject();
    const value = status ? event.statusText : event.widgetLines;
    if (value === undefined) return (status ? this.statuses : this.widgets).delete(key);

    if (status) {
      if (!validLine(value)) return this.reject();
      const entry = { key, text: extensionUiText(value) };
      if (this.statuses.get(key)?.text === entry.text) return false;
      if (!this.statuses.has(key) && this.statuses.size >= extensionUiLimits.statusKeys) return this.reject();
      if (!this.fits(key, entry.text.length, true)) return this.reject();
      this.statuses.set(key, entry);
    } else {
      const placement = event.widgetPlacement === undefined ? "aboveEditor" : event.widgetPlacement;
      if (
        (placement !== "aboveEditor" && placement !== "belowEditor") ||
        !Array.isArray(value) ||
        value.length > extensionUiLimits.lines ||
        !value.every(validLine)
      )
        return this.reject();
      const entry: ExtensionWidget = { key, lines: value.map(extensionUiText), placement };
      const previous = this.widgets.get(key);
      if (previous?.placement === placement && JSON.stringify(previous.lines) === JSON.stringify(entry.lines))
        return false;
      if (!previous && this.widgets.size >= extensionUiLimits.widgetKeys) return this.reject();
      if (
        !this.fits(
          key,
          entry.lines.reduce((sum, line) => sum + line.length, 0),
          false,
        )
      )
        return this.reject();
      this.widgets.set(key, entry);
    }
    return true;
  }

  private fits(key: string, characters: number, status: boolean): boolean {
    let total = key.length + characters;
    for (const entry of this.statuses.values())
      if (!status || entry.key !== key) total += entry.key.length + entry.text.length;
    for (const entry of this.widgets.values())
      if (status || entry.key !== key)
        total += entry.key.length + entry.lines.reduce((sum, line) => sum + line.length, 0);
    return total <= extensionUiLimits.retainedCharacters;
  }

  private reject(): boolean {
    const changed = !this.rejected;
    this.rejected = true;
    return changed;
  }
}

function validLine(value: unknown): value is string {
  return typeof value === "string" && value.length <= extensionUiLimits.lineCharacters;
}

export function extensionUiText(value: string): string {
  // Remove terminal strings (OSC/DCS/APC/PM/SOS, including unterminated strings), then CSI/ESC.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Terminal controls are untrusted input.
  const terminalStrings = /(?:\x1b[\]PX^_]|[\x90\x98\x9d\x9e\x9f])[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g;
  const plain = stripVTControlCharacters(value.replace(terminalStrings, ""));
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Remove control characters and bidi overrides, not text.
  return plain.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "");
}
