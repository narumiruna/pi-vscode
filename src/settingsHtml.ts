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
<p>Edit Pi files with explicit Save. Opening this page starts no Pi process or connection.</p>
<details id="configuration-details"><summary>File locations and save behavior</summary>
<p>Global Pi uses the Extension Host's ~/.pi/agent/settings.json and mcp.json, or PI_CODING_AGENT_DIR. Project Pi uses .pi/settings.json and .pi/mcp.json in the first workspace folder. Remote windows use remote host paths.</p>
<p>Opening, switching, and resetting an absent override create nothing. Save does not restart Pi, connect MCP servers, or approve project resources. VS Code launch overrides can take precedence.</p>
<p>Startup preferences require Pi: Restart Pi (Current Launch Policy). Runtime controls and Apply are separate explicit commands.</p>
<p>Only validated common-setting drafts within the 28 KiB recovery limit are restored after hiding this page. MCP drafts stay in memory only.</p>
</details>
<p id="status" role="status" aria-live="polite">Loading configuration…</p>
<main id="settings" aria-label="Pi configuration files"></main>
<script nonce="${nonce}" src="${escapeAttribute(assets.script)}"></script>
</body></html>`;
}
