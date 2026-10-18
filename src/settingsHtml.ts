import { randomBytes } from "node:crypto";

export function getSettingsHtml(assets: { source: string; script: string; style: string }): string {
  const nonce = randomBytes(16).toString("base64url");
  const escapeAttribute = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src ${assets.source};`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pi Settings</title><link rel="stylesheet" href="${escapeAttribute(assets.style)}">
</head><body>
<header><h1>Pi Settings</h1><button id="native-settings" type="button">Open in VS Code Settings</button></header>
<div class="scope"><label for="target">Save settings to</label><select id="target"><option value="user">User</option><option value="workspace">Workspace</option></select></div>
<p id="scope-note">Reset removes only the selected scope's override.</p>
<p>This page edits VS Code pi.* settings only. For native files, run <strong>Pi: Open Native Pi Settings</strong> or <strong>Pi: Manage Native MCP Configuration</strong> from the Command Palette. Opening those surfaces starts no Pi process or connection. Runtime controls and Apply are separate explicit commands. Startup preferences require <strong>Pi: Restart Pi (Current Launch Policy)</strong>; saving never restarts Pi.</p>
<p id="status" role="status" aria-live="polite">Loading settings…</p>
<div class="layout"><nav aria-label="Settings categories"></nav><main id="settings"></main></div>
<script nonce="${nonce}" src="${escapeAttribute(assets.script)}"></script>
</body></html>`;
}
