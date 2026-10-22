/** Shared webview message and draft bounds; native file projections have separate limits. */
export const maxSettingsMessage = 32768;
export function serializedSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export interface SettingsSnapshot {
  type: "snapshot";
  nativeFilesAvailable: boolean;
}
