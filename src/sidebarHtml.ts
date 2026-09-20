import { randomBytes } from "node:crypto";

// Static, theme-colored icons need no font, resource URI, or broader CSP.
const iconPaths = {
  plus: '<path d="M8 3v10M3 8h10"/>',
  chevron: '<path d="m5 6 3 3 3-3"/>',
  arrow: '<path d="M3 8h10m-4-4 4 4-4 4"/>',
  more: '<circle cx="3" cy="8" r=".7"/><circle cx="8" cy="8" r=".7"/><circle cx="13" cy="8" r=".7"/>',
  trash: '<path d="M2.5 4.5h11M6 4V2.5h4V4M4 5l.5 8.5h7L12 5M6.5 7v4M9.5 7v4"/>',
  selection: '<path d="m5 4-4 4 4 4m6-8 4 4-4 4M9 2 7 14"/>',
  plan: '<rect x="3" y="2" width="10" height="12" rx="2"/><path d="M6 6h4M6 9h4M6 12h2"/>',
  agent: '<path d="m9 1-6 8h4l-1 6 7-9H9l1-5Z"/>',
  attachment: '<path d="m6 9 4-4a2 2 0 0 1 3 3l-5 5a3.5 3.5 0 0 1-5-5l5-5"/>',
  send: '<path d="M8 13V3m-4 4 4-4 4 4"/>',
  stop: '<rect x="4" y="4" width="8" height="8" rx="1"/>',
  back: '<path d="m10.5 3-5 5 5 5"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>',
} as const;

function icon(name: keyof typeof iconPaths): string {
  return `<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${iconPaths[name]}</svg>`;
}

