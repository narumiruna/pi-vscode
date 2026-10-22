/** Shared webview message and draft bounds; native file projections have separate limits. */
export const maxSettingsMessage = 32768;
export function serializedSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export type SettingsRestartStatus = "completed" | "cancelled" | "failed" | "rejected";
export interface SettingsRestartResult {
  type: "restartResult";
  id: string;
  status: SettingsRestartStatus;
}

export interface SettingsSnapshot {
  type: "snapshot";
  nativeFilesAvailable: boolean;
  restartActionToken?: string;
}
