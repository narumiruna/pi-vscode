import { randomBytes } from "node:crypto";

export function getSettingsHtml(assets: { source: string; script: string; style: string }): string {
  const nonce = randomBytes(16).toString("base64url");
  const escapeAttribute = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src ${assets.source};`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pi Configuration</title><link rel="stylesheet" href="${escapeAttribute(assets.style)}">
</head><body>
<header><h1>Pi Configuration</h1><button id="native-settings" type="button" class="secondary">Open VS Code Settings</button></header>
<p id="save-behavior">Save changes Pi files only. Running sessions are unchanged. Restart Pi to load saved settings.</p>
<div class="actions runtime-actions"><button id="native-restart-pi" type="button" class="secondary" disabled>Restart Pi…</button>
<details id="configuration-details"><summary>File locations and precedence</summary>
<p>Global Pi uses the Extension Host's ~/.pi/agent/settings.json and mcp.json, or PI_CODING_AGENT_DIR. Project Pi uses .pi/settings.json and .pi/mcp.json in the first workspace folder. Remote windows use remote host paths.</p>
<p>Opening, switching, and resetting an absent override create nothing. Opening this page starts no Pi process or connection. Save does not restart Pi, connect MCP servers, or approve project resources.</p>
<p>Restart Pi uses the current launch policy and asks for confirmation. Resumed-session values and VS Code launch overrides can still take precedence. Runtime controls and Apply are separate explicit commands.</p>
<p>Only validated common-setting drafts within the 28 KiB recovery limit are restored after hiding this page. MCP drafts stay in memory only. Restart feedback recovers without repeating the restart.</p>
</details></div>
<p id="status" role="status"></p>
<p id="operation-status" role="status"></p>
<main id="settings" aria-label="Pi configuration files"></main>
<script nonce="${nonce}" src="${escapeAttribute(assets.script)}"></script>
</body></html>`;
}