export function getSidebarHtml(maxInputCharacters: number, maxImageBytes: number): string {
  const nonce = randomBytes(16).toString("base64url");
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    "img-src data:",
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <style nonce="${nonce}">
    :root { color-scheme: light dark; }
    body { --pi-border: var(--vscode-sideBar-border, var(--vscode-widget-border, transparent)); --pi-accent: var(--vscode-textLink-foreground); --pi-control-background: var(--vscode-dropdown-background, var(--vscode-input-background)); --pi-control-border: var(--vscode-dropdown-border, var(--vscode-input-border, var(--pi-border))); --pi-composer-background: var(--vscode-editorWidget-background, var(--vscode-input-background)); }
    body.vscode-light, body.vscode-high-contrast-light { color-scheme: light; }
    body.vscode-dark, body.vscode-high-contrast { color-scheme: dark; }
    * { box-sizing: border-box; }
    /* Author display rules must never override native hidden state. */
    [hidden] { display: none !important; }
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); line-height: 1.5; overflow: hidden; }
    #app { height: 100vh; min-width: 0; display: grid; grid-template-rows: auto minmax(0, 1fr) auto auto auto auto; padding: 0 12px 10px; }
    #app.sessions-layer { grid-template-rows: minmax(0, 1fr) auto auto auto; }
    #app.sessions-layer > :not(#sessions):not(#composer):not(#notice):not(#runtime) { display: none; }
    button, select { min-height: 28px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 7px; padding: 4px 9px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; font: inherit; }
    button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
    button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    button:active:not(:disabled) { transform: translateY(1px); }
    button.secondary { color: var(--vscode-foreground); background: transparent; }
    button.secondary:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
    button.danger { color: var(--vscode-errorForeground); }
    button:focus-visible, select:focus-visible, summary:focus-visible, textarea:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    button:disabled, select:disabled { cursor: default; opacity: .5; }
    .icon { width: 16px; height: 16px; flex: 0 0 auto; }
    .icon-button { width: 28px; padding: 5px; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
    #sessions { min-width: 0; padding: 8px 0 7px; border-bottom: 1px solid var(--pi-border); }
    .sessions-header { display: flex; min-width: 0; align-items: center; gap: 6px; min-height: 30px; }
    .sessions-title { flex: 1; min-width: 0; overflow: hidden; color: var(--vscode-descriptionForeground); font-size: .9em; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
    .sessions-actions { display: flex; flex: 0 0 auto; gap: 2px; }
    .sessions-actions button { min-width: 0; white-space: nowrap; }
    #back-to-sessions .icon { width: 15px; height: 15px; }
    #session-list-content { min-height: 0; overflow: hidden; }
    .session-list { display: grid; min-width: 0; gap: 1px; }
    button.session-row { width: 100%; min-width: 0; min-height: 28px; justify-content: flex-start; gap: 8px; padding: 3px 7px; border: 0; border-radius: 6px; color: var(--vscode-foreground); text-align: left; }
    button.session-row.current { background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground)); }
    .session-row-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .session-row-time { flex: 0 0 auto; color: var(--vscode-descriptionForeground); font-size: .82em; font-variant-numeric: tabular-nums; }
    button.session-row.current .session-row-time { color: inherit; opacity: .72; }
    #view-all-sessions { min-height: 24px; margin-top: 2px; padding: 1px 7px; color: var(--vscode-descriptionForeground); font-size: .82em; }
    #sessions-browser { display: grid; min-height: 0; height: 100%; grid-template-rows: auto auto minmax(0, 1fr) auto; gap: 8px; padding-top: 4px; }
    .session-search { display: flex; min-width: 0; align-items: center; gap: 7px; padding: 0 9px; border: 1px solid var(--vscode-input-border, transparent); border-radius: 7px; color: var(--vscode-input-placeholderForeground); background: var(--vscode-input-background); }
    .session-search .icon { width: 14px; height: 14px; }
    #session-search-input { width: 100%; min-width: 0; height: 32px; padding: 4px 0; border: 0; outline: 0; color: var(--vscode-input-foreground); background: transparent; font: inherit; }
    #session-search-input::placeholder { color: var(--vscode-input-placeholderForeground); }
    .session-search:focus-within { border-color: var(--vscode-focusBorder); outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    .session-filter { padding: 2px 7px; color: var(--vscode-descriptionForeground); font-size: .85em; font-weight: 500; }
    #all-session-list { min-height: 0; overflow-y: auto; align-content: start; scrollbar-width: thin; }
    #no-sessions { margin: 12px 7px; color: var(--vscode-descriptionForeground); font-size: .85em; }
    #app.sessions-layer #sessions { display: grid; min-height: 0; grid-template-rows: auto minmax(0, 1fr); border-bottom: 0; }
    #app.sessions-layer .sessions-title { color: var(--vscode-foreground); font-size: 1em; }
    #app.sessions-layer.sessions-expanded #session-list-content { display: grid; grid-template-rows: minmax(0, 1fr); }
    #thinking-level { min-width: 0; max-width: 104px; color: var(--vscode-foreground); background: var(--vscode-input-background); border-color: var(--vscode-input-border, var(--pi-border)); }
    #model-picker { min-width: 0; max-width: 132px; justify-content: flex-start; color: var(--vscode-descriptionForeground); }
    #model-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #model-picker .icon { width: 12px; height: 12px; }
    #runtime { display: flex; flex-wrap: wrap; min-width: 0; gap: 6px; align-items: center; margin-top: 7px; padding: 7px 2px 0; color: var(--vscode-descriptionForeground); border-top: 1px solid var(--pi-border); font-size: .82em; }
    .status-dot { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: var(--vscode-descriptionForeground); }
    #runtime[data-connection="connected"] .status-dot { background: var(--vscode-testing-iconPassed, var(--pi-accent)); }
    #runtime[data-connection="busy"] .status-dot { background: var(--vscode-progressBar-background); }
    #runtime[data-connection="disconnected"] .status-dot { background: var(--vscode-editorWarning-foreground); }
    #runtime span:not(.status-dot) { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #status { flex: 1 1 70px; }
    #session { max-width: 38%; }
    #usage { font-variant-numeric: tabular-nums; }
    #runtime button { min-height: 24px; padding: 2px 6px; font-size: inherit; }
    #conversation { min-width: 0; overflow-y: auto; padding: 18px 2px 8px; scrollbar-width: thin; }
    #messages { min-width: 0; }
    #messages.is-empty { min-height: 100%; display: flex; }
    .empty { width: 100%; max-width: 380px; margin: auto; padding: 24px 8px 40px; text-align: center; color: var(--vscode-descriptionForeground); }
    .welcome-mark { display: grid; place-items: center; width: 44px; height: 44px; margin: 0 auto 18px; border: 1px solid var(--pi-border); border-radius: 12px; background: var(--vscode-editor-background); color: var(--pi-accent); font: 30px Georgia, serif; }
    .empty h2 { margin: 0 0 8px; color: var(--vscode-foreground); font-size: 1.65em; font-weight: 600; letter-spacing: -.035em; line-height: 1.25; }
    .empty p { margin: 0 auto; max-width: 280px; font-size: .95em; }
    .empty-actions { display: grid; gap: 8px; margin-top: 26px; text-align: left; }
    button.welcome-action { display: flex; width: 100%; gap: 12px; padding: 12px; border: 1px solid var(--pi-border); border-radius: 8px; text-align: left; background: var(--vscode-editor-background); }
    button.welcome-action:hover { border-color: var(--vscode-focusBorder); }
    .action-icon { display: grid; place-items: center; flex: 0 0 30px; height: 30px; border-radius: 7px; background: var(--vscode-input-background); color: var(--pi-accent); }
    .action-copy { display: grid; flex: 1; min-width: 0; gap: 2px; }
    .action-title { font-weight: 500; }
    .action-description { color: var(--vscode-descriptionForeground); font-size: .85em; }
    .action-arrow { display: flex; color: var(--vscode-descriptionForeground); }
    .message { min-width: 0; margin: 0 0 20px; }
    .role { display: flex; align-items: center; gap: 6px; margin: 0 0 6px 2px; color: var(--vscode-descriptionForeground); font-size: .85em; font-weight: 500; }
    .assistant .role { color: var(--vscode-foreground); }
    .assistant .role::before { content: 'π'; display: grid; place-items: center; width: 18px; height: 18px; border-radius: 5px; background: var(--vscode-input-background); color: var(--pi-accent); font: 15px Georgia, serif; }
    .content { min-width: 0; padding: 0 2px; overflow-wrap: anywhere; line-height: 1.6; }
    .content p { margin: 0 0 10px; }
    .content > :first-child { margin-top: 0; }
    .content > :last-child { margin-bottom: 0; }
    .content h1, .content h2, .content h3, .content h4 { font-size: 1.1em; margin: 16px 0 8px; }
    .content pre { max-width: 100%; overflow: auto; margin: 10px 0; padding: 12px; border: 1px solid var(--pi-border); background: var(--vscode-textCodeBlock-background); border-radius: 7px; white-space: pre; }
    .content code { font-family: var(--vscode-editor-font-family); font-size: .95em; }
    .content pre code { font-size: var(--vscode-editor-font-size); }
    .content :not(pre) > code { padding: 1px 4px; background: var(--vscode-textCodeBlock-background); border-radius: 4px; }
    .content ul { margin: 8px 0; padding-left: 22px; }
    .user .content { padding: 10px 12px; border-radius: 9px; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
    .transcript-contexts { display: flex; min-width: 0; flex-wrap: wrap; gap: 4px; margin-top: 7px; }
    .context, .truncated { display: inline-block; max-width: 100%; padding: 2px 7px; border-radius: 5px; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); font-size: .8em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .transcript-images { display: grid; min-width: 0; grid-template-columns: repeat(auto-fit, minmax(min(124px, 100%), 1fr)); gap: 7px; margin-top: 8px; }
    .transcript-image { min-width: 0; min-height: 72px; padding: 0; overflow: hidden; border-color: var(--pi-border); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    .transcript-image img { display: block; width: 100%; height: auto; max-height: 180px; object-fit: cover; background: var(--vscode-input-background); }
    .image-placeholder { display: grid; width: 100%; min-height: 72px; place-items: center; padding: 10px; color: var(--vscode-descriptionForeground); text-align: center; overflow-wrap: anywhere; }
    .image-label { display: block; min-width: 0; padding: 5px 7px; overflow: hidden; color: var(--vscode-descriptionForeground); font-size: .78em; text-overflow: ellipsis; white-space: nowrap; }
    #activity { max-height: min(28vh, 240px); overflow-y: auto; padding: 8px 2px 0; border-top: 1px solid var(--pi-border); scrollbar-width: thin; }
    .proposal, .change, .tool, .background-task { margin: 0 0 6px; border: 1px solid var(--pi-border); border-radius: 7px; }
    .proposal, .background-task { padding: 9px; }
    .proposal-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .proposal-meta, .background-meta { color: var(--vscode-descriptionForeground); font-size: .85em; }
    .proposal-error { color: var(--vscode-errorForeground); font-size: .85em; overflow-wrap: anywhere; }
    .proposal-actions, .change-actions, .background-actions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
    #tools-group { margin: 4px 0 10px; border-top: 1px solid var(--pi-border); padding-top: 5px; }
    #tools-group > summary { padding: 4px 2px; cursor: pointer; color: var(--vscode-descriptionForeground); font-size: .85em; overflow-wrap: anywhere; }
    #tools-summary { margin-left: 3px; }
    #tools-group[data-status="running"] > summary { color: var(--pi-accent); }
    #tools-group[data-status="error"] > summary { color: var(--vscode-errorForeground); }
    #tools { margin-top: 8px; }
    .tool summary { padding: 6px 8px; cursor: pointer; color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
    .tool.running summary { color: var(--pi-accent); }
    .tool.error summary { color: var(--vscode-errorForeground); }
    .tool pre, .background-output { max-height: 120px; overflow: auto; margin: 0; padding: 8px; border-top: 1px solid var(--pi-border); white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
    .change { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 6px 8px; }
    .change-label { flex: 1 1 100px; }
    .change-label, .background-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .change-actions { margin-top: 0; }
    .section-heading { display: flex; justify-content: space-between; gap: 8px; align-items: center; margin: 4px 0 8px; color: var(--vscode-descriptionForeground); font-size: .85em; font-weight: 500; }
    #source-control { min-height: 24px; font-size: inherit; }
    #attachments { display: flex; align-items: flex-start; gap: 7px; flex-wrap: wrap; padding: 9px 10px 1px; }
    .attachment-chip { display: inline-flex; max-width: 100%; align-items: center; gap: 4px; padding: 3px 4px 3px 7px; border-radius: 5px; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); font-size: .82em; }
    .attachment-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .attachment-chip button { min-height: 20px; width: 20px; padding: 0; color: inherit; background: transparent; }
    .attachment-image { position: relative; display: grid; width: 104px; min-width: 0; overflow: hidden; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--vscode-editor-background); box-shadow: 0 1px 2px rgba(0, 0, 0, .16); }
    button.composer-image { display: block; width: 100%; height: 72px; min-height: 72px; padding: 0; overflow: hidden; border: 0; border-radius: 0; color: var(--vscode-descriptionForeground); background: var(--vscode-input-background); }
    button.composer-image:hover:not(:disabled) { background: var(--vscode-list-hoverBackground, var(--vscode-toolbar-hoverBackground)); }
    .composer-image img { display: block; width: 100%; height: 100%; object-fit: cover; }
    .composer-image-placeholder { display: grid; width: 100%; height: 100%; place-items: center; padding: 8px; text-align: center; font-size: .78em; line-height: 1.25; }
    .composer-image-label { display: block; min-width: 0; padding: 5px 7px 6px; overflow: hidden; color: var(--vscode-descriptionForeground); font-size: .76em; line-height: 1.2; text-overflow: ellipsis; white-space: nowrap; }
    button.attachment-remove { position: absolute; top: 5px; right: 5px; width: 21px; min-height: 21px; padding: 0; border: 1px solid rgba(255, 255, 255, .35); border-radius: 50%; color: #fff; background: rgba(0, 0, 0, .66); font-size: 15px; line-height: 1; }
    button.attachment-remove:hover:not(:disabled) { background: rgba(0, 0, 0, .86); }
    button.composer-image:focus-visible, button.attachment-remove:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--vscode-focusBorder); }
    #composer { min-width: 0; padding-top: 12px; }
    .composer-box { position: relative; overflow: hidden; background: var(--pi-composer-background); border: 1px solid var(--vscode-input-border, var(--pi-border)); border-radius: 14px; box-shadow: 0 4px 16px var(--vscode-widget-shadow, rgba(0, 0, 0, .2)); }
    .composer-box:focus-within { border-color: var(--vscode-focusBorder); box-shadow: 0 6px 20px var(--vscode-widget-shadow, rgba(0, 0, 0, .24)); }
    textarea { display: block; width: 100%; height: 42px; min-height: 42px; max-height: min(220px, 28vh); resize: none; padding: 11px 13px 7px; color: var(--vscode-input-foreground); background: transparent; border: 0; border-radius: 14px 14px 6px 6px; font: inherit; line-height: 1.5; scrollbar-width: thin; }
    textarea:focus-visible { outline: none; }
    textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
    #attachment-estimate, #queue-status { padding: 0 12px; }
    #pending-queue { display: grid; gap: 4px; padding: 5px 10px 1px; }
    #pending-queue[hidden] { display: none; }
    .pending-queue-item { display: flex; min-width: 0; gap: 5px; padding: 4px 7px; border-radius: 5px; color: var(--vscode-descriptionForeground); background: var(--vscode-editorWidget-background, var(--vscode-input-background)); font-size: .8em; line-height: 1.3; }
    .pending-queue-kind { flex: 0 0 auto; font-weight: 600; }
    .pending-queue-text { min-width: 0; overflow: hidden; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
    #inspect-context { margin: 3px 10px 0; }
    .composer-box > .proposal-actions { padding: 0 10px; }
    .composer-actions { display: flex; flex-wrap: nowrap; min-width: 0; gap: 6px; padding: 3px 8px 8px; align-items: center; }
    .composer-actions > button, .composer-actions > select { min-height: 30px; border-radius: 8px; }
    #add-context { flex: 0 1 auto; min-width: 30px; border-color: transparent; color: var(--vscode-descriptionForeground); font-size: .9em; }
    .composer-spacer { min-width: 0; flex: 1; }
    #model-picker, #thinking-level { border-color: var(--pi-control-border); background: var(--pi-control-background); }
    #model-picker:hover:not(:disabled), #thinking-level:hover:not(:disabled) { background: var(--vscode-list-hoverBackground, var(--vscode-toolbar-hoverBackground)); }
    #send { width: 30px; flex: 0 0 30px; padding: 6px; }
    #send:disabled { border-color: transparent; color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground)); background: var(--vscode-toolbar-hoverBackground); opacity: .72; }
    #cancel { border-color: var(--pi-control-border); font-size: .9em; }
    #composer-hint { min-height: 16px; margin: 6px 4px 0; color: var(--vscode-descriptionForeground); font-size: .75em; line-height: 1.35; text-align: right; overflow-wrap: anywhere; }
    #notice { max-height: 20vh; overflow-y: auto; padding: 7px 2px 0; color: var(--vscode-descriptionForeground); font-size: .85em; overflow-wrap: anywhere; }
    #notice:empty { display: none; }
    #notice.error { color: var(--vscode-errorForeground); }
    #notice.warning { color: var(--vscode-editorWarning-foreground); }
    #notice button { min-height: 22px; margin-left: 6px; padding: 1px 5px; color: inherit; font-size: inherit; }
    #image-preview { width: min(92vw, 900px); max-width: 100%; max-height: 92vh; padding: 10px; border: 1px solid var(--vscode-contrastBorder, var(--pi-border)); border-radius: 9px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    #image-preview::backdrop { background: rgba(0, 0, 0, .66); }
    .preview-header { display: flex; min-width: 0; align-items: center; gap: 8px; margin-bottom: 8px; }
    #preview-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #preview-close { flex: 0 0 auto; }
    #preview-image { display: block; max-width: 100%; max-height: calc(92vh - 62px); margin: auto; object-fit: contain; }
    body.vscode-high-contrast .composer-box, body.vscode-high-contrast-light .composer-box,
    body.vscode-high-contrast .welcome-action, body.vscode-high-contrast-light .welcome-action,
    body.vscode-high-contrast .attachment-image, body.vscode-high-contrast-light .attachment-image { border-color: var(--vscode-contrastBorder); }
    body.vscode-high-contrast .composer-box:focus-within, body.vscode-high-contrast-light .composer-box:focus-within { border-color: var(--vscode-focusBorder); }
    @media (max-width: 340px) { #app { padding: 0 8px 8px; } .sessions-actions { gap: 0; } #session { display: none; } .composer-actions { gap: 4px; padding-left: 6px; padding-right: 6px; } #add-context span { display: none; } #model-picker { max-width: 88px; } #thinking-level { max-width: 84px; } .empty { padding-left: 2px; padding-right: 2px; } .empty h2 { font-size: 1.5em; } button.welcome-action { gap: 9px; padding: 10px; } }
    @media (max-height: 500px) { .empty { padding-top: 8px; padding-bottom: 16px; } .welcome-mark { display: none; } .empty-actions { margin-top: 16px; } }
    @media (prefers-reduced-motion: no-preference) { button { transition: background-color .12s ease, border-color .12s ease, transform .08s ease; } .composer-box { transition: border-color .12s ease, box-shadow .12s ease; } }
  </style>
</head>
<body>
  <main id="app" class="sessions-layer">
    <section id="sessions" aria-label="Pi sessions">
      <div class="sessions-header">
        <button id="back-to-sessions" class="secondary icon-button" type="button" title="Back to Sessions" aria-label="Back to Sessions" hidden>${icon("back")}</button>
        <span id="session-header-title" class="sessions-title">Sessions</span>
        <div class="sessions-actions" aria-label="Pi session controls">
          <button id="new-session" class="secondary icon-button" type="button" title="New session" aria-label="New Pi session">${icon("plus")}</button>
          <button id="delete-session" class="secondary danger icon-button" type="button" title="Delete session" aria-label="Delete current Pi session" hidden>${icon("trash")}</button>
          <button id="more" class="secondary icon-button" type="button" title="More… · Session and advanced actions" aria-label="More Pi actions">${icon("more")}</button>
        </div>
      </div>
      <div id="session-list-content">
        <div id="recent-session-list" class="session-list" aria-label="Recent sessions"></div>
        <button id="view-all-sessions" class="secondary" type="button">View all</button>
        <div id="sessions-browser" hidden>
          <label class="session-search" for="session-search-input">${icon("search")}<span class="sr-only">Search recent sessions</span><input id="session-search-input" type="search" placeholder="Search recent sessions" autocomplete="off"></label>
          <div class="session-filter">This workspace</div>
          <div id="all-session-list" class="session-list" aria-label="All sessions in this workspace"></div>
          <p id="no-sessions" hidden>No sessions found.</p>
        </div>
      </div>
    </section>
    <section id="conversation" aria-label="Pi conversation">
      <section id="messages" aria-live="off"></section>
      <details id="tools-group" hidden><summary><span id="tools-summary">Tool activity</span></summary><section id="tools" aria-label="Pi tool activity"></section></details>
    </section>
    <section id="activity" aria-label="Pi workflow activity" hidden>
      <div id="proposals-heading" class="section-heading" hidden><span>Edit proposals</span></div><section id="proposals" aria-label="Pi edit proposals"></section>
      <div id="changes-heading" class="section-heading" hidden><span>Pi changes</span><button id="source-control" class="secondary" type="button">Source Control</button></div><section id="changes" aria-label="Pi file changes"></section>
      <div id="background-heading" class="section-heading" hidden><span>Background agents</span></div><section id="background" aria-label="Background Pi agents"></section>
    </section>
    <section id="composer" aria-label="Message composer">
      <div class="composer-box">
        <div id="attachments" aria-label="Context attached to the next message" hidden></div>
        <button id="inspect-context" class="secondary" type="button" hidden>View attachments</button>
        <div id="attachment-estimate" class="proposal-meta"></div>
        <div id="pending-queue" role="list" aria-label="Pending Pi messages" hidden></div>
        <label for="input" class="sr-only">Message Pi</label>
        <textarea id="input" rows="1" maxlength="${maxInputCharacters}" placeholder="Ask Pi anything…" aria-describedby="composer-hint"></textarea>
        <div id="queue-status" class="proposal-meta" role="status"></div>
        <div class="proposal-actions">
          <button id="recover-queue" class="secondary" type="button" hidden>Restore drafts</button>
        </div>
        <div class="composer-actions">
          <button id="add-context" class="secondary" type="button" title="Attach code, files, or images">${icon("attachment")}<span>Attach</span></button>
          <span class="composer-spacer"></span>
          <button id="cancel" class="secondary" type="button" aria-label="Cancel Pi response" hidden>${icon("stop")}<span>Stop</span></button>
          <button id="model-picker" class="secondary" type="button" aria-label="Change Pi model"><span id="model-label">Choose model…</span>${icon("chevron")}</button>
          <label for="thinking-level" class="sr-only">Pi thinking level</label>
          <select id="thinking-level" aria-label="Pi thinking level" title="Pi thinking level"><option value="">Thinking: —</option></select>
          <button id="send" type="button" aria-label="Send message" title="Send message" disabled>${icon("send")}</button>
        </div>
      </div>
      <div id="composer-hint">Enter to send · Shift+Enter for a new line</div>
    </section>
    <div id="notice" role="status" aria-live="polite"></div>
    <div id="runtime"><span class="status-dot" aria-hidden="true"></span><span id="status" role="status" aria-live="polite">Connecting…</span><span id="session"></span><span id="usage"></span><button id="retry" class="secondary" type="button" hidden>Retry</button><button id="refresh-history" class="secondary" type="button" hidden>Refresh history</button><button id="reconnect" class="secondary" type="button" hidden>Reconnect</button></div>
  </main>
  <dialog id="image-preview" aria-labelledby="preview-label">
    <div class="preview-header"><span id="preview-label"></span><button id="preview-close" class="secondary" type="button" aria-label="Close image preview">Close</button></div>
    <img id="preview-image" alt="">
  </dialog>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const $ = id => document.getElementById(id);
    const appElement = $('app');
    const conversationElement = $('conversation');
    const messagesElement = $('messages');
    const recentSessionList = $('recent-session-list');
    const allSessionList = $('all-session-list');
    const sessionSearchInput = $('session-search-input');
    const emptyActionButtons = [];
    const toolsElement = $('tools');
    const proposalsElement = $('proposals');
    const changesElement = $('changes');
    const backgroundElement = $('background');
    const attachmentsElement = $('attachments');
    const input = $('input');
    const sendButton = $('send');
    const cancelButton = $('cancel');
    const notice = $('notice');
    const thinkingLevel = $('thinking-level');
    const clientPlatform = typeof navigator.userAgentData?.platform === 'string'
      ? navigator.userAgentData.platform
      : navigator.platform || '';
    const useCtrlQForFollowUp = /^win/i.test(clientPlatform)
      || /\\bwindows\\b/i.test(navigator.userAgent || '');
    const followUpShortcutLabel = useCtrlQForFollowUp ? 'Ctrl+Q' : 'Alt+Enter';
    $('composer-hint').textContent = 'Enter to send · Shift+Enter for a new line';
    const imageAssetCache = new Map();
    const imageTargets = new Map();
    const maxImageAssetCacheBytes = 25 * 1024 * 1024;
    const maxImageAssets = 100;
    let imageAssetCacheBytes = 0;
    let previewAssetId;
    let previewTargetIndex = 0;
    let busy = false;
    let cancellable = false;
    let queueable = false;
    let connected = false;
    let deletableSession = false;
    let imageSupported = true;
    let attachedItems = false;
    let attachedImages = false;
    let pendingImageReads = 0;
    let submissionPending = false;
    let backgroundSubmissionPending = false;
    let composerRevision = 0;
    let updatingControls = false;
    let thinkingSelectable = false;
    let latestStatus = 'Connecting…';
    let conversationPinnedToBottom = true;
    let programmaticConversationScrollTop;
    let renderedMessageStructure = '';
    let renderedMessageHtml = [];
    let renderedToolIds = '';
    let toolActivityRunning = false;
    let toolRequestBusy = false;
    let renderedProposals = '';
    let renderedChanges = '';
    let renderedBackground = '';
    let renderedAttachments = '';
    let recentSessions = [];
    let sessionsLayerVisible = true;
    let sessionsExpanded = false;
    let sessionSwitchPending;
    let newSessionSourceWasList;
    let recoveredDraftPending;
    let sessionButtons = [];

    function showNotice(message, level, detailsAvailable = false, transientLock = false) {
      notice.textContent = message;
      notice.className = level || '';
      notice.dataset.transientLock = transientLock ? 'true' : '';
      if (detailsAvailable) {
        const details = document.createElement('button');
        details.className = 'secondary';
        details.type = 'button';
        details.textContent = 'Details';
        details.dataset.noticeDetails = 'true';
        notice.appendChild(details);
      }
    }

    function clearNotice() {
      notice.replaceChildren();
      notice.textContent = '';
      notice.className = '';
      notice.dataset.transientLock = '';
    }

    function updateRuntimeStatus() {
      const imageLoading = pendingImageReads > 0;
      const displayed = imageLoading
        ? 'Loading pasted image…'
        : backgroundSubmissionPending
          ? 'Starting background agent…'
          : submissionPending
            ? 'Sending to Pi…'
            : latestStatus;
      $('status').textContent = displayed;
      $('status').title = displayed;
    }

    function setConversationScrollTop(scrollTop) {
      conversationElement.scrollTop = scrollTop;
      programmaticConversationScrollTop = conversationElement.scrollTop;
    }

    function scrollConversationToBottom() {
      conversationPinnedToBottom = true;
      const scroll = () => {
        if (conversationPinnedToBottom) setConversationScrollTop(conversationElement.scrollHeight);
      };
      scroll();
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(scroll);
    }

    function submit(kind = 'steer') {
      const text = input.value.trim();
      if ((!text && !attachedItems) || !connected || submissionPending || backgroundSubmissionPending) return;
      if (pendingImageReads > 0 || (attachedImages && !imageSupported)) return;
      if (sessionsLayerVisible && busy) {
        showNotice('Wait for Pi to finish before starting a new session.', 'warning', false, true);
        return;
      }
      if (busy) {
        if (!queueable) {
          showNotice('This request does not accept queued messages.', 'warning', false, true);
          return;
        }
        submissionPending = true;
        updateSendState();
        vscode.postMessage({ type: 'queueInstruction', kind, text: input.value, revision: composerRevision });
      } else {
        submissionPending = true;
        updateSendState();
        vscode.postMessage({ type: sessionsLayerVisible ? 'sendNewSession' : 'send', text: input.value, revision: composerRevision });
      }
      clearNotice();
    }

    function forgetImageTargets(composer) {
      for (const [assetId, targets] of imageTargets) {
        const retained = targets.filter(target => target.composer !== composer);
        if (retained.length) imageTargets.set(assetId, retained);
        else imageTargets.delete(assetId);
      }
    }

    function renderMessages(messages) {
      const followConversation = conversationPinnedToBottom;
      const visibleMessages = messages.filter(message => message.role !== 'assistant' || Boolean(message.html));
      const structure = JSON.stringify(visibleMessages.map((message, index) => [message.id || index, message.role, message.attachments || [], Boolean(message.truncated)]));
      const html = visibleMessages.map(message => message.html || (message.role === 'assistant' ? '…' : ''));
      messagesElement.classList.toggle('is-empty', visibleMessages.length === 0);

      const expectedChildren = visibleMessages.length || 1;
      if (structure === renderedMessageStructure && messagesElement.children.length === expectedChildren) {
        for (let index = 0; index < html.length; index += 1) {
          if (html[index] === renderedMessageHtml[index]) continue;
          const content = messagesElement.children[index]?.children[1];
          if (content) content.innerHTML = html[index];
        }
        renderedMessageHtml = html;
        return visibleMessages.length > 0 && followConversation;
      }

      messagesElement.replaceChildren();
      forgetImageTargets(false);
      emptyActionButtons.length = 0;
      if (visibleMessages.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.innerHTML = '<div class="welcome-mark" aria-hidden="true">π</div><h2>Let’s build something.</h2><p>Ask a question, shape a plan, or put Pi to work.</p>';
        const actions = document.createElement('div');
        actions.className = 'empty-actions';
        for (const item of [
          ['selection', 'Explore your code', 'Ask about the current selection', '${icon("selection")}'],
          ['plan', 'Plan a change', 'Think it through before editing', '${icon("plan")}'],
          ['agent', 'Build with Pi', 'Work on a task from start to finish', '${icon("agent")}'],
        ]) {
          const button = document.createElement('button');
          button.className = 'secondary welcome-action';
          button.type = 'button';
          button.dataset.emptyAction = item[0];
          button.innerHTML = '<span class="action-icon">' + item[3] + '</span><span class="action-copy"><span class="action-title"></span><span class="action-description"></span></span><span class="action-arrow">${icon("arrow")}</span>';
          button.querySelector('.action-title').textContent = item[1];
          button.querySelector('.action-description').textContent = item[2];
          actions.appendChild(button);
          emptyActionButtons.push(button);
        }
        empty.appendChild(actions);
        messagesElement.appendChild(empty);
      } else {
        for (let index = 0; index < visibleMessages.length; index += 1) {
          const message = visibleMessages[index];
          const wrapper = document.createElement('article');
          wrapper.className = 'message ' + message.role;
          const role = document.createElement('div');
          role.className = 'role';
          role.textContent = message.role === 'user' ? 'You' : 'Pi';
          const content = document.createElement('div');
          content.className = 'content';
          content.innerHTML = html[index];
          wrapper.append(role, content);
          messagesElement.appendChild(wrapper);
          const attachments = Array.isArray(message.attachments) ? message.attachments : [];
          const contexts = attachments.filter(attachment => attachment.type === 'context');
          if (contexts.length) {
            const contextList = document.createElement('div');
            contextList.className = 'transcript-contexts';
            contextList.setAttribute('aria-label', 'Context used for this message');
            for (const attachment of contexts) {
              const context = document.createElement('span');
              context.className = 'context';
              context.textContent = attachment.label;
              context.title = attachment.fullLabel;
              contextList.appendChild(context);
            }
            wrapper.appendChild(contextList);
          }
          const images = attachments.filter(attachment => attachment.type === 'image');
          if (images.length) {
            const imageGrid = document.createElement('div');
            imageGrid.className = 'transcript-images';
            imageGrid.setAttribute('aria-label', 'Images used for this message');
            wrapper.appendChild(imageGrid);
            for (const attachment of images) {
              const button = document.createElement('button');
              button.className = 'secondary transcript-image';
              button.type = 'button';
              button.dataset.previewAsset = attachment.assetId;
              const targets = imageTargets.get(attachment.assetId) || [];
              targets.push({ button, attachment, composer: false });
              imageTargets.set(attachment.assetId, targets);
              imageGrid.appendChild(button);
              renderTranscriptImage(button, attachment);
            }
          }
          if (message.truncated) {
            const truncated = document.createElement('div');
            truncated.className = 'truncated';
            truncated.textContent = 'Older content not shown';
            wrapper.appendChild(truncated);
          }
        }
      }
      renderedMessageStructure = structure;
      renderedMessageHtml = html;
      if (visibleMessages.length === 0) {
        setConversationScrollTop(0);
        conversationPinnedToBottom = true;
      }
      return visibleMessages.length > 0 && followConversation;
    }

    function renderTranscriptImage(button, attachment) {
      button.replaceChildren();
      button.title = attachment.fullLabel;
      const cached = imageAssetCache.get(attachment.assetId);
      if (cached) {
        button.disabled = false;
        button.setAttribute('aria-label', 'Preview ' + attachment.fullLabel);
        const beforeHeight = conversationElement.scrollHeight;
        const beforeTop = conversationElement.scrollTop;
        const wasNearBottom = beforeHeight - beforeTop - conversationElement.clientHeight < 80;
        const thumbnailRect = button.getBoundingClientRect();
        const viewportRect = conversationElement.getBoundingClientRect();
        const wasBelowViewport = thumbnailRect.top >= viewportRect.bottom;
        const image = document.createElement('img');
        image.alt = attachment.fullLabel;
        if (attachment.width && attachment.height) { image.width = attachment.width; image.height = attachment.height; }
        image.addEventListener('load', () => {
          const heightDelta = conversationElement.scrollHeight - beforeHeight;
          setConversationScrollTop(wasNearBottom
            ? conversationElement.scrollHeight
            : wasBelowViewport ? beforeTop : beforeTop + Math.max(0, heightDelta));
        });
        image.addEventListener('error', () => rejectImageAsset(attachment.assetId));
        image.src = cached.url;
        button.appendChild(image);
      } else {
        button.disabled = attachment.availability !== 'available';
        button.setAttribute('aria-label', (button.disabled ? 'Unavailable image: ' : 'Loading image: ') + attachment.fullLabel);
        const placeholder = document.createElement('span');
        placeholder.className = 'image-placeholder';
        placeholder.textContent = button.disabled ? 'Image unavailable' : 'Loading image…';
        button.appendChild(placeholder);
      }
      const label = document.createElement('span');
      label.className = 'image-label';
      label.textContent = attachment.label;
      label.title = attachment.fullLabel;
      button.appendChild(label);
    }

    function renderComposerImage(button, attachment) {
      button.replaceChildren();
      button.title = attachment.fullLabel;
      const cached = imageAssetCache.get(attachment.assetId);
      if (cached) {
        button.disabled = false;
        button.setAttribute('aria-label', 'Preview ' + attachment.fullLabel);
        const image = document.createElement('img');
        image.alt = attachment.fullLabel;
        if (attachment.width && attachment.height) { image.width = attachment.width; image.height = attachment.height; }
        image.addEventListener('error', () => rejectImageAsset(attachment.assetId));
        image.src = cached.url;
        button.appendChild(image);
      } else {
        button.disabled = attachment.availability !== 'available';
        button.setAttribute('aria-label', (button.disabled ? 'Unavailable image: ' : 'Loading image: ') + attachment.fullLabel);
        const placeholder = document.createElement('span');
        placeholder.className = 'composer-image-placeholder';
        placeholder.textContent = button.disabled ? 'Preview unavailable' : 'Loading preview…';
        button.appendChild(placeholder);
      }
    }

    function rerenderImageTarget(target) {
      if (target.composer) renderComposerImage(target.button, target.attachment);
      else renderTranscriptImage(target.button, target.attachment);
    }

    function acceptImageAsset(message) {
      if (typeof message.id !== 'string' || !/^sha256-[a-f0-9]{64}$/.test(message.id)) return;
      if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(message.mimeType)) return;
      if (!Number.isInteger(message.byteLength) || message.byteLength <= 0 || message.byteLength > ${maxImageBytes}) return;
      if (typeof message.data !== 'string' || message.data.length > Math.ceil(${maxImageBytes} / 3) * 4 + 4 || message.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(message.data)) return;
      let decoded;
      try { decoded = atob(message.data); } catch { return; }
      if (decoded.length !== message.byteLength || btoa(decoded) !== message.data) return;
      if (imageAssetCache.has(message.id)) return;
      while (imageAssetCache.size && (imageAssetCacheBytes + message.byteLength > maxImageAssetCacheBytes || imageAssetCache.size >= maxImageAssets)) {
        const oldestId = imageAssetCache.keys().next().value;
        const oldest = imageAssetCache.get(oldestId);
        imageAssetCache.delete(oldestId);
        imageAssetCacheBytes -= oldest.byteLength;
        for (const target of imageTargets.get(oldestId) || []) {
          target.attachment.availability = 'unavailable';
          rerenderImageTarget(target);
        }
        vscode.postMessage({ type: 'imageAssetEvicted', id: oldestId });
      }
      imageAssetCache.set(message.id, { url: 'data:' + message.mimeType + ';base64,' + message.data, byteLength: message.byteLength });
      imageAssetCacheBytes += message.byteLength;
      for (const target of imageTargets.get(message.id) || []) rerenderImageTarget(target);
    }

    function rejectImageAsset(id) {
      const asset = imageAssetCache.get(id);
      if (!asset) return;
      imageAssetCache.delete(id);
      imageAssetCacheBytes -= asset.byteLength;
      for (const target of imageTargets.get(id) || []) {
        target.attachment.availability = 'unavailable';
        rerenderImageTarget(target);
      }
      if (previewAssetId === id) closeImagePreview();
      vscode.postMessage({ type: 'imageAssetRejected', id });
    }

    function renderProposals(proposals) {
      const signature = JSON.stringify([busy, proposals]);
      if (signature === renderedProposals) return;
      proposalsElement.replaceChildren();
      $('proposals-heading').hidden = proposals.length === 0;
      for (const proposal of proposals) {
        const card = document.createElement('article');
        card.className = 'proposal';
        const title = document.createElement('div');
        title.className = 'proposal-title';
        title.textContent = proposal.label;
        const meta = document.createElement('div');
        meta.className = 'proposal-meta';
        const statusLabels = { ready: 'Ready to preview', previewing: 'Previewing…', previewed: 'Previewed', applying: 'Applying…', rejecting: 'Rejecting…', applied: 'Applied', rejected: 'Rejected', stale: 'Stale', failed: 'Failed' };
        const selection = proposal.totalHunks !== undefined ? ' · ' + (proposal.selected || []).length + '/' + proposal.totalHunks + ' selected' : '';
        meta.textContent = proposal.summary || (statusLabels[proposal.status] || proposal.status) + selection;
        card.append(title, meta);
        if (proposal.error) {
          const error = document.createElement('div');
          error.className = 'proposal-error';
          error.textContent = proposal.error;
          card.appendChild(error);
        }
        const terminal = ['applied', 'rejected', 'stale'].includes(proposal.status);
        if (!terminal) {
          const actions = document.createElement('div');
          actions.className = 'proposal-actions';
          const transitioning = ['previewing', 'applying', 'rejecting'].includes(proposal.status);
          const noHunksSelected = proposal.totalHunks !== undefined && !(proposal.selected || []).length;
          for (const definition of [['select', 'Choose Hunks'], ['preview', 'Preview'], ['apply', 'Apply'], ['reject', 'Reject']]) {
            if (definition[0] === 'select' && proposal.totalHunks === undefined) continue;
            const button = document.createElement('button');
            button.className = definition[0] === 'apply' ? '' : 'secondary';
            button.type = 'button';
            button.textContent = definition[1];
            button.dataset.proposalAction = definition[0];
            button.dataset.id = proposal.id;
            button.disabled = busy || transitioning || (definition[0] === 'preview' && noHunksSelected) || (definition[0] === 'apply' && proposal.status !== 'previewed');
            actions.appendChild(button);
          }
          card.appendChild(actions);
        }
        proposalsElement.appendChild(card);
      }
      renderedProposals = signature;
    }

    function renderTools(tools) {
      const group = $('tools-group');
      group.hidden = tools.length === 0;
      const running = tools.filter(tool => tool.status === 'running');
      const failed = tools.filter(tool => tool.status === 'error');
      const isRunning = running.length > 0;
      const requestSettled = toolRequestBusy && !busy;
      if (!tools.length || requestSettled) group.open = false;
      else if (isRunning && !toolActivityRunning) group.open = true;
      toolActivityRunning = isRunning;
      toolRequestBusy = busy;
      group.dataset.status = running.length ? 'running' : failed.length ? 'error' : 'success';
      $('tools-summary').textContent = running.length
        ? 'Running · ' + running[running.length - 1].name + (running.length > 1 ? ' · ' + running.length + ' active' : '')
        : tools.length + (tools.length === 1 ? ' tool call' : ' tool calls') + (failed.length ? ' · ' + failed.length + ' failed' : ' · completed');
      const ids = tools.map(tool => tool.id).join('|');
      if (ids === renderedToolIds && toolsElement.children.length === tools.length) {
        for (let index = 0; index < tools.length; index += 1) {
          const details = toolsElement.children[index];
          const tool = tools[index];
          const previousStatus = details.dataset.status;
          details.className = 'tool ' + tool.status;
          details.dataset.status = tool.status;
          if (requestSettled || (previousStatus === 'running' && tool.status !== 'running' && !busy)) details.open = false;
          details.children[0].textContent = (tool.status === 'running' ? 'Running · ' : tool.status === 'error' ? 'Failed · ' : 'Completed · ') + tool.name;
          const output = details.children[1];
          const outputText = tool.output || tool.input;
          if (output.textContent !== outputText) {
            const followOutput = output.scrollHeight - output.scrollTop - output.clientHeight <= 16;
            output.textContent = outputText;
            if (followOutput) output.scrollTop = output.scrollHeight;
          }
        }
        return;
      }
      // Preserve user disclosure choices when the tool list itself changes.
      const openTools = new Map(Array.from(toolsElement.children, details => [details.dataset.id, details.open]));
      toolsElement.replaceChildren();
      for (const tool of tools) {
        const details = document.createElement('details');
        details.className = 'tool ' + tool.status;
        details.dataset.id = tool.id;
        details.dataset.status = tool.status;
        details.open = openTools.get(tool.id) ?? tool.status === 'running';
        const summary = document.createElement('summary');
        summary.textContent = (tool.status === 'running' ? 'Running · ' : tool.status === 'error' ? 'Failed · ' : 'Completed · ') + tool.name;
        const pre = document.createElement('pre');
        pre.textContent = tool.output || tool.input;
        details.append(summary, pre);
        toolsElement.appendChild(details);
      }
      renderedToolIds = ids;
    }

    function renderChanges(changes) {
      const signature = JSON.stringify(changes);
      if (signature === renderedChanges) return;
      changesElement.replaceChildren();
      $('changes-heading').hidden = changes.length === 0;
      for (const change of changes) {
        const row = document.createElement('div');
        row.className = 'change';
        const label = document.createElement('span');
        label.className = 'change-label';
        label.textContent = (change.created ? 'Created · ' : change.deleted ? 'Deleted · ' : 'Modified · ') + change.label;
        label.title = change.label;
        const actions = document.createElement('span');
        actions.className = 'change-actions';
        for (const definition of [['openChange', 'Open'], ['reviewChange', 'Diff'], ['revertChange', 'Revert']]) {
          const button = document.createElement('button');
          button.className = 'secondary';
          button.type = 'button';
          button.textContent = definition[1];
          button.dataset.action = definition[0];
          button.dataset.id = change.id;
          button.disabled = definition[0] === 'reviewChange' ? !change.canPreview : definition[0] === 'revertChange' ? !change.canRevert : change.deleted;
          actions.appendChild(button);
        }
        row.append(label, actions);
        changesElement.appendChild(row);
      }
      renderedChanges = signature;
    }

    function renderBackground(tasks) {
      const signature = JSON.stringify([busy, tasks]);
      if (signature === renderedBackground) return;
      backgroundElement.replaceChildren();
      $('background-heading').hidden = tasks.length === 0;
      for (const task of tasks) {
        const card = document.createElement('article');
        card.className = 'background-task';
        const title = document.createElement('div');
        title.className = 'background-title';
        title.textContent = task.title;
        const meta = document.createElement('div');
        meta.className = 'background-meta';
        meta.textContent = task.status + (task.tool ? ' · ' + task.tool : '') + (task.worktreePath ? ' · worktree' : '');
        const output = document.createElement('div');
        output.className = 'background-output';
        output.textContent = (task.error || task.output || '') + (task.importReport ? '\\nImport: ' + task.importReport.applied.length + ' applied, ' + task.importReport.skipped.length + ' skipped, ' + task.importReport.failed.length + ' failed' : '') + '\\nModel summary · tests not verified';
        const actions = document.createElement('div');
        actions.className = 'background-actions';
        const running = task.status === 'starting' || task.status === 'running';
        for (const definition of [['reviewBackground', 'Review Results', Boolean(task.origin && task.worktreePath) && !running], ['applyBackground', 'Apply Selected', Boolean(task.origin && task.worktreePath) && !running], ['cancelBackground', 'Cancel', running], ['resumeBackground', 'Resume', Boolean(task.sessionFile) && !task.worktreePath && !task.origin && !running], ['openWorktree', 'Open Worktree', Boolean(task.worktreePath)], ['cleanupWorktree', 'Remove Worktree', Boolean(task.worktreePath) && !running]]) {
          if (!definition[2]) continue;
          const button = document.createElement('button');
          button.className = 'secondary';
          button.type = 'button';
          button.textContent = definition[1];
          button.dataset.action = definition[0];
          button.dataset.id = task.id;
          button.disabled = Boolean(task.reviewing) || (definition[0] === 'applyBackground' && (busy || !task.resultPreviewReady));
          actions.appendChild(button);
        }
        card.append(title, meta, output, actions);
        backgroundElement.appendChild(card);
      }
      renderedBackground = signature;
    }

    function renderAttachments(attachments) {
      attachedItems = attachments.length > 0;
      attachedImages = attachments.some(attachment => attachment.image);
      attachmentsElement.hidden = attachments.length === 0;
      const signature = JSON.stringify(attachments);
      if (signature === renderedAttachments) return;
      forgetImageTargets(true);
      attachmentsElement.replaceChildren();
      for (const attachment of attachments) {
        if (attachment.image && attachment.assetId) {
          const card = document.createElement('span');
          card.className = 'attachment-image';
          const preview = document.createElement('button');
          preview.className = 'secondary composer-image';
          preview.type = 'button';
          preview.dataset.previewAsset = attachment.assetId;
          const targets = imageTargets.get(attachment.assetId) || [];
          targets.push({ button: preview, attachment, composer: true });
          imageTargets.set(attachment.assetId, targets);
          renderComposerImage(preview, attachment);
          const label = document.createElement('span');
          label.className = 'composer-image-label';
          label.textContent = attachment.label;
          label.title = attachment.fullLabel;
          const remove = document.createElement('button');
          remove.className = 'attachment-remove';
          remove.type = 'button';
          remove.textContent = '×';
          remove.title = 'Remove ' + attachment.fullLabel;
          remove.setAttribute('aria-label', 'Remove ' + attachment.fullLabel);
          remove.dataset.removeAttachment = attachment.id;
          card.append(preview, label, remove);
          attachmentsElement.appendChild(card);
          continue;
        }
        const chip = document.createElement('span');
        chip.className = 'attachment-chip';
        const label = document.createElement('span');
        label.className = 'attachment-label';
        label.textContent = (attachment.image ? 'Image · ' : '') + attachment.label;
        label.title = attachment.label;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = '×';
        remove.title = 'Remove ' + attachment.label;
        remove.setAttribute('aria-label', 'Remove ' + attachment.label);
        remove.dataset.removeAttachment = attachment.id;
        chip.append(label, remove);
        attachmentsElement.appendChild(chip);
      }
      renderedAttachments = signature;
    }

    function resizeInput() {
      input.style.height = '0px';
      input.style.height = input.scrollHeight + 'px';
    }

    function setComposerInput(text) {
      input.value = text;
      resizeInput();
      composerRevision += 1;
      updateSendState();
      input.focus();
    }

    function formatThinkingLevel(level) {
      if (level === 'xhigh') return 'X-high';
      return level.charAt(0).toUpperCase() + level.slice(1);
    }

    function renderThinkingLevel(runtime) {
      const available = Array.isArray(runtime.availableThinkingLevels)
        ? runtime.availableThinkingLevels.filter(level => typeof level === 'string')
        : [];
      const current = typeof runtime.thinkingLevel === 'string' ? runtime.thinkingLevel : '';
      const levels = current && !available.includes(current) ? [current, ...available] : available;
      const signature = levels.join('|');
      if (thinkingLevel.dataset.levels !== signature) {
        thinkingLevel.replaceChildren();
        if (levels.length === 0) {
          const option = document.createElement('option');
          option.value = '';
          option.textContent = 'Thinking: —';
          thinkingLevel.appendChild(option);
        } else {
          for (const level of levels) {
            const option = document.createElement('option');
            option.value = level;
            option.textContent = 'Thinking: ' + formatThinkingLevel(level);
            thinkingLevel.appendChild(option);
          }
        }
        thinkingLevel.dataset.levels = signature;
      }
      thinkingSelectable = levels.length > 1;
      thinkingLevel.value = current || levels[0] || '';
      thinkingLevel.title = current ? 'Pi thinking level: ' + formatThinkingLevel(current) : 'Pi thinking level unavailable';
    }

    function formatSessionAge(updatedAt) {
      const elapsed = Math.max(0, Date.now() - Number(updatedAt || 0));
      const minute = 60 * 1000;
      const hour = 60 * minute;
      const day = 24 * hour;
      if (elapsed < minute) return 'now';
      if (elapsed < hour) return Math.floor(elapsed / minute) + 'm';
      if (elapsed < day) return Math.floor(elapsed / hour) + 'h';
      if (elapsed < 7 * day) return Math.floor(elapsed / day) + 'd';
      const date = new Date(Number(updatedAt));
      return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }

    function isInteractionLocked() {
      return busy || submissionPending || backgroundSubmissionPending || pendingImageReads > 0 || Boolean(recoveredDraftPending);
    }

    function createSessionRow(session) {
      const button = document.createElement('button');
      button.className = 'secondary session-row';
      button.classList.toggle('current', Boolean(session.current));
      button.type = 'button';
      button.dataset.sessionId = session.id;
      button.title = session.title;
      button.disabled = isInteractionLocked() || Boolean(sessionSwitchPending);
      if (session.current) button.setAttribute('aria-current', 'page');
      const title = document.createElement('span');
      title.className = 'session-row-title';
      title.textContent = session.title;
      const time = document.createElement('span');
      time.className = 'session-row-time';
      time.textContent = formatSessionAge(session.updatedAt);
      button.append(title, time);
      sessionButtons.push(button);
      return button;
    }

    function renderSessions() {
      const query = sessionSearchInput.value.trim().toLocaleLowerCase();
      const filtered = query
        ? recentSessions.filter(session => session.title.toLocaleLowerCase().includes(query))
        : recentSessions;
      sessionButtons = [];
      recentSessionList.replaceChildren(...recentSessions.slice(0, 3).map(createSessionRow));
      allSessionList.replaceChildren(...filtered.map(createSessionRow));
      $('no-sessions').hidden = filtered.length > 0;
      $('view-all-sessions').textContent = 'View all (' + recentSessions.length + ')';
      $('view-all-sessions').hidden = !sessionsLayerVisible || sessionsExpanded || recentSessions.length === 0;
    }

    function updateSessionLayer() {
      const current = recentSessions.find(session => session.current);
      appElement.classList.toggle('sessions-layer', sessionsLayerVisible);
      appElement.classList.toggle('sessions-expanded', sessionsLayerVisible && sessionsExpanded);
      $('session-list-content').hidden = !sessionsLayerVisible;
      recentSessionList.hidden = sessionsExpanded;
      $('sessions-browser').hidden = !sessionsExpanded;
      $('back-to-sessions').hidden = sessionsLayerVisible && !sessionsExpanded;
      $('back-to-sessions').title = sessionsLayerVisible ? 'Back to recent Sessions' : 'Back to Sessions';
      $('session-header-title').textContent = sessionsLayerVisible ? 'Sessions' : current?.title || 'Session';
      $('session-header-title').title = sessionsLayerVisible ? '' : current?.title || '';
      input.placeholder = sessionsLayerVisible ? 'Start a new chat…' : 'Ask Pi anything…';
      renderSessions();
    }

    function showSessionDetail() {
      sessionsLayerVisible = false;
      updateSessionLayer();
      input.focus();
    }

    function showSessionsLayer() {
      sessionsLayerVisible = true;
      updateSessionLayer();
      if (sessionsExpanded) sessionSearchInput.focus();
      else {
        const recentButtons = sessionButtons.slice(0, Math.min(3, recentSessions.length));
        const currentId = recentSessions.find(session => session.current)?.id;
        const currentButton = recentButtons.find(button => button.dataset.sessionId === currentId);
        const target = [currentButton, ...recentButtons, $('view-all-sessions'), $('new-session'), cancelButton, $('reconnect'), input]
          .find(element => element && !element.hidden && !element.disabled);
        target?.focus();
      }
    }

    function setSessionsExpanded(expanded) {
      sessionsExpanded = expanded;
      if (!expanded) sessionSearchInput.value = '';
      updateSessionLayer();
      if (expanded) {
        vscode.postMessage({ type: 'refreshSessions' });
        sessionSearchInput.focus();
      } else {
        const viewAll = $('view-all-sessions');
        (viewAll.hidden || viewAll.disabled ? $('new-session') : viewAll).focus();
      }
    }

    function selectRecentSession(id) {
      const session = recentSessions.find(item => item.id === id);
      if (!session || isInteractionLocked() || sessionSwitchPending) return;
      if (session.current) {
        showSessionDetail();
        return;
      }
      sessionSwitchPending = id;
      renderSessions();
      vscode.postMessage({ type: 'switchRecentSession', id });
    }

    function renderPendingQueue(runtime) {
      const pending = runtime.pendingQueue || { steering: [], followUp: [] };
      const steering = Array.isArray(pending.steering) ? pending.steering : [];
      const followUp = Array.isArray(pending.followUp) ? pending.followUp : [];
      const rows = [];
      for (const [kind, label, items] of [['steering', 'Next:', steering], ['followUp', 'After this:', followUp]]) {
        for (const item of items) {
          if (!item || typeof item.text !== 'string') continue;
          const row = document.createElement('div');
          row.className = 'pending-queue-item';
          row.dataset.kind = kind;
          row.setAttribute('role', 'listitem');
          row.title = item.text;
          const kindLabel = document.createElement('span');
          kindLabel.className = 'pending-queue-kind';
          kindLabel.textContent = label;
          const text = document.createElement('span');
          text.className = 'pending-queue-text';
          text.textContent = item.text + (item.hasAttachments ? ' · with attachments' : '');
          row.append(kindLabel, text);
          rows.push(row);
        }
      }
      $('pending-queue').replaceChildren(...rows);
      $('pending-queue').hidden = rows.length === 0;
      $('queue-status').textContent = rows.length
        ? rows.length + (rows.length === 1 ? ' message queued' : ' messages queued')
        : '';
      $('pending-queue').title = 'Next: sent after the current tool finishes. After this: sent when Pi finishes responding.';
    }

    function updateSendState() {
      const imageBlocked = attachedImages && !imageSupported;
      const imageLoading = pendingImageReads > 0;
      const sessionStartBlocked = sessionsLayerVisible && busy;
      const interactionLocked = isInteractionLocked();
      if (!interactionLocked && notice.dataset.transientLock === 'true') clearNotice();
      $('model-picker').disabled = interactionLocked || !connected;
      thinkingLevel.disabled = interactionLocked || !connected || !thinkingSelectable;
      $('new-session').disabled = interactionLocked;
      $('delete-session').disabled = interactionLocked || !connected || !deletableSession;
      $('more').disabled = interactionLocked || !connected;
      $('recover-queue').disabled = interactionLocked;
      for (const button of sessionButtons) button.disabled = interactionLocked || Boolean(sessionSwitchPending);
      input.disabled = Boolean(recoveredDraftPending);
      $('add-context').disabled = Boolean(recoveredDraftPending);
      for (const button of emptyActionButtons) button.disabled = interactionLocked;
      sendButton.disabled = interactionLocked || sessionStartBlocked || !connected || (!input.value.trim() && !attachedItems) || imageBlocked;
      sendButton.title = imageLoading
        ? 'Wait for pasted images to finish loading.'
        : submissionPending
          ? 'Waiting for Pi to accept this message.'
          : backgroundSubmissionPending
            ? 'Wait for the background agent to finish starting.'
            : sessionStartBlocked
              ? 'Wait for Pi to finish before starting a new session.'
              : imageBlocked
                ? 'The current model does not support image attachments.'
                : !connected
                  ? 'Reconnect to Pi before sending.'
                  : !input.value.trim() && attachedItems ? 'Send attached context' : sessionsLayerVisible ? 'Start new session' : 'Send message';
      $('composer-hint').textContent = imageLoading
        ? 'Loading pasted image…'
        : backgroundSubmissionPending
          ? 'Starting background agent…'
          : sessionStartBlocked
            ? 'Wait for Pi to finish before starting a new chat'
            : imageBlocked
              ? 'Choose a model that supports images, or remove them'
              : queueable && !sessionsLayerVisible
                ? 'Enter to send next · ' + followUpShortcutLabel + ' to send after this · Shift+Enter for a new line'
                : busy
                  ? 'Wait for Pi to finish before sending'
                  : 'Enter to send · Shift+Enter for a new line';
      updateRuntimeStatus();
    }

    function render(state) {
      busy = Boolean(state.runtime.busy);
      cancellable = Boolean(state.runtime.cancellable);
      queueable = Boolean(state.runtime.queueable) && busy;
      renderPendingQueue(state.runtime);
      $('recover-queue').hidden = !(state.runtime.recoveredDrafts || []).length;
      connected = Boolean(state.runtime.connected);
      deletableSession = Boolean(state.runtime.sessionFile);
      imageSupported = Boolean(state.imageSupported);
      backgroundSubmissionPending = Boolean(state.backgroundSubmissionPending);
      recentSessions = Array.isArray(state.sessions) ? state.sessions : [];
      if (sessionSwitchPending && recentSessions.some(session => session.id === sessionSwitchPending && session.current)) {
        sessionSwitchPending = undefined;
        showSessionDetail();
      } else {
        updateSessionLayer();
      }
      const followConversation = renderMessages(state.messages || []);
      renderTools(state.tools || []);
      if (followConversation) scrollConversationToBottom();
      renderProposals(state.proposals || []);
      renderChanges(state.changes || []);
      renderBackground(state.backgroundTasks || []);
      renderAttachments(state.attachments || []);
      $('inspect-context').hidden = !(state.attachments || []).length;
      const estimate = state.attachmentEstimate || {};
      const attachmentCount = (state.attachments || []).length;
      $('attachment-estimate').textContent = attachmentCount
        ? attachmentCount + (attachmentCount === 1 ? ' attachment' : ' attachments')
        : '';
      $('inspect-context').title = attachmentCount
        ? (estimate.characters || 0) + ' characters · about ' + (estimate.estimatedTextTokens || 0) + ' text tokens (estimated)' + (attachedImages ? ' · image tokens not included' : '')
        : '';
      $('activity').hidden = ![state.proposals, state.changes, state.backgroundTasks].some(items => items && items.length);
      updatingControls = true;
      renderThinkingLevel(state.runtime);
      thinkingLevel.disabled = busy || !connected || !thinkingSelectable;
      updatingControls = false;
      const currentModel = state.runtime.model || {};
      $('model-label').textContent = currentModel.name || currentModel.id || 'Choose model…';
      $('model-picker').title = currentModel.provider && currentModel.id ? currentModel.provider + '/' + currentModel.id : 'Choose Pi model';
      $('model-picker').disabled = busy || !connected;
      $('new-session').disabled = busy;
      $('delete-session').hidden = !deletableSession;
      $('delete-session').disabled = busy || !connected || !deletableSession;
      $('more').disabled = busy || !connected;
      $('runtime').dataset.connection = !connected ? 'disconnected' : busy ? 'busy' : 'connected';
      latestStatus = state.status + (connected || /disconnected/i.test(state.status) ? '' : ' · disconnected');
      $('session').textContent = state.runtime.sessionName || (state.runtime.sessionId ? 'Session ' + state.runtime.sessionId.slice(0, 8) : '');
      $('session').title = state.runtime.sessionName || state.runtime.sessionId || '';
      const context = (state.runtime.stats || {}).contextUsage || {};
      $('usage').textContent = typeof context.percent === 'number' ? 'Context ' + Math.round(context.percent) + '%' : '';
      $('usage').title = 'Share of the model’s context window currently in use';
      $('reconnect').hidden = connected;
      $('retry').hidden = !state.retryAvailable;
      $('retry').disabled = busy || !connected;
      $('refresh-history').hidden = !state.historyRecoveryAvailable;
      $('refresh-history').disabled = busy || !connected;
      $('add-context').disabled = false;
      cancelButton.hidden = !cancellable;
      sendButton.hidden = cancellable;
      updateSendState();
    }

    function attachPastedImages(event) {
      const items = Array.from((event.clipboardData && event.clipboardData.items) || []);
      const files = items.filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean);
      if (files.length === 0) return;
      event.preventDefault();
      for (const file of files) {
        if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type.toLowerCase())) {
          showNotice('Only PNG, JPEG, GIF, and WebP images can be pasted.', 'warning');
          continue;
        }
        if (file.size > ${maxImageBytes}) {
          showNotice('Pasted images are limited to 5 MiB each.', 'warning');
          continue;
        }
        pendingImageReads += 1;
        updateSendState();
        const reader = new FileReader();
        reader.addEventListener('load', () => {
          const result = typeof reader.result === 'string' ? reader.result : '';
          const separator = result.indexOf(',');
          if (separator < 0) {
            showNotice('Could not read the pasted image.', 'error');
            return;
          }
          vscode.postMessage({ type: 'pasteImage', data: result.slice(separator + 1), mimeType: file.type, fileName: file.name || 'pasted-image' });
        });
        reader.addEventListener('error', () => showNotice('Could not read the pasted image.', 'error'));
        reader.addEventListener('loadend', () => {
          pendingImageReads = Math.max(0, pendingImageReads - 1);
          updateSendState();
        });
        reader.readAsDataURL(file);
      }
    }

    function openImagePreview(button) {
      const assetId = button.dataset.previewAsset;
      const asset = imageAssetCache.get(assetId);
      if (!asset) return;
      previewAssetId = assetId;
      previewTargetIndex = Math.max(0, (imageTargets.get(assetId) || []).findIndex(target => target.button === button));
      $('preview-label').textContent = button.title;
      $('preview-image').src = asset.url;
      $('preview-image').alt = button.title;
      $('image-preview').showModal();
      $('preview-close').focus();
    }

    function closeImagePreview() {
      if ($('image-preview').open) $('image-preview').close();
    }

    $('image-preview').addEventListener('close', () => {
      $('preview-image').removeAttribute('src');
      $('preview-image').alt = '';
      const trigger = imageTargets.get(previewAssetId)?.[previewTargetIndex]?.button;
      previewAssetId = undefined;
      previewTargetIndex = 0;
      if (trigger && !trigger.disabled) trigger.focus();
      else input.focus();
    });
    $('image-preview').addEventListener('cancel', event => { event.preventDefault(); closeImagePreview(); });
    $('image-preview').addEventListener('click', event => { if (event.target === $('image-preview')) closeImagePreview(); });
    $('preview-image').addEventListener('error', () => { if (previewAssetId) rejectImageAsset(previewAssetId); });
    $('preview-close').addEventListener('click', closeImagePreview);

    window.addEventListener('message', event => {
      const message = event.data;
      if (!message || typeof message.type !== 'string') return;
      if (message.type === 'state') render(message);
      else if (message.type === 'showSessionDetail') showSessionDetail();
      else if (message.type === 'showSessionsLayer') showSessionsLayer();
      else if (message.type === 'imageAsset') acceptImageAsset(message);
      else if (message.type === 'notice') showNotice(message.message, message.level, Boolean(message.detailsAvailable));
      else if (message.type === 'appendDraft') {
        if (composerRevision === message.expectedRevision && !recoveredDraftPending) {
          if (message.recoveredDraftId) {
            recoveredDraftPending = { id: message.recoveredDraftId, text: message.text };
            updateSendState();
            vscode.postMessage({ type: 'restoreQueueAttachments', id: message.recoveredDraftId });
          } else {
            input.value += (input.value ? '\\n\\n' : '') + message.text;
            composerRevision += 1; resizeInput(); updateSendState();
          }
        } else { showNotice('Your draft changed. The recovered message remains in Recovered Drafts.', 'warning'); }
      }
      else if (message.type === 'commitRecoveredDraft') {
        if (recoveredDraftPending?.id === message.id) {
          const text = recoveredDraftPending.text;
          recoveredDraftPending = undefined;
          input.value += (input.value ? '\\n\\n' : '') + text;
          composerRevision += 1; resizeInput(); updateSendState(); input.focus();
        }
      }
      else if (message.type === 'rejectRecoveredDraft') {
        if (recoveredDraftPending?.id === message.id) {
          recoveredDraftPending = undefined;
          updateSendState(); input.focus();
        }
      }
      else if (message.type === 'setInput') {
        setComposerInput(message.text);
      }
      else if (message.type === 'clearInput') {
        submissionPending = false;
        const revisionMatches = message.expectedRevision === undefined || composerRevision === message.expectedRevision;
        const textMatches = message.expectedText === undefined || input.value === message.expectedText;
        if (revisionMatches && textMatches) {
          input.value = '';
          resizeInput();
          composerRevision += 1;
          input.focus();
        }
        updateSendState();
      }
      else if (message.type === 'sendRejected') { submissionPending = false; updateSendState(); input.focus(); }
      else if (message.type === 'sessionSwitchRejected') { sessionSwitchPending = undefined; renderSessions(); }
      else if (message.type === 'newSessionAccepted') { newSessionSourceWasList = undefined; }
      else if (message.type === 'newSessionRejected') {
        if (newSessionSourceWasList) showSessionsLayer();
        newSessionSourceWasList = undefined;
      }
    });
    $('recover-queue').addEventListener('click', () => vscode.postMessage({ type: 'recoverQueue', revision: composerRevision }));
    sendButton.addEventListener('click', () => submit());
    cancelButton.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
    $('reconnect').addEventListener('click', () => vscode.postMessage({ type: 'reconnect' }));
    $('retry').addEventListener('click', () => vscode.postMessage({ type: 'retry' }));
    $('refresh-history').addEventListener('click', () => vscode.postMessage({ type: 'refreshHistory' }));
    $('inspect-context').addEventListener('click', () => vscode.postMessage({ type: 'inspectContext' }));
    $('add-context').addEventListener('click', () => vscode.postMessage({ type: 'pickContext' }));
    $('model-picker').addEventListener('click', () => vscode.postMessage({ type: 'pickModel' }));
    $('view-all-sessions').addEventListener('click', () => setSessionsExpanded(true));
    $('back-to-sessions').addEventListener('click', () => {
      if (sessionsLayerVisible) setSessionsExpanded(false);
      else showSessionsLayer();
    });
    sessionSearchInput.addEventListener('input', renderSessions);
    for (const list of [recentSessionList, allSessionList]) {
      list.addEventListener('click', event => {
        const button = event.target instanceof Element ? event.target.closest('button[data-session-id]') : undefined;
        if (button?.dataset.sessionId && !button.disabled) selectRecentSession(button.dataset.sessionId);
      });
    }
    $('new-session').addEventListener('click', () => {
      newSessionSourceWasList = sessionsLayerVisible;
      showSessionDetail();
      vscode.postMessage({ type: 'newSession' });
    });
    $('delete-session').addEventListener('click', () => vscode.postMessage({ type: 'deleteSession' }));
    $('more').addEventListener('click', () => vscode.postMessage({ type: 'showMoreActions', text: input.value, revision: composerRevision }));
    $('source-control').addEventListener('click', () => vscode.postMessage({ type: 'openSourceControl' }));
    thinkingLevel.addEventListener('change', () => { if (!updatingControls) vscode.postMessage({ type: 'setThinking', level: thinkingLevel.value }); });
    input.addEventListener('input', () => { composerRevision += 1; resizeInput(); updateSendState(); });
    window.addEventListener('resize', resizeInput);
    conversationElement.addEventListener('scroll', event => {
      const atBottom = conversationElement.scrollHeight - conversationElement.scrollTop - conversationElement.clientHeight <= 16;
      if (atBottom) conversationPinnedToBottom = true;
      else if (conversationElement.scrollTop === programmaticConversationScrollTop) return;
      else if (event.isTrusted) conversationPinnedToBottom = false;
      programmaticConversationScrollTop = undefined;
    });
    conversationElement.addEventListener('wheel', event => {
      if (event.deltaY < 0) conversationPinnedToBottom = false;
    });
    input.addEventListener('paste', attachPastedImages);
    input.addEventListener('keydown', event => {
      if (event.isComposing) return;
      const followUpShortcut = useCtrlQForFollowUp
        ? event.key.toLowerCase() === 'q' && event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
        : event.key === 'Enter' && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
      if (followUpShortcut) {
        event.preventDefault();
        submit('followUp');
      } else if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        submit('steer');
      }
    });
    notice.addEventListener('click', event => {
      const button = event.target instanceof Element ? event.target.closest('button[data-notice-details]') : undefined;
      if (button) vscode.postMessage({ type: 'showNoticeDetails' });
    });
    messagesElement.addEventListener('click', event => {
      const target = event.target instanceof Element ? event.target : undefined;
      const preview = target?.closest('button[data-preview-asset]');
      if (preview?.dataset.previewAsset && !preview.disabled) { openImagePreview(preview); return; }
      const button = target?.closest('button[data-empty-action]');
      if (!button || button.disabled) return;
      if (button.dataset.emptyAction === 'selection') {
        vscode.postMessage({ type: 'attachSelection' });
        input.focus();
      } else {
        setComposerInput(button.dataset.emptyAction === 'plan'
          ? 'Plan this change before implementing it: '
          : 'Implement this task: ');
      }
    });
    attachmentsElement.addEventListener('click', event => {
      const target = event.target instanceof Element ? event.target : undefined;
      const remove = target?.closest('button[data-remove-attachment]');
      if (remove && !remove.disabled) { vscode.postMessage({ type: 'removeAttachment', id: remove.dataset.removeAttachment }); return; }
      const preview = target?.closest('button[data-preview-asset]');
      if (preview?.dataset.previewAsset && !preview.disabled) openImagePreview(preview);
    });
    proposalsElement.addEventListener('click', event => {
      const button = event.target instanceof Element ? event.target.closest('button[data-proposal-action]') : undefined;
      if (button) vscode.postMessage({ type: 'proposalAction', id: button.dataset.id, action: button.dataset.proposalAction });
    });
    for (const container of [changesElement, backgroundElement]) {
      container.addEventListener('click', event => {
        const button = event.target instanceof Element ? event.target.closest('button[data-action]') : undefined;
        if (button) vscode.postMessage({ type: button.dataset.action, id: button.dataset.id });
      });
    }
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}
