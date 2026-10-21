import { randomBytes } from "node:crypto";
import { composerDraftHtml } from "./composerDraftHtml";
import { composerFileCompletionHtml } from "./composerFileCompletionHtml";
import {
  conversationHistoryControlsHtml,
  conversationHistoryScript,
  conversationHistoryStyles,
} from "./conversationHistoryHtml";

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
  history: '<path d="M2 7a6 6 0 1 1 1.5 5M2 3v4h4M8 4.5V8l2.5 1.5"/>',
  latest: '<path d="M8 2v8m-3-3 3 3 3-3M3 13h10"/>',
} as const;

function icon(name: keyof typeof iconPaths): string {
  return `<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${iconPaths[name]}</svg>`;
}

interface RichContentAssets {
  readonly source: string;
  readonly script: string;
  readonly style: string;
}

export function getSidebarHtml(maxInputCharacters: number, maxImageBytes: number, assets?: RichContentAssets): string {
  const nonce = randomBytes(16).toString("base64url");
  const csp = [
    "default-src 'none'",
    assets ? `style-src ${assets.source} 'unsafe-inline'` : `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    assets ? `font-src ${assets.source}` : "font-src 'none'",
    "img-src data:",
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  ${assets ? `<link rel="stylesheet" href="${assets.style}">` : ""}
  <style nonce="${nonce}">
    ${conversationHistoryStyles()}
    :root { color-scheme: light dark; }
    body { --pi-border: var(--vscode-sideBar-border, var(--vscode-widget-border, transparent)); --pi-accent: var(--vscode-textLink-foreground); --pi-control-background: var(--vscode-dropdown-background, var(--vscode-input-background)); --pi-control-border: var(--vscode-dropdown-border, var(--vscode-input-border, var(--pi-border))); --pi-composer-background: var(--vscode-editorWidget-background, var(--vscode-input-background)); }
    body.vscode-light, body.vscode-high-contrast-light { color-scheme: light; }
    body.vscode-dark, body.vscode-high-contrast { color-scheme: dark; }
    * { box-sizing: border-box; }
    /* Author display rules must never override native hidden state. */
    [hidden] { display: none !important; }
    body { margin: 0; padding: 0; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); line-height: 1.5; overflow: hidden; }
    #app { height: 100vh; min-width: 0; display: grid; grid-template-rows: auto minmax(0, 1fr) auto minmax(0, auto) auto; padding: 0 12px 10px; }
    #app.sessions-layer { grid-template-rows: minmax(0, 1fr) minmax(0, auto) auto; }
    #app.sessions-layer > :not(#sessions):not(#composer):not(#notice) { display: none; }
    button, select { min-height: 28px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 7px; padding: 4px 9px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; font: inherit; }
    button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
    button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    button:active:not(:disabled) { transform: translateY(1px); }
    button.secondary { color: var(--vscode-foreground); background: transparent; }
    button.secondary:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
    button.danger:hover:not(:disabled), button.danger:focus-visible { color: var(--vscode-errorForeground); }
    button:focus-visible, select:focus-visible, summary:focus-visible, textarea:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    button:disabled, select:disabled { cursor: default; opacity: 1; color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground)); border-style: dashed; }
    .icon { width: 16px; height: 16px; flex: 0 0 auto; }
    .icon-button { width: 28px; padding: 5px; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
    #sessions { min-width: 0; padding: 8px 0 7px; border-bottom: 1px solid var(--pi-border); }
    .sessions-header { display: flex; flex-wrap: wrap; min-width: 0; align-items: center; gap: 6px; min-height: 30px; }
    .sessions-title { flex: 1 1 80px; min-width: 0; overflow: hidden; color: var(--vscode-descriptionForeground); font-size: .9em; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
    .sessions-actions { display: flex; flex: 0 0 auto; gap: 2px; margin-left: auto; }
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
    #model-picker { min-width: 0; flex: 0 1 auto; max-width: 100%; justify-content: flex-start; color: var(--vscode-foreground); }
    #model-picker:disabled { color: var(--vscode-descriptionForeground); }
    #thinking-label { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); }
    #thinking-label:not(:empty)::before { content: '· '; }
    #settings-description { margin: 0; }
    #file-discovery-hint { margin: 8px 0; line-height: 1.5; }
    #text-draft-recovery > summary, #composer-help > summary { cursor: pointer; }
    #text-draft-body p { margin: 8px 0; }
    #text-draft-notice { align-self: flex-start; max-width: 100%; margin-top: 4px; white-space: normal; text-align: left; }
    #jump-to-latest { position: sticky; bottom: 0; display: flex; margin: 4px auto 0; max-width: 100%; background: var(--vscode-editor-background); border-color: var(--vscode-contrastBorder, var(--pi-border)); font-size: .85em; }
    #model-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #model-picker .icon { width: 12px; height: 12px; }
    #runtime { display: flex; flex-wrap: wrap; min-width: 0; min-height: calc(1.5em + 14px); gap: 6px; align-items: center; padding: 7px 2px; color: var(--vscode-descriptionForeground); font-size: .82em; }
    .status-dot { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: var(--vscode-descriptionForeground); }
    #runtime[data-connection="connected"] .status-dot { background: var(--vscode-testing-iconPassed, var(--pi-accent)); }
    #runtime[data-connection="busy"] .status-dot { background: var(--vscode-progressBar-background); }
    #runtime[data-connection="disconnected"] .status-dot { background: var(--vscode-editorWarning-foreground); }
    #status { flex: 1 1 70px; min-width: 0; overflow-wrap: anywhere; white-space: normal; }
    #session-details { min-width: 0; }
    #session-details > summary { cursor: pointer; }
    .session-details-content { min-width: 0; padding: 8px 0; }
    #session { width: 100%; min-width: 0; color: var(--vscode-input-foreground); background: var(--vscode-input-background); font: inherit; }
    #usage { font-variant-numeric: tabular-nums; }
    #conversation-details { width: min(480px, calc(100vw - 24px)); max-width: 100%; max-height: calc(100vh - 24px); padding: 14px; overflow-y: auto; overflow-wrap: anywhere; border: 1px solid var(--vscode-contrastBorder, var(--pi-border)); border-radius: 9px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    #conversation-details::backdrop { background: rgba(0, 0, 0, .45); }
    .details-header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
    #conversation-details-title { flex: 1; min-width: 0; margin: 0; font: inherit; font-weight: 600; }
    #conversation-details > details, #conversation-details > section { margin: 12px 0; }
    #conversation-details .extension-ui-block { max-height: 35vh; font-size: inherit; }
    #composer-hint { margin-top: 8px; }
    #runtime button { min-height: 24px; padding: 2px 6px; font-size: inherit; }
    #conversation { min-width: 0; overflow-y: auto; overflow-anchor: none; padding: 18px 2px 24px; scrollbar-width: thin; }
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
    .role:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    .assistant .role { color: var(--vscode-foreground); }
    .assistant .role-icon { display: grid; place-items: center; width: 18px; height: 18px; border-radius: 5px; background: var(--vscode-input-background); color: var(--pi-accent); font: 15px Georgia, serif; }
    .thinking-transcript { min-width: 0; margin: 8px 2px; padding: 8px; border: 1px solid var(--pi-border); border-radius: 7px; color: var(--vscode-descriptionForeground); }
    .thinking-transcript > summary { cursor: pointer; }
    .thinking-transcript > summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 3px; }
    .thinking-transcript pre { max-width: 78ch; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; line-height: 1.6; }
    .thinking-truncated { font-size: .85em; }
    .content { min-width: 0; padding: 0 2px; overflow-wrap: anywhere; line-height: 1.6; }
    .content p { margin: 0 0 10px; }
    .assistant .content > :is(p, h1, h2, h3, h4, h5, h6, ul, ol, blockquote) { max-width: 78ch; }
    .content > :first-child { margin-top: 0; }
    .content > :last-child { margin-bottom: 0; }
    .content h1, .content h2, .content h3, .content h4 { font-size: 1.1em; margin: 16px 0 8px; }
    .content pre { max-width: 100%; overflow: auto; margin: 10px 0; padding: 12px; border: 1px solid var(--pi-border); background: var(--vscode-textCodeBlock-background); border-radius: 7px; white-space: pre; }
    .content code { font-family: var(--vscode-editor-font-family); font-size: .95em; }
    .content pre code { font-size: var(--vscode-editor-font-size); }
    #messages.wrap-code .message:not(.shell) .content pre,
    #messages.wrap-code .message:not(.shell) .content pre code { white-space: pre-wrap; overflow-wrap: anywhere; word-break: normal; }
    .content :not(pre) > code { padding: 1px 4px; background: var(--vscode-textCodeBlock-background); border-radius: 4px; }
    .content ul { margin: 8px 0; padding-left: 22px; }
    .user .content { padding: 10px 12px; border-radius: 9px; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
    .transcript-contexts { display: flex; min-width: 0; flex-wrap: wrap; gap: 4px; margin-top: 7px; }
    .context, .truncated { display: inline-block; max-width: 100%; padding: 2px 7px; border-radius: 5px; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); font-size: .8em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .transcript-images { display: grid; min-width: 0; grid-template-columns: repeat(auto-fit, minmax(min(124px, 100%), 180px)); gap: 7px; margin-top: 8px; }
    .transcript-image { display: flex; flex-direction: column; align-items: stretch; gap: 0; min-width: 0; min-height: 72px; padding: 0; overflow: hidden; border-color: var(--pi-border); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    .transcript-image img { display: block; width: 100%; height: 140px; max-height: 180px; object-fit: contain; background: var(--vscode-input-background); }
    .image-placeholder { display: grid; width: 100%; min-height: 72px; place-items: center; padding: 10px; color: var(--vscode-descriptionForeground); text-align: center; overflow-wrap: anywhere; }
    .image-label { display: block; min-width: 0; padding: 5px 7px; overflow: hidden; color: var(--vscode-descriptionForeground); font-size: .78em; text-overflow: ellipsis; white-space: nowrap; }
    #activity { max-height: min(28vh, 240px); overflow-y: auto; padding: 8px 2px 0; border-top: 1px solid var(--pi-border); scrollbar-width: thin; }
    .proposal, .change, .background-task { margin: 0 0 6px; border: 1px solid var(--pi-border); border-radius: 7px; }
    .proposal, .background-task { padding: 9px; }
    .proposal-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .proposal-meta, .background-meta { color: var(--vscode-descriptionForeground); font-size: .85em; }
    .proposal-error { color: var(--vscode-errorForeground); font-size: .85em; overflow-wrap: anywhere; }
    .proposal-actions, .change-actions, .background-actions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
    #tools-group { margin: 4px 0 10px; border-top: 1px solid var(--pi-border); padding-top: 5px; }
    #tools-group > summary { padding: 4px 2px; cursor: pointer; color: var(--vscode-descriptionForeground); font-size: .85em; overflow-wrap: anywhere; }
    #tools-summary { margin-left: 3px; }
    #tools-running { color: var(--pi-accent); }
    #tools-failed, .tool.error > summary, .tool-error { color: var(--vscode-errorForeground); }
    #tools { margin-top: 3px; min-width: 0; }
    .tool { min-width: 0; margin: 0; }
    .tool > summary { display: flex; align-items: center; gap: 6px; min-width: 0; padding: 3px 2px; cursor: pointer; font-size: 12px; line-height: 18px; }
    .tool > summary::before { content: '▸'; }
    .tool[open] > summary::before { content: '▾'; }
    .tool-name { flex-shrink: 0; max-width: 35%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tool-operation { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); }
    .tool-section { margin: 4px 0 8px 12px; min-width: 0; }
    .tool-section-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: 12px; }
    .tool-section button { font-size: 11px; min-height: 22px; padding: 1px 5px; }
    .tool pre { margin: 4px 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.4 var(--vscode-editor-font-family, monospace); }
    .tool-section > pre { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 6; overflow: hidden; }
    .tool-full > summary { cursor: pointer; font-size: 12px; }
    .background-output { max-height: 120px; overflow: auto; margin: 0; padding: 8px; border-top: 1px solid var(--pi-border); white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
    .change { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 6px 8px; }
    .change-label { flex: 1 1 100px; }
    .change-label, .background-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .change-actions { margin-top: 0; }
    .section-heading { display: flex; justify-content: space-between; gap: 8px; align-items: center; margin: 4px 0 8px; color: var(--vscode-descriptionForeground); font-size: .85em; font-weight: 500; }
    #source-control { min-height: 24px; font-size: inherit; }
    #attachments { display: flex; min-height: 0; align-items: flex-start; gap: 7px; flex-wrap: wrap; max-height: min(132px, 20vh); overflow-y: auto; padding: 9px 10px 1px; }
    .attachment-chip { display: inline-flex; max-width: 100%; align-items: center; gap: 4px; padding: 3px 4px 3px 7px; border-radius: 5px; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); font-size: .82em; }
    .attachment-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .attachment-chip button { min-height: 20px; width: 20px; padding: 0; color: inherit; background: transparent; }
    .attachment-image { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) 25px; flex: 0 0 120px; width: 120px; min-width: 0; overflow: hidden; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--vscode-editor-background); box-shadow: 0 1px 2px rgba(0, 0, 0, .16); }
    button.composer-image { grid-column: 1 / -1; display: block; width: 100%; height: 72px; min-height: 72px; padding: 0; overflow: hidden; border: 0; border-radius: 0; color: var(--vscode-descriptionForeground); background: var(--vscode-input-background); }
    button.composer-image:hover:not(:disabled) { background: var(--vscode-list-hoverBackground, var(--vscode-toolbar-hoverBackground)); }
    .composer-image img { display: block; width: 100%; height: 100%; object-fit: contain; }
    .composer-image-placeholder { display: grid; width: 100%; height: 100%; place-items: center; padding: 8px; text-align: center; font-size: .78em; line-height: 1.25; }
    .composer-image-label { display: block; min-width: 0; padding: 5px 7px 6px; overflow: hidden; color: var(--vscode-descriptionForeground); font-size: .76em; line-height: 1.2; text-overflow: ellipsis; white-space: nowrap; }
    button.attachment-remove { align-self: center; width: 23px; min-height: 23px; padding: 0; border-color: var(--pi-control-border); border-radius: 5px; color: var(--vscode-foreground); background: transparent; font-size: 15px; line-height: 1; }
    button.attachment-remove:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
    button.composer-image:focus-visible, button.attachment-remove:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--vscode-focusBorder); }
    #composer { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0; padding-top: 12px; }
    .extension-ui-block { flex: 0 1 auto; min-width: 0; min-height: 0; max-height: 8vh; overflow-y: auto; scrollbar-width: thin; padding: 3px 4px; border: 1px solid var(--vscode-contrastBorder, var(--pi-border)); color: var(--vscode-descriptionForeground); font-size: .8em; overflow-wrap: anywhere; }
    .extension-ui-block[hidden] { display: none; }
    .extension-ui-block h2, .extension-ui-block p { margin: 0; font: inherit; }
    .extension-ui-block h2 { font-weight: 600; }
    .extension-ui-block pre { margin: 0 0 3px; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
    #file-completions { position: absolute; bottom: calc(100% - 6px); left: 0; right: 0; z-index: 11; max-height: min(260px, 40vh); overflow: auto; padding: 4px; border: 1px solid var(--vscode-editorSuggestWidget-border, var(--pi-border)); border-radius: 8px; color: var(--vscode-editorSuggestWidget-foreground, var(--vscode-foreground)); background: var(--vscode-editorSuggestWidget-background, var(--vscode-editor-background)); box-shadow: 0 4px 16px var(--vscode-widget-shadow); }
    #file-completions button { display: block; width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; border: 0; padding: 6px 8px; color: inherit; background: transparent; }
    #file-completions button[aria-selected="true"] { color: var(--vscode-list-activeSelectionForeground); background: var(--vscode-list-activeSelectionBackground); }
    #slash-commands { position: absolute; bottom: calc(100% - 6px); left: 0; right: 0; z-index: 10; max-height: min(260px, 40vh); overflow-y: auto; padding: 4px; border: 1px solid var(--vscode-editorSuggestWidget-border, var(--pi-border)); border-radius: 8px; color: var(--vscode-editorSuggestWidget-foreground, var(--vscode-foreground)); background: var(--vscode-editorSuggestWidget-background, var(--vscode-editor-background)); box-shadow: 0 4px 16px var(--vscode-widget-shadow); }
    #slash-commands button { display: flex; width: 100%; justify-content: flex-start; gap: 12px; border: 0; padding: 6px 8px; text-align: left; color: inherit; background: transparent; }
    #slash-commands button[aria-selected="true"] { color: var(--vscode-editorSuggestWidget-selectedForeground, var(--vscode-list-activeSelectionForeground)); background: var(--vscode-editorSuggestWidget-selectedBackground, var(--vscode-list-activeSelectionBackground)); }
    .slash-name { flex: 0 0 auto; font-family: var(--vscode-editor-font-family); }
    .slash-description { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .75; }
    /* Reserve short/zoomed view space for the session header and necessary notices. */
    .composer-box { position: relative; display: flex; flex: 0 0 auto; flex-direction: column; min-height: 0; max-height: max(200px, min(60vh, calc(100vh - 210px))); overflow: hidden; background: var(--pi-composer-background); border: 1px solid var(--vscode-input-border, var(--pi-border)); border-radius: 14px; box-shadow: 0 4px 16px var(--vscode-widget-shadow, rgba(0, 0, 0, .2)); }
    .composer-box:focus-within { border-color: var(--vscode-focusBorder); box-shadow: 0 6px 20px var(--vscode-widget-shadow, rgba(0, 0, 0, .24)); }
    textarea { display: block; width: 100%; height: 42px; min-height: 42px; max-height: min(220px, 28vh); resize: none; padding: 11px 13px 7px; color: var(--vscode-input-foreground); background: transparent; border: 0; border-radius: 14px 14px 6px 6px; font: inherit; line-height: 1.5; scrollbar-width: thin; }
    textarea:focus-visible { outline: none; }
    textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
    #attachment-estimate, #queue-status { padding: 0 12px; }
    #pending-queue { display: grid; min-height: 0; max-height: 15vh; overflow-y: auto; gap: 4px; padding: 5px 10px 1px; }
    #pending-queue[hidden] { display: none; }
    .pending-queue-item { display: flex; min-width: 0; gap: 5px; padding: 4px 7px; border-radius: 5px; color: var(--vscode-descriptionForeground); background: var(--vscode-editorWidget-background, var(--vscode-input-background)); font-size: .8em; line-height: 1.3; }
    .pending-queue-kind { flex: 0 0 auto; font-weight: 600; }
    .pending-queue-text { min-width: 0; overflow: hidden; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
    .composer-box > .proposal-actions { padding: 0 10px; }
    .composer-actions { display: flex; flex-shrink: 0; flex-wrap: wrap; min-width: 0; gap: 6px; padding: 3px 8px 8px; align-items: center; }
    .composer-submit-actions { display: flex; flex: 1 1 0; min-width: 0; max-width: 100%; gap: 6px; align-items: center; justify-content: flex-end; }
    .composer-actions > button, .composer-submit-actions > button { min-height: 30px; border-radius: 8px; }
    #add-context { flex: 0 0 30px; width: 30px; min-width: 30px; padding: 6px; border-color: transparent; color: var(--vscode-descriptionForeground); }
    #model-picker { border-color: transparent; background: transparent; }
    #model-picker:hover:not(:disabled) { background: var(--vscode-list-hoverBackground, var(--vscode-toolbar-hoverBackground)); }
    #send { width: 30px; flex: 0 0 30px; padding: 6px; }
    #send:disabled { border-color: var(--pi-control-border); color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground)); background: transparent; }
    #send.queue-action { width: auto; flex: 0 0 auto; padding: 4px 9px; }
    #after-this { min-height: 30px; font-size: .9em; }
    #submission-label { display: none; }
    #send.queue-action #submission-label { display: inline; }
    #send.queue-action .icon { display: none; }
    #cancel { border-color: var(--pi-control-border); font-size: .9em; }
    #notice { max-height: 12vh; overflow-y: auto; padding: 7px 2px 0; color: var(--vscode-descriptionForeground); font-size: .85em; overflow-wrap: anywhere; }
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
    @media (max-width: 340px) { #app { padding: 0 8px 8px; } .sessions-actions { gap: 0; } .composer-actions { gap: 4px; padding-left: 6px; padding-right: 6px; } .composer-submit-actions { gap: 4px; } .empty { padding-left: 2px; padding-right: 2px; } .empty h2 { font-size: 1.5em; } button.welcome-action { gap: 9px; padding: 10px; } }
    @media (max-width: 240px) { #cancel, #after-this { padding: 4px; } .composer-actions, .composer-submit-actions { gap: 3px; } #thinking-label { display: none; } }
    @media (max-width: 300px) { .composer-submit-actions:has(#send.queue-action) { flex-wrap: wrap; justify-content: flex-end; } }
    @media (max-width: 200px) { .sessions-actions .icon-button { width: 24px; padding: 3px; } .composer-submit-actions:has(#send.queue-action) { display: contents; } .composer-actions:has(#send.queue-action) { justify-content: flex-end; } .composer-actions:has(#send.queue-action) #model-picker { flex: 1 1 0; } }
    @media (max-height: 500px) { textarea { max-height: 18vh; } #attachments { max-height: 16vh; } .empty { padding-top: 8px; padding-bottom: 16px; } .welcome-mark { display: none; } .empty-actions { margin-top: 16px; } }
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
          <button id="history-search-open" class="secondary icon-button" type="button" title="Find literal, case-sensitive text in this history window" aria-label="Find text" aria-expanded="false" aria-controls="history-search-bar" hidden>${icon("search")}</button>
          <button id="history-earlier" class="secondary icon-button" type="button" title="Show an earlier history window" aria-label="Earlier history" hidden disabled>${icon("history")}</button>
          <button id="history-latest" class="secondary icon-button" type="button" title="Return to the latest history window" aria-label="Latest history" hidden disabled>${icon("latest")}</button>
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
      ${conversationHistoryControlsHtml()}
      <section id="messages" aria-live="off"></section>
      <details id="tools-group" hidden><summary id="tools-group-toggle"><span id="tools-summary">Tool activity</span><span id="tools-running"></span><span id="tools-failed"></span></summary><section id="tools" aria-label="Pi tool activity"></section></details>
      <button id="jump-to-latest" class="secondary" type="button" hidden>Jump to latest</button>
    </section>
    <section id="activity" aria-label="Pi workflow activity" hidden>
      <div id="proposals-heading" class="section-heading" hidden><span>Edit proposals</span></div><section id="proposals" aria-label="Pi edit proposals"></section>
      <div id="changes-heading" class="section-heading" hidden><span>Pi changes</span><button id="source-control" class="secondary" type="button">Source Control</button></div><section id="changes" aria-label="Pi file changes"></section>
      <div id="background-heading" class="section-heading" hidden><span>Background agents</span></div><section id="background" aria-label="Background Pi agents"></section>
    </section>
    <section id="composer" aria-label="Message composer">
      <div id="slash-commands" role="listbox" aria-label="Slash commands" hidden></div>
      <section id="extension-ui-above" class="extension-ui-block" tabindex="0" aria-label="Pi extension widgets above editor" hidden></section>
      <div id="file-completions" role="listbox" aria-label="Workspace files" hidden></div>
      <div id="runtime"><span id="runtime-dot" class="status-dot" aria-hidden="true" hidden></span><span id="status" role="status" aria-live="polite" aria-atomic="true"></span><button id="retry" class="secondary" type="button" hidden>Retry</button><button id="refresh-history" class="secondary" type="button" hidden>Refresh history</button><button id="reconnect" class="secondary" type="button" hidden>Reconnect</button></div>
      <div class="composer-box">
        <div id="attachments" aria-label="Attachments for the next message" hidden></div>
        <div id="attachment-estimate" class="proposal-meta"></div>
        <div id="pending-queue" role="list" aria-label="Pending Pi messages" hidden></div>
        <label for="input" class="sr-only">Message Pi</label>
        <textarea id="input" rows="1" maxlength="${maxInputCharacters}" placeholder="Ask Pi anything…" aria-describedby="composer-status composer-hint file-discovery-hint" aria-autocomplete="list" aria-controls="slash-commands file-completions" aria-expanded="false"></textarea>
        <div id="queue-status" class="proposal-meta" role="status"></div>
        <div class="proposal-actions">
          <button id="recover-queue" class="secondary" type="button" hidden>Restore drafts</button>
        </div>
        <div class="composer-actions">
          <button id="add-context" class="secondary" type="button" title="Attach code, files, or images" aria-label="Attach code, files, or images">${icon("attachment")}</button>
          <div class="composer-submit-actions">
          <button id="model-picker" class="secondary" type="button" aria-label="Change Pi model and thinking level" aria-haspopup="dialog"><span id="model-label">Choose model…</span><span id="thinking-label"></span>${icon("chevron")}</button>
          <button id="cancel" class="secondary" type="button" aria-label="Cancel Pi response" hidden>${icon("stop")}<span>Stop</span></button>
          <button id="after-this" class="secondary" type="button" aria-describedby="composer-status" aria-label="After this: send when Pi finishes responding" hidden>After this</button>
          <button id="send" type="button" aria-describedby="composer-status" aria-label="Send message" title="Send message" disabled>${icon("send")}<span id="submission-label">Next</span></button>
          </div>
        </div>
      </div>
      <section id="extension-ui-below" class="extension-ui-block" tabindex="0" aria-label="Pi extension widgets below editor" hidden></section>
      <p id="composer-status" hidden></p>
      <p id="settings-description" class="sr-only"></p>
    </section>
    <div id="notice" role="status" aria-live="polite"></div>
  </main>
  <dialog id="conversation-details" aria-labelledby="conversation-details-title">
    <div class="details-header"><h2 id="conversation-details-title">Conversation details</h2><button id="conversation-details-close" class="secondary" type="button">Close</button></div>
    <details id="composer-help"><summary>Submission help</summary><div id="composer-hint">Enter to send · Shift+Enter for a new line</div><p>Idle session only: !command includes model context; !!command excludes model context, not history. Remove attachments. Pi and installed extensions control execution permissions. Prefix ! with a backslash to send literal text.</p></details>
    <p id="file-discovery-hint">Checking workspace file completion.</p>
    <details id="session-details" hidden><summary>Session details</summary><div class="session-details-content"><label for="session">Session ID (select to copy)</label><input id="session" readonly></div></details>
    <section aria-label="Context usage"><h2 class="section-heading">Context usage</h2><p id="usage">Context usage is unavailable.</p></section>
    <section id="extension-status" class="extension-ui-block" tabindex="0" aria-label="Pi extension status" hidden></section>
  </dialog>
  <dialog id="image-preview" aria-labelledby="preview-label">
    <div class="preview-header"><span id="preview-label"></span><button id="preview-close" class="secondary" type="button" aria-label="Close image preview">Close</button></div>
    <img id="preview-image" alt="">
  </dialog>
  ${assets ? `<script nonce="${nonce}" src="${assets.script}"></script>` : ""}
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
    const slashMenu = $('slash-commands');
    let slashCommands = [];
    let slashMatches = [];
    let slashIndex = 0;
    let slashDismissed = false;
    let slashFocused = false;
    const sendButton = $('send');
    const cancelButton = $('cancel');
    const notice = $('notice');
    const conversationDetails = $('conversation-details');
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
    let pendingQueueCount = 0;
    let connected = false;
    let deletableSession = false;
    let imageSupported = true;
    let attachedItems = false;
    let attachedImages = false;
    let pendingImageReads = 0;
    let submissionPending = false;
    let backgroundSubmissionPending = false;
    let composerRevision = 0;
    let fileCompletion;
    let composerDraft;
    let fileCompletionSupport = { available: false, reason: 'Checking workspace file completion.' };
    let messageHeadingSequence = 0;
    let wrapReadingAnchor;
    let wrapReadingTop;
    let thinkingUnavailableReason = '';
    let modelTitle = 'Choose Pi model and thinking level';
    let latestStatus = 'Connecting…';
    let conversationPinnedToBottom = true;
    let programmaticConversationScrollTop;
    let conversationClientHeight = conversationElement.clientHeight;
    let hasNewTranscriptOutput = false;
    let lastTranscriptSignature = '';
    let displayedSessionIdentity;
    let renderedMessageStructure = '';
    let renderedMessageHtml = [];
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

    function showNotice(message, level, outputAvailable = false, transientLock = false) {
      notice.replaceChildren();
      notice.textContent = message;
      notice.className = level || '';
      notice.dataset.transientLock = transientLock ? 'true' : '';
      if (level === 'info' || level === 'success') {
        const dismiss = document.createElement('button');
        dismiss.className = 'secondary'; dismiss.type = 'button'; dismiss.textContent = 'Dismiss';
        dismiss.dataset.noticeDismiss = 'true'; notice.appendChild(dismiss);
      }
      if (outputAvailable) {
        const output = document.createElement('button');
        output.className = 'secondary';
        output.type = 'button';
        output.textContent = 'Show Output';
        output.dataset.noticeOutput = 'true';
        notice.appendChild(output);
      }
    }

    function clearNotice() {
      notice.replaceChildren();
      notice.textContent = '';
      notice.className = '';
      notice.dataset.transientLock = '';
    }

    function updateRuntimeStatus(blocker) {
      // These are fixed host problem producers, including failures without a Retry action.
      const problem = [
        'Request failed · Retry available', 'Request failed · Run the action again',
        'Pi stopped after tool execution · Retry unavailable', 'Pi completed · Follow-up action failed',
        'Pi completed · History refresh failed', 'Context compacted · History refresh failed',
        'History unavailable · Refresh available', 'Shell execution uncertain · Inspect effects',
        'Shell execution uncertain · Inspect effects; no automatic retry'
      ].includes(latestStatus);
      const runtimeStatus = latestStatus === 'Ready' ? '' : latestStatus;
      const recoveryStatus = !$('refresh-history').hidden ? 'History unavailable · Refresh available'
        : !$('retry').hidden ? latestStatus === 'Cancelled · Ready to retry' ? latestStatus : 'Retry available' : '';
      const problemStatus = !connected
        ? latestStatus === 'Connecting…' ? blocker : runtimeStatus || blocker
        : problem ? runtimeStatus : recoveryStatus;
      const displayed = problemStatus || blocker || (pendingImageReads > 0 ? 'Loading pasted image…'
        : backgroundSubmissionPending ? 'Starting background agent…'
        : submissionPending ? 'Sending to Pi…' : runtimeStatus);
      if ($('status').textContent !== displayed) $('status').textContent = displayed;
      $('status').title = displayed;
      $('runtime-dot').hidden = !displayed;
    }

    function updateRecoveryControl(id, hidden, disabled = false) {
      const button = $(id);
      if ((hidden || disabled) && document.activeElement === button) input.focus();
      button.hidden = hidden;
      button.disabled = disabled;
    }

    function setConversationScrollTop(scrollTop) {
      conversationElement.scrollTop = scrollTop;
      programmaticConversationScrollTop = conversationElement.scrollTop;
    }

    function updateLatestOutput() {
      const button = $('jump-to-latest');
      const overflow = conversationElement.scrollHeight - conversationElement.clientHeight > 16;
      const hidden = sessionsLayerVisible || conversationPinnedToBottom || !overflow || messagesElement.classList.contains('is-empty');
      if (conversationPinnedToBottom) hasNewTranscriptOutput = false;
      const label = hasNewTranscriptOutput ? 'Jump to latest · New output' : 'Jump to latest';
      if (button.textContent !== label) button.textContent = label;
      if (hidden && document.activeElement === button) input.focus();
      button.hidden = hidden;
    }

    function scrollConversationToBottom() {
      conversationPinnedToBottom = true;
      hasNewTranscriptOutput = false;
      updateLatestOutput();
      const scroll = () => {
        if (conversationPinnedToBottom) setConversationScrollTop(conversationElement.scrollHeight);
      };
      scroll();
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(scroll);
    }

    function submit(kind = 'steer') {
      if (composerDraft?.blocked()) {
        showNotice('The draft context changed. Wait for the transition, or verify the session and clear the kept text before sending.', 'warning');
        return;
      }
      if (fileCompletion?.busy) return;
      fileCompletion?.cancel();
      const text = input.value.trim();
      if ((!text && !attachedItems) || !connected || submissionPending || backgroundSubmissionPending || recoveredDraftPending) return;
      if (pendingImageReads > 0 || (attachedImages && !imageSupported)) return;
      if (sessionsLayerVisible && busy) {
        showNotice('Wait for Pi to finish before starting a new session.', 'warning', false, true);
        return;
      }
      if (busy) {
        if (input.value.trimStart().startsWith('/') || pendingQueueCount >= 10) {
          showNotice(input.value.trimStart().startsWith('/') ? 'Slash commands cannot be queued. Wait for Pi to finish.' : 'The queue is full. Wait for a pending message to start.', 'warning', false, true);
          return;
        }
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
        if (sessionsLayerVisible) composerDraft?.sendHandoff();
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

    function setMessageContent(content, html) {
      if (window.piRichContent) window.piRichContent.setContent(content, html, () => {
        if (conversationPinnedToBottom) scrollConversationToBottom();
      });
      else content.innerHTML = html;
    }
    document.addEventListener('pi-rich-resize', () => {
      if (conversationPinnedToBottom) scrollConversationToBottom();
    });

    function updateFileDiscoveryHint() {
      const hint = $('file-discovery-hint');
      hint.textContent = input.value.trimStart().startsWith('!') || input.value.trimStart().startsWith('/')
        ? 'File completion is unavailable for shell input and slash commands.'
        : !fileCompletionSupport.available
          ? fileCompletionSupport.reason || 'File completion is unavailable in this workspace.'
          : '@ selects a file snapshot to attach. Tab on a visible path suggestion inserts only its path. Inspect attachments before sending to Pi.';
    }

    // Keep the same visible text offset when a long code block changes height.
    function toggleCodeWrapping() {
      const follow = conversationPinnedToBottom;
      const top = conversationElement.scrollTop;
      const bounds = conversationElement.getBoundingClientRect();
      const x = bounds.left + Math.min(24, bounds.width / 2);
      const readingEdge = bounds.top;
      const y = Math.min(readingEdge + 8, bounds.bottom - 1);
      const candidates = Array.from(messagesElement.querySelectorAll('pre, p, .role'));
      const visible = node => {
        const rect = node?.getBoundingClientRect();
        return rect && rect.bottom > bounds.top && rect.top < bounds.bottom;
      };
      const active = document.activeElement;
      const focused = active && messagesElement.contains(active) && visible(active) ? active : undefined;
      const retained = wrapReadingAnchor && messagesElement.contains(wrapReadingAnchor) && visible(wrapReadingAnchor)
        && Math.abs(top - wrapReadingTop) <= 1 ? wrapReadingAnchor : undefined;
      const anchor = focused || retained || candidates.find(node => node.getBoundingClientRect().bottom > readingEdge);
      const caret = document.caretRangeFromPoint?.(x, y);
      // A gutter hit can return an unrelated or empty caret rectangle. Use text offsets only inside visible code.
      const range = caret && anchor?.tagName === 'PRE' && anchor.contains(caret.startContainer)
        && caret.getBoundingClientRect().height > 0 ? caret : undefined;
      const before = range?.getBoundingClientRect().top ?? anchor?.getBoundingClientRect().top;
      const enabled = !messagesElement.classList.contains('wrap-code');
      messagesElement.classList.toggle('wrap-code', enabled);
      if (follow) scrollConversationToBottom();
      else {
        const after = range?.getBoundingClientRect().top ?? anchor?.getBoundingClientRect().top;
        setConversationScrollTop(before === undefined || after === undefined ? top : conversationElement.scrollTop + after - before);
      }
      wrapReadingAnchor = follow ? undefined : anchor;
      wrapReadingTop = conversationElement.scrollTop;
      window.dispatchEvent(new Event('pi-transcript-layout'));
    }

    function renderThinking(wrapper, blocks) {
      const thinking = Array.isArray(blocks) ? blocks : [];
      let details = wrapper.thinkingDisclosure;
      if (!thinking.length && !details) return;
      if (!details) {
        details = document.createElement('details');
        details.className = 'thinking-transcript';
        const summary = document.createElement('summary');
        summary.textContent = 'Thinking';
        const body = document.createElement('div');
        details.append(summary, body);
        wrapper.appendChild(details);
        wrapper.thinkingDisclosure = details;
      }
      details.hidden = !thinking.length;
      const signature = JSON.stringify(thinking);
      if (details.thinkingKey === signature) return;
      details.thinkingKey = signature;
      const body = details.children[1];
      body.replaceChildren();
      for (const block of thinking) {
        const text = document.createElement('pre');
        text.textContent = block.redacted ? 'Provider redacted this thinking block. Hidden content is unavailable.' : block.text;
        body.appendChild(text);
        if (block.truncated) {
          const notice = document.createElement('div');
          notice.className = 'thinking-truncated';
          notice.textContent = 'Thinking truncated; only retained content is shown.';
          body.appendChild(notice);
        }
      }
    }

    function renderMessages(messages) {
      const signature = JSON.stringify(messages.map(message => [message.id, message.html, message.thinking, message.attachments]));
      if (!conversationPinnedToBottom && lastTranscriptSignature && signature !== lastTranscriptSignature) hasNewTranscriptOutput = true;
      lastTranscriptSignature = signature;
      const followConversation = conversationPinnedToBottom;
      const readingTop = conversationElement.scrollTop;
      const visibleMessages = messages.filter(message => message.role !== 'assistant' || Boolean(message.html) || message.thinking?.length);
      const structure = JSON.stringify(visibleMessages.map((message, index) => [message.id || index, message.role, message.attachments || [], Boolean(message.truncated)]));
      const html = visibleMessages.map(message => message.html || '');
      messagesElement.classList.toggle('is-empty', visibleMessages.length === 0);

      const expectedChildren = visibleMessages.length || 1;
      if (structure === renderedMessageStructure && messagesElement.children.length === expectedChildren) {
        for (let index = 0; index < html.length; index += 1) {
          const wrapper = messagesElement.children[index];
          const content = wrapper?.children[1];
          if (content && html[index] !== renderedMessageHtml[index]) setMessageContent(content, html[index]);
          if (wrapper) renderThinking(wrapper, visibleMessages[index].thinking);
        }
        renderedMessageHtml = html;
        if (!followConversation) setConversationScrollTop(readingTop);
        return visibleMessages.length > 0 && followConversation;
      }

      const retained = new Map(Array.from(messagesElement.children, wrapper => [wrapper.messageId, {
        role: wrapper.children[0],
        headingFocused: wrapper.children[0] === document.activeElement,
        open: wrapper.thinkingDisclosure?.open,
        focused: Boolean(wrapper.thinkingDisclosure && wrapper.thinkingDisclosure.children[0] === document.activeElement),
      }]));
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
          wrapper.messageId = message.id;
          const previous = message.id ? retained.get(message.id) : undefined;
          retained.delete(message.id);
          const role = previous?.role || document.createElement('h2');
          role.className = 'role';
          role.tabIndex = -1;
          if (!role.id) role.id = 'pi-message-heading-' + (++messageHeadingSequence);
          const label = message.role === 'user' ? 'You' : message.role === 'shell' ? 'Shell' : 'Pi';
          const name = label + ' message ' + (index + 1);
          role.replaceChildren();
          if (message.role === 'assistant') {
            const mark = document.createElement('span');
            mark.className = 'role-icon';
            mark.setAttribute('aria-hidden', 'true');
            mark.textContent = 'π';
            role.append(mark);
          }
          const roleLabel = document.createElement('span');
          roleLabel.textContent = label;
          role.append(roleLabel);
          role.setAttribute('aria-label', name);
          wrapper.setAttribute('aria-labelledby', role.id);
          const content = document.createElement('div');
          content.className = 'content';
          setMessageContent(content, html[index]);
          wrapper.append(role, content);
          renderThinking(wrapper, message.thinking);
          if (wrapper.thinkingDisclosure && previous) wrapper.thinkingDisclosure.open = Boolean(previous.open);
          messagesElement.appendChild(wrapper);
          if (previous?.headingFocused) role.focus({ preventScroll: true });
          if (wrapper.thinkingDisclosure && previous?.focused) wrapper.thinkingDisclosure.children[0].focus({ preventScroll: true });
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
      } else if (!followConversation) setConversationScrollTop(readingTop);
      return visibleMessages.length > 0 && followConversation;
    }

    function renderTranscriptImage(button, attachment) {
      button.replaceChildren();
      button.title = attachment.fullLabel;
      const cached = imageAssetCache.get(attachment.assetId);
      if (cached) {
        button.disabled = false;
        button.setAttribute('aria-label', 'Open image preview: ' + attachment.fullLabel);
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
        button.setAttribute('aria-label', 'Open image preview: ' + attachment.fullLabel);
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

    function discardImageAsset(id) {
      const asset = imageAssetCache.get(id);
      if (!asset) return false;
      imageAssetCache.delete(id);
      imageAssetCacheBytes -= asset.byteLength;
      for (const target of imageTargets.get(id) || []) {
        target.attachment.availability = 'unavailable';
        rerenderImageTarget(target);
      }
      return true;
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
        discardImageAsset(oldestId);
        vscode.postMessage({ type: 'imageAssetEvicted', id: oldestId });
      }
      imageAssetCache.set(message.id, { url: 'data:' + message.mimeType + ';base64,' + message.data, byteLength: message.byteLength });
      imageAssetCacheBytes += message.byteLength;
      for (const target of imageTargets.get(message.id) || []) rerenderImageTarget(target);
    }

    function rejectImageAsset(id) {
      if (!discardImageAsset(id)) return;
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

    $('tools-group-toggle').addEventListener('click', () => {
      const group = $('tools-group');
      group.toolManual = !group.open;
    });

    function toolDisclosure(details, automaticOpen) {
      if (details.toolAutomatic !== undefined && details.open !== details.toolAutomatic) details.toolManual = details.open;
      const open = details.toolManual === undefined ? automaticOpen : details.toolManual;
      details.open = open;
      details.toolAutomatic = open;
    }

    function createToolSection(label) {
      const section = document.createElement('section');
      section.className = 'tool-section';
      const heading = document.createElement('div');
      heading.className = 'tool-section-heading';
      const title = document.createElement('strong');
      title.textContent = label;
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'secondary';
      copy.textContent = 'Copy ' + label;
      const feedback = document.createElement('span');
      feedback.setAttribute('role', 'status');
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(section.toolText);
          feedback.textContent = label + ' copied';
        } catch {
          feedback.textContent = 'Copy failed. Select and copy the text manually.';
        }
      });
      heading.append(title, copy, feedback);
      const preview = document.createElement('pre');
      const full = document.createElement('details');
      full.className = 'tool-full';
      const summary = document.createElement('summary');
      summary.textContent = 'Show all retained ' + label.toLowerCase();
      const content = document.createElement('pre');
      full.append(summary, content);
      section.append(heading, preview, full);
      return section;
    }

    function updateToolSection(section, text, empty) {
      const preview = section.children[1];
      const full = section.children[2];
      const short = text.split('\\n').slice(0, 6).join('\\n').slice(0, 600);
      if (section.toolText !== text || !text) {
        section.toolText = text;
        preview.textContent = short || empty;
        full.hidden = !text;
        section.children[0].children[2].textContent = '';
        full.children[1].textContent = text;
      }
    }

    function renderTools(tools) {
      const group = $('tools-group');
      const running = tools.filter(tool => tool.status === 'running').length;
      const failed = tools.filter(tool => tool.status === 'error').length;
      group.hidden = tools.length === 0;
      if (!tools.length) {
        group.toolManual = undefined;
        group.open = false;
        group.toolAutomatic = false;
        toolsElement.replaceChildren();
        return;
      }
      const retainedIds = new Set(tools.map(tool => tool.id));
      const existing = new Map(Array.from(toolsElement.children, details => [details.dataset.id, details]));
      if (existing.size && !tools.some(tool => existing.has(tool.id))) {
        group.toolManual = undefined;
        group.toolAutomatic = group.open;
      }
      for (const [id, row] of existing) {
        if (!retainedIds.has(id)) toolsElement.removeChild(row);
      }
      toolDisclosure(group, busy);
      $('tools-summary').textContent = 'Tool activity · ' + tools.length + (tools.length === 1 ? ' call' : ' calls');
      $('tools-running').textContent = running ? ' · ' + running + ' running' : '';
      $('tools-failed').textContent = failed ? ' · ' + failed + ' failed' : '';

      for (const tool of tools) {
        let details = existing.get(tool.id);
        if (!details) {
          details = document.createElement('details');
          details.dataset.id = tool.id;
          details.toolAutomatic = false;
          const summary = document.createElement('summary');
          const status = document.createElement('span');
          const name = document.createElement('span');
          name.className = 'tool-name';
          const operation = document.createElement('span');
          operation.className = 'tool-operation';
          summary.append(status, name, operation);
          summary.addEventListener('click', () => { details.toolManual = !details.open; });
          const error = document.createElement('pre');
          error.className = 'tool-error';
          details.append(summary, error, createToolSection('Input'), createToolSection('Output'));
          toolsElement.appendChild(details);
        }
        details.className = 'tool ' + tool.status;
        toolDisclosure(details, busy && tool.status === 'running');
        const summary = details.children[0];
        const label = tool.status === 'running' ? 'Running' : tool.status === 'error' ? 'Failed' : 'Succeeded';
        summary.children[0].textContent = tool.status === 'running' ? '◷' : tool.status === 'error' ? '!' : '✓';
        summary.children[0].setAttribute('role', 'img');
        summary.children[0].setAttribute('aria-label', label);
        summary.children[0].title = label;
        summary.children[1].textContent = tool.name;
        summary.children[2].textContent = tool.summary || 'Tool operation';
        summary.children[2].title = tool.summary || 'Tool operation';
        const output = tool.output || '';
        const error = details.children[1];
        error.hidden = tool.status !== 'error' || !output;
        error.textContent = tool.status === 'error' ? output.split('\\n').slice(0, 3).join('\\n').slice(0, 400) : '';
        updateToolSection(details.children[2], tool.input || '', 'No input supplied.');
        updateToolSection(details.children[3], output, tool.status === 'running' ? 'Waiting for output…' : 'No output returned.');
      }
      // The host appends calls in execution order. Retained rows stay attached,
      // including when the oldest call is removed by the host's 30-call limit.
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

    function closeSlashCommands() {
      slashMenu.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }

    function renderSlashCommands() {
      const query = /^\\/([^\\s]*)$/.exec(input.value);
      const caret = input.selectionStart;
      if (!query || !slashFocused || slashDismissed || input.disabled || submissionPending || !connected || busy
          || (typeof caret === 'number' && (caret !== input.value.length || input.selectionEnd !== caret))) {
        closeSlashCommands();
        return;
      }
      slashMatches = slashCommands.filter(command => command.name.toLowerCase().includes(query[1].toLowerCase()));
      slashIndex = Math.min(slashIndex, Math.max(0, slashMatches.length - 1));
      slashMenu.replaceChildren();
      if (!slashMatches.length) { closeSlashCommands(); return; }
      slashMatches.forEach((command, index) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.id = 'slash-command-' + index;
        row.tabIndex = -1;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(index === slashIndex));
        const name = document.createElement('span');
        name.className = 'slash-name';
        name.textContent = '/' + command.name;
        const description = document.createElement('span');
        description.className = 'slash-description';
        description.textContent = command.description || '';
        row.append(name, description);
        row.addEventListener('mousedown', event => event.preventDefault());
        row.addEventListener('click', () => completeSlashCommand(index));
        slashMenu.appendChild(row);
      });
      slashMenu.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      input.setAttribute('aria-activedescendant', 'slash-command-' + slashIndex);
    }

    function completeSlashCommand(index) {
      const command = slashMatches[index];
      if (!command) return;
      setComposerInput('/' + command.name + ' ');
      closeSlashCommands();
    }

    function resizeInput() {
      input.style.height = '0px';
      input.style.height = input.scrollHeight + 'px';
      if (conversationPinnedToBottom) scrollConversationToBottom();
    }

    function setComposerInput(text) {
      fileCompletion?.cancel();
      input.value = text;
      slashDismissed = false;
      closeSlashCommands();
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
      $('thinking-label').textContent = current ? formatThinkingLevel(current) : '';
      thinkingUnavailableReason = !available.length ? 'Thinking is unavailable for this model.'
        : available.length === 1 ? 'Only one thinking level is available.' : '';
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
      for (const id of ['history-search-open', 'history-earlier', 'history-latest']) $(id).hidden = sessionsLayerVisible;
      input.placeholder = sessionsLayerVisible ? 'Start a new session…' : busy ? 'Write a follow-up…' : 'Ask Pi anything…';
      if (sessionsLayerVisible) renderSessions();
    }

    function showSessionDetail() {
      composerDraft?.select('session');
      sessionsLayerVisible = false;
      updateSessionLayer();
      input.focus();
    }

    function showSessionsLayer() {
      composerDraft?.select('sessions');
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
      composerDraft?.handoff();
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
      pendingQueueCount = rows.length;
      $('pending-queue').replaceChildren(...rows);
      $('pending-queue').hidden = rows.length === 0;
      $('queue-status').textContent = rows.length
        ? rows.length + (rows.length === 1 ? ' message queued' : ' messages queued')
        : '';
      $('pending-queue').title = 'Next: sent after the current tool finishes. After this: sent when Pi finishes responding.';
    }

    function updateSendState() {
      composerDraft?.changed();
      updateFileDiscoveryHint();
      const imageBlocked = attachedImages && !imageSupported;
      const imageLoading = pendingImageReads > 0;
      const sessionStartBlocked = sessionsLayerVisible && busy;
      const interactionLocked = isInteractionLocked();
      if (!interactionLocked && notice.dataset.transientLock === 'true') clearNotice();
      $('model-picker').disabled = interactionLocked || !connected;
      $('new-session').disabled = interactionLocked;
      $('delete-session').disabled = interactionLocked || !connected || !deletableSession;
      $('more').disabled = false;
      $('recover-queue').disabled = interactionLocked;
      for (const button of sessionButtons) button.disabled = interactionLocked || Boolean(sessionSwitchPending);
      input.disabled = Boolean(recoveredDraftPending);
      $('add-context').disabled = Boolean(recoveredDraftPending);
      for (const button of emptyActionButtons) button.disabled = interactionLocked;
      const canQueue = busy && queueable && !sessionsLayerVisible;
      const shellInput = input.value.startsWith('!');
      const shellBlocked = shellInput && (attachedItems > 0 || canQueue || sessionsLayerVisible);
      const queueBlocked = canQueue && (input.value.trimStart().startsWith('/') || shellInput || pendingQueueCount >= 10);
      sendButton.hidden = busy && !canQueue;
      sendButton.classList.toggle('queue-action', canQueue);
      sendButton.setAttribute('aria-label', canQueue ? 'Next: send after the current tool finishes' : 'Send message');
      $('after-this').hidden = !canQueue;
      sendButton.disabled = Boolean(composerDraft?.blocked()) || Boolean(fileCompletion?.busy) || (busy && !canQueue) || queueBlocked || shellBlocked || submissionPending || backgroundSubmissionPending || imageLoading || Boolean(recoveredDraftPending) || sessionStartBlocked || !connected || (!input.value.trim() && !attachedItems) || imageBlocked;
      $('after-this').disabled = sendButton.disabled;
      $('after-this').title = 'Send when Pi finishes responding (' + followUpShortcutLabel + ')';
      const settingsReason = !connected ? 'Reconnect to change settings.' : interactionLocked ? 'Settings are locked during active work.' : '';
      $('settings-description').textContent = [settingsReason, thinkingUnavailableReason].filter(Boolean).join(' ');
      $('model-picker').setAttribute('aria-describedby', 'settings-description');
      $('model-picker').title = modelTitle + (settingsReason ? ' · ' + settingsReason : '');
      // Submission priority controls eligibility descriptions, not runtime problem severity.
      const blocker = !connected ? 'Pi is disconnected. Use Reconnect before sending.'
        : composerDraft?.blocked() ? 'Draft context changed. Wait for the transition, or verify the session and clear the kept text.'
        : fileCompletion?.busy ? 'Capturing a file attachment. Wait for capture to finish.'
        : recoveredDraftPending ? 'Restoring draft attachments. Wait for restoration to finish.'
        : submissionPending ? 'Sending this message. Wait for Pi to accept it.'
        : backgroundSubmissionPending ? 'Starting a background agent. Wait for startup to finish.'
        : imageLoading ? 'Loading pasted images. Wait for loading to finish.'
        : sessionStartBlocked ? 'Pi is working. Wait or use Stop before starting a new session.'
        : busy && !canQueue ? 'This request cannot accept queued messages. Wait or use Stop.'
        : shellBlocked ? 'Direct shell needs an idle session without attachments. Wait, open a session, or remove attachments.'
        : queueBlocked ? input.value.trimStart().startsWith('/')
          ? 'Slash commands cannot be queued. Wait for Pi to finish.'
          : 'The queue is full (10 messages). Wait for a queued message to start.'
        : imageBlocked ? 'This model cannot use images. Choose an image-capable model or remove the images.'
        : !input.value.trim() && !attachedItems ? 'Enter a message or attach context to send.'
        : '';
      const composerStatus = $('composer-status');
      if (composerStatus.textContent !== blocker) composerStatus.textContent = blocker;
      const emptyDraft = blocker === 'Enter a message or attach context to send.';
      composerStatus.hidden = true;
      composerStatus.dataset.state = emptyDraft ? 'empty' : blocker ? 'blocked' : 'ready';
      sendButton.title = blocker || (canQueue ? 'Send after the current tool finishes (Enter)' : !input.value.trim() && attachedItems ? 'Send attachments' : sessionsLayerVisible ? 'Start new session' : 'Send message');
      if (blocker) $('after-this').title = blocker;
      $('composer-hint').textContent = imageLoading
        ? 'Loading pasted image…'
        : backgroundSubmissionPending
          ? 'Starting background agent…'
          : sessionStartBlocked
            ? 'Wait for Pi to finish before starting a new session'
            : imageBlocked
              ? 'Choose a model that supports images, or remove them'
              : queueable && !sessionsLayerVisible
                ? 'Next: after the current tool · After this: after the response · Enter / ' + followUpShortcutLabel + ' · Shift+Enter for a new line'
                : busy
                  ? 'Wait for Pi to finish before sending'
                  : shellInput ? 'Direct shell: ! includes model context · !! excludes model context, not history' : 'Enter to send · Shift+Enter for a new line';
      updateRuntimeStatus(emptyDraft ? '' : blocker);
      renderSlashCommands();
      fileCompletion?.refresh();
    }

    let renderedExtensionUi = '';
    function renderExtensionUi(state) {
      const ui = state || { statuses: [], widgets: [] };
      const serialized = JSON.stringify(ui);
      if (serialized === renderedExtensionUi) return;
      renderedExtensionUi = serialized;
      const above = $('extension-ui-above');
      const below = $('extension-ui-below');
      const status = $('extension-status');
      above.replaceChildren();
      below.replaceChildren();
      status.replaceChildren();
      function heading(parent, text) {
        const node = document.createElement('h2');
        node.textContent = text;
        parent.append(node);
      }
      if ((ui.statuses || []).length) {
        heading(status, 'Extension status');
        for (const entry of ui.statuses) {
          const row = document.createElement('p');
          row.textContent = entry.key + ': ' + entry.text;
          status.append(row);
        }
      }
      for (const placement of ['aboveEditor', 'belowEditor']) {
        const parent = placement === 'aboveEditor' ? above : below;
        const widgets = (ui.widgets || []).filter(widget => widget.placement === placement);
        if (widgets.length) heading(parent, 'Extension widgets · ' + (placement === 'aboveEditor' ? 'above editor' : 'below editor'));
        for (const widget of widgets) {
          const label = document.createElement('p');
          label.textContent = widget.key;
          const text = document.createElement('pre');
          text.textContent = widget.lines.join('\\n');
          parent.append(label, text);
        }
      }
      if (ui.diagnostic) {
        const diagnostic = document.createElement('p');
        diagnostic.textContent = ui.diagnostic;
        status.append(diagnostic);
      }
      above.hidden = !above.children.length;
      below.hidden = !below.children.length;
      status.hidden = !status.children.length;
    }

    function render(state) {
      fileCompletionSupport = state.fileCompletionSupport || { available: false, reason: 'File completion is unavailable in this workspace.' };
      updateFileDiscoveryHint();
      renderExtensionUi(state.extensionUi);
      const catalog = [{ name: 'compact', description: 'Manually compact the session context' }, { name: 'reload', description: 'Reload approved Pi resources without a model request' }, ...(state.runtime.commands || []).filter((command) => typeof command.name === 'string' && command.name !== 'reload' && !command.name.startsWith('vscode-pi-'))];
      const names = new Set();
      slashCommands = catalog.filter(command => {
        if (!command || typeof command.name !== 'string' || !/^[^\\s/]+$/.test(command.name) || names.has(command.name)) return false;
        if (command.name === 'vscode-pi-read-only-ready') return false;
        names.add(command.name);
        return true;
      });
      const sessionIdentity = JSON.stringify([state.runtime.sessionId, state.runtime.sessionFile]);
      if (displayedSessionIdentity !== undefined && displayedSessionIdentity !== sessionIdentity) {
        conversationPinnedToBottom = true;
        hasNewTranscriptOutput = false;
        lastTranscriptSignature = '';
      }
      displayedSessionIdentity = sessionIdentity;
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
      conversationHistory.beforeRender(state);
      const followConversation = renderMessages(state.messages || []);
      renderTools(state.tools || []);
      if (followConversation) scrollConversationToBottom();
      conversationHistory.onState(state);
      renderProposals(state.proposals || []);
      renderChanges(state.changes || []);
      renderBackground(state.backgroundTasks || []);
      renderAttachments(state.attachments || []);
      const estimate = state.attachmentEstimate || {};
      const attachmentCount = (state.attachments || []).length;
      const imageCount = (state.attachments || []).filter(attachment => attachment.image).length;
      $('attachment-estimate').textContent = attachmentCount
        ? (imageCount ? imageCount + (imageCount === 1 ? ' image' : ' images') : '')
          + (attachmentCount > imageCount ? (imageCount ? ' · ' : '') + (estimate.characters || 0) + ' attachment text characters' : '')
        : '';
      $('attachment-estimate').title = attachmentCount
        ? 'About ' + (estimate.estimatedTextTokens || 0) + ' attachment text tokens (estimated); image tokens not included. Attach → View attachments for details.'
        : '';
      $('activity').hidden = ![state.proposals, state.changes, state.backgroundTasks].some(items => items && items.length);
      renderThinkingLevel(state.runtime);
      const currentModel = state.runtime.model || {};
      $('model-label').textContent = currentModel.name || currentModel.id || 'Choose model…';
      const modelName = currentModel.name || currentModel.id || 'Choose model';
      const modelIdentity = currentModel.provider && currentModel.id ? currentModel.provider + '/' + currentModel.id : modelName;
      const thinkingName = $('thinking-label').textContent || 'Unavailable';
      modelTitle = modelName + ' · ' + modelIdentity + ' · Thinking: ' + thinkingName;
      $('model-picker').setAttribute('aria-label', 'Pi model: ' + modelName + ' · ' + modelIdentity + ' · Thinking: ' + thinkingName + '. Change model or thinking level');
      $('delete-session').hidden = !deletableSession;
      $('runtime').dataset.connection = !connected ? 'disconnected' : busy ? 'busy' : 'connected';
      const status = busy && (!state.status || state.status === 'Ready') ? 'Working…' : state.status || 'Ready';
      latestStatus = status + (connected || /disconnected/i.test(status) ? '' : ' · disconnected');
      $('session').value = state.runtime.sessionId || '';
      $('session-details').hidden = !state.runtime.sessionId;
      const context = (state.runtime.stats || {}).contextUsage || {};
      const hasContextUsage = typeof context.percent === 'number';
      $('usage').textContent = hasContextUsage ? 'Context ' + Math.round(context.percent) + '%' : 'Context usage is unavailable.';
      $('usage').title = hasContextUsage ? 'Share of the model’s context window currently in use' : '';
      updateRecoveryControl('reconnect', connected);
      updateRecoveryControl('retry', !state.retryAvailable, busy || !connected);
      updateRecoveryControl('refresh-history', !state.historyRecoveryAvailable, busy || !connected);
      cancelButton.hidden = !cancellable;
      updateSendState();
      updateLatestOutput();
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
      // A deferred close event from an earlier preview must not clear a newly opened preview.
      if ($('image-preview').open || !previewAssetId) return;
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

    function showConversationDetails() {
      closeSlashCommands();
      if (!conversationDetails.open) conversationDetails.showModal();
      $('conversation-details-close').focus();
    }
    function closeConversationDetails(focusComposer = false) {
      if (conversationDetails.open) conversationDetails.close();
      // Native close events are deferred. Restore focus once, not again after later navigation.
      (focusComposer === true ? input : $('more')).focus();
    }
    conversationDetails.addEventListener('cancel', event => { event.preventDefault(); closeConversationDetails(); });
    $('conversation-details-close').addEventListener('click', closeConversationDetails);

    ${composerFileCompletionHtml()}
    ${composerDraftHtml()}
    ${conversationHistoryScript()}
    conversationHistory.bind({
      pauseFollowing() { conversationPinnedToBottom = false; updateLatestOutput(); },
      followLatest() { scrollConversationToBottom(); }
    });
    window.addEventListener('message', event => {
      const message = event.data;
      if (!message || typeof message.type !== 'string') return;
      composerDraft.receive(message);
      fileCompletion.receive(message);
      if (['setInput', 'clearInput', 'appendDraft', 'commitRecoveredDraft', 'showSessionDetail', 'showSessionsLayer'].includes(message.type)) fileCompletion.cancel();
      if (message.type === 'state') render(message);
      else if (message.type === 'showSessionDetail') showSessionDetail();
      else if (message.type === 'showSessionsLayer') showSessionsLayer();
      else if (message.type === 'showConversationDetails') showConversationDetails();
      else if (message.type === 'toggleCodeWrapping') toggleCodeWrapping();
      else if (message.type === 'imageAsset') acceptImageAsset(message);
      else if (message.type === 'notice') showNotice(message.message, message.level, Boolean(message.outputAvailable));
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
        } else { showNotice('Your draft changed. The recovered message is still available under Restore drafts.', 'warning'); }
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
      else if (message.type === 'restoreBranchDraft') {
        const unchanged = message.expectedRevision === undefined ? !input.value : composerRevision === message.expectedRevision;
        if (unchanged && input.value.length + message.text.length + (input.value ? 2 : 0) <= ${maxInputCharacters}) {
          input.value += (input.value ? '\\n\\n' : '') + message.text;
          composerRevision += 1; resizeInput(); updateSendState(); input.focus();
        } else { showNotice('Your draft changed or is full. Browse the session tree again to recover the selected message.', 'warning'); }
      }
      else if (message.type === 'setInput') {
        setComposerInput(message.text);
      }
      else if (message.type === 'clearInput') {
        submissionPending = false;
        const revisionMatches = composerDraft.matches(message.draftBinding, message.expectedRevision, message.expectedText) && (message.expectedRevision === undefined || composerRevision === message.expectedRevision);
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
    $('after-this').addEventListener('click', () => submit('followUp'));
    cancelButton.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
    $('reconnect').addEventListener('click', () => vscode.postMessage({ type: 'reconnect' }));
    $('retry').addEventListener('click', () => vscode.postMessage({ type: 'retry' }));
    $('refresh-history').addEventListener('click', () => vscode.postMessage({ type: 'refreshHistory' }));
    $('add-context').addEventListener('click', () => vscode.postMessage({ type: 'pickContext' }));
    $('model-picker').addEventListener('click', () => vscode.postMessage({ type: 'pickComposerSettings' }));
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
      composerDraft?.handoff();
      showSessionDetail();
      vscode.postMessage({ type: 'newSession' });
    });
    $('delete-session').addEventListener('click', () => vscode.postMessage({ type: 'deleteSession' }));
    $('more').addEventListener('click', () => vscode.postMessage({ type: 'showMoreActions', text: input.value, revision: composerRevision, codeWrapping: messagesElement.classList.contains('wrap-code') }));
    $('source-control').addEventListener('click', () => vscode.postMessage({ type: 'openSourceControl' }));
    input.addEventListener('input', () => { composerRevision += 1; slashFocused = true; slashDismissed = false; slashIndex = 0; resizeInput(); updateSendState(); });
    input.addEventListener('click', renderSlashCommands);
    input.addEventListener('keyup', event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') renderSlashCommands(); });
    input.addEventListener('blur', () => { slashFocused = false; closeSlashCommands(); });
    input.addEventListener('focus', () => { slashFocused = true; renderSlashCommands(); });
    $('jump-to-latest').addEventListener('click', () => {
      if (conversationHistory.isEarlier()) conversationHistory.latest();
      else scrollConversationToBottom();
      input.focus();
    });
    window.addEventListener('pi-transcript-layout', updateLatestOutput);
    window.addEventListener('resize', resizeInput);
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => {
        const resized = conversationClientHeight !== conversationElement.clientHeight;
        conversationClientHeight = conversationElement.clientHeight;
        if (conversationPinnedToBottom) scrollConversationToBottom();
        else if (resized) programmaticConversationScrollTop = conversationElement.scrollTop;
        updateLatestOutput();
      }).observe(conversationElement);
    }
    conversationElement.addEventListener('scroll', event => {
      const resized = conversationClientHeight !== conversationElement.clientHeight;
      conversationClientHeight = conversationElement.clientHeight;
      if (resized) {
        // A wrapping status can resize the viewport and clamp scrollTop near the tail.
        // Layout alone must not resume following or clear the unread-output indicator.
        if (conversationPinnedToBottom) scrollConversationToBottom();
        else updateLatestOutput();
        return;
      }
      if (conversationElement.scrollTop === programmaticConversationScrollTop) {
        programmaticConversationScrollTop = undefined;
        updateLatestOutput();
        return;
      }
      const atBottom = conversationElement.scrollHeight - conversationElement.scrollTop - conversationElement.clientHeight <= 16;
      if (atBottom) conversationPinnedToBottom = true;
      else if (event.isTrusted) conversationPinnedToBottom = false;
      programmaticConversationScrollTop = undefined;
      updateLatestOutput();
    });
    conversationElement.addEventListener('wheel', event => {
      if (event.deltaY < 0) conversationPinnedToBottom = false;
      updateLatestOutput();
    });
    input.addEventListener('paste', attachPastedImages);
    input.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (fileCompletion.keydown(event)) return;
      if (!slashMenu.hidden && slashMatches.length && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          slashIndex = (slashIndex + (event.key === 'ArrowDown' ? 1 : -1) + slashMatches.length) % slashMatches.length;
          renderSlashCommands();
          slashMenu.children[slashIndex]?.scrollIntoView?.({ block: 'nearest' });
          return;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault(); completeSlashCommand(slashIndex); return;
        }
        if (event.key === 'Escape') {
          event.preventDefault(); slashDismissed = true; closeSlashCommands(); return;
        }
      }
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
      const button = event.target instanceof Element ? event.target.closest('button[data-notice-output]') : undefined;
      if (button) vscode.postMessage({ type: 'showOutput' });
      else if (event.target instanceof Element && event.target.closest('button[data-notice-dismiss]')) clearNotice();
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
