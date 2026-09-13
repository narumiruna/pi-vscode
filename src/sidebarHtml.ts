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
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <style nonce="${nonce}">
    :root { color-scheme: light dark; }
    body { --pi-border: var(--vscode-sideBar-border, var(--vscode-widget-border, transparent)); --pi-accent: var(--vscode-textLink-foreground); }
    body.vscode-light, body.vscode-high-contrast-light { color-scheme: light; }
    body.vscode-dark, body.vscode-high-contrast { color-scheme: dark; }
    * { box-sizing: border-box; }
    /* Author display rules must never override native hidden state. */
    [hidden] { display: none !important; }
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); line-height: 1.5; overflow: hidden; }
    #app { height: 100vh; min-width: 0; display: grid; grid-template-rows: auto auto minmax(0, 1fr) auto auto auto; padding: 0 12px 10px; }
    button, select { min-height: 28px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 6px; padding: 4px 9px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; font: inherit; }
    button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
    button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-foreground); background: transparent; }
    button.secondary:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
    button.danger { color: var(--vscode-errorForeground); }
    button:focus-visible, select:focus-visible, summary:focus-visible, textarea:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    button:disabled, select:disabled { cursor: default; opacity: .5; }
    .icon { width: 16px; height: 16px; flex: 0 0 auto; }
    .icon-button { width: 28px; padding: 5px; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
    .header { display: flex; gap: 4px; align-items: center; justify-content: flex-end; padding: 10px 0 8px; }
    .header button { min-width: 0; white-space: nowrap; }
    #thinking-level { min-width: 0; max-width: 104px; color: var(--vscode-foreground); background: var(--vscode-input-background); border-color: var(--vscode-input-border, var(--pi-border)); }
    #model-picker { min-width: 0; max-width: 132px; justify-content: flex-start; color: var(--vscode-descriptionForeground); }
    #model-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #model-picker .icon { width: 12px; height: 12px; }
    #runtime { display: flex; flex-wrap: wrap; min-width: 0; gap: 6px; align-items: center; padding: 0 2px 9px; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--pi-border); font-size: .82em; }
    .status-dot { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: var(--vscode-descriptionForeground); }
    #runtime[data-connection="connected"] .status-dot { background: var(--vscode-testing-iconPassed, var(--pi-accent)); }
    #runtime[data-connection="busy"] .status-dot { background: var(--vscode-progressBar-background); }
    #runtime[data-connection="disconnected"] .status-dot { background: var(--vscode-editorWarning-foreground); }
    #runtime span:not(.status-dot) { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #status { flex: 1 1 70px; }
    #session { max-width: 38%; }
    #usage { font-variant-numeric: tabular-nums; }
    #runtime button { min-height: 24px; padding: 2px 6px; font-size: inherit; }
    #messages { min-width: 0; overflow-y: auto; padding: 18px 2px 8px; scrollbar-width: thin; }
    #messages.is-empty { display: flex; }
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
    .content code { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
    .content :not(pre) > code { padding: 1px 4px; background: var(--vscode-textCodeBlock-background); border-radius: 4px; }
    .content ul { margin: 8px 0; padding-left: 22px; }
    .user .content { padding: 10px 12px; border-radius: 9px; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
    .context, .truncated { display: inline-block; max-width: 100%; margin: 6px 4px 0 0; padding: 2px 7px; border-radius: 5px; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); font-size: .8em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #activity { max-height: min(28vh, 240px); overflow-y: auto; padding: 8px 2px 0; border-top: 1px solid var(--pi-border); scrollbar-width: thin; }
    .proposal, .change, .tool, .background-task { margin: 0 0 6px; border: 1px solid var(--pi-border); border-radius: 7px; }
    .proposal, .background-task { padding: 9px; }
    .proposal-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .proposal-meta, .background-meta { color: var(--vscode-descriptionForeground); font-size: .85em; }
    .proposal-error { color: var(--vscode-errorForeground); font-size: .85em; overflow-wrap: anywhere; }
    .proposal-actions, .change-actions, .background-actions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
    #tools-group { margin-bottom: 6px; }
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
    #attachments { display: flex; gap: 5px; flex-wrap: wrap; padding: 8px 10px 0; }
    .attachment { display: inline-flex; max-width: 100%; align-items: center; gap: 4px; padding: 3px 4px 3px 7px; border-radius: 5px; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); font-size: .82em; }
    .attachment-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .attachment button { min-height: 20px; width: 20px; padding: 0; color: inherit; background: transparent; }
    #composer { min-width: 0; padding-top: 10px; }
    .composer-box { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--pi-border)); border-radius: 10px; }
    .composer-box:focus-within { border-color: var(--vscode-focusBorder); }
    textarea { display: block; width: 100%; height: 82px; min-height: 82px; max-height: min(220px, 28vh); resize: none; padding: 12px; color: var(--vscode-input-foreground); background: transparent; border: 0; border-radius: 10px; font: inherit; line-height: 1.5; scrollbar-width: thin; }
    textarea:focus-visible { outline: none; }
    textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
    .composer-actions { display: flex; flex-wrap: nowrap; min-width: 0; gap: 6px; padding: 0 7px 7px; align-items: center; }
    #add-context { flex: 0 1 auto; min-width: 28px; color: var(--vscode-descriptionForeground); font-size: .9em; }
    .composer-spacer { min-width: 0; flex: 1; }
    #send { width: 28px; flex: 0 0 28px; padding: 5px; }
    #cancel { font-size: .9em; }
    #composer-hint { margin: 6px 2px 0; color: var(--vscode-descriptionForeground); font-size: .78em; text-align: right; overflow-wrap: anywhere; }
    #notice { max-height: 20vh; overflow-y: auto; padding: 7px 2px 0; color: var(--vscode-descriptionForeground); font-size: .85em; overflow-wrap: anywhere; }
    #notice:empty { display: none; }
    #notice.error { color: var(--vscode-errorForeground); }
    #notice.warning { color: var(--vscode-editorWarning-foreground); }
    body.vscode-high-contrast .composer-box, body.vscode-high-contrast-light .composer-box,
    body.vscode-high-contrast .welcome-action, body.vscode-high-contrast-light .welcome-action { border-color: var(--vscode-contrastBorder); }
    body.vscode-high-contrast .composer-box:focus-within, body.vscode-high-contrast-light .composer-box:focus-within { border-color: var(--vscode-focusBorder); }
    @media (max-width: 340px) { #app { padding: 0 8px 8px; } .header { gap: 2px; } #session { display: none; } #add-context span { display: none; } #model-picker { max-width: 96px; } #thinking-level { max-width: 90px; } .empty { padding-left: 2px; padding-right: 2px; } .empty h2 { font-size: 1.5em; } button.welcome-action { gap: 9px; padding: 10px; } }
    @media (max-height: 500px) { .empty { padding-top: 8px; padding-bottom: 16px; } .welcome-mark { display: none; } .empty-actions { margin-top: 16px; } textarea { height: 64px; min-height: 64px; } }
    @media (prefers-reduced-motion: no-preference) { button { transition: background-color .12s ease, border-color .12s ease; } }
  </style>
</head>
<body>
  <main id="app">
    <header class="header" aria-label="Pi conversation controls">
      <button id="new-session" class="secondary icon-button" type="button" title="New conversation" aria-label="New Pi conversation">${icon("plus")}</button>
      <button id="delete-session" class="secondary danger icon-button" type="button" title="Delete conversation" aria-label="Delete current Pi conversation" hidden>${icon("trash")}</button>
      <button id="more" class="secondary icon-button" type="button" title="More… · Session and advanced actions" aria-label="More Pi actions">${icon("more")}</button>
    </header>
    <div id="runtime"><span class="status-dot" aria-hidden="true"></span><span id="status" role="status" aria-live="polite">Connecting…</span><span id="session"></span><span id="usage"></span><button id="retry" class="secondary" type="button" hidden>Retry</button><button id="refresh-history" class="secondary" type="button" hidden>Refresh history</button><button id="reconnect" class="secondary" type="button" hidden>Reconnect</button></div>
    <section id="messages" aria-live="off" aria-label="Pi conversation"></section>
    <section id="activity" aria-label="Pi activity" hidden>
      <div id="proposals-heading" class="section-heading" hidden><span>Edit proposals</span></div><section id="proposals" aria-label="Pi edit proposals"></section>
      <details id="tools-group" hidden><summary><span id="tools-summary">Tool activity</span></summary><section id="tools" aria-label="Pi tool activity"></section></details>
      <div id="changes-heading" class="section-heading" hidden><span>Pi changes</span><button id="source-control" class="secondary" type="button">Source Control</button></div><section id="changes" aria-label="Pi file changes"></section>
      <div id="background-heading" class="section-heading" hidden><span>Background agents</span></div><section id="background" aria-label="Background Pi agents"></section>
    </section>
    <section id="composer" aria-label="Message composer">
      <div class="composer-box">
        <div id="attachments" aria-label="Context attached to the next message" hidden></div>
        <button id="inspect-context" class="secondary" type="button" hidden>Inspect Context</button>
        <div id="attachment-estimate" class="proposal-meta"></div>
        <label for="input" class="sr-only">Message Pi</label>
        <textarea id="input" rows="3" maxlength="${maxInputCharacters}" placeholder="Ask, plan, or build something…" aria-describedby="composer-hint"></textarea>
        <div id="queue-status" class="proposal-meta" role="status"></div>
        <div class="proposal-actions">
          <button id="steer" class="secondary" type="button" hidden title="Delivered after current tool calls, not an immediate interruption">Steer</button>
          <button id="follow-up" class="secondary" type="button" hidden>Follow Up</button>
          <button id="inspect-queue" class="secondary" type="button" hidden>Inspect Queue</button>
          <button id="clear-queue" class="secondary" type="button" hidden>Clear Queue</button>
          <button id="recover-queue" class="secondary" type="button" hidden>Recovered Drafts</button>
        </div>
        <div class="composer-actions">
          <button id="add-context" class="secondary" type="button" title="Attach code, files, or images">${icon("attachment")}<span>Add context</span></button>
          <span class="composer-spacer"></span>
          <button id="cancel" class="secondary" type="button" aria-label="Cancel Pi response" hidden>${icon("stop")}<span>Stop</span></button>
          <button id="model-picker" class="secondary" type="button" aria-label="Change Pi model"><span id="model-label">Choose model…</span>${icon("chevron")}</button>
          <label for="thinking-level" class="sr-only">Pi thinking level</label>
          <select id="thinking-level" aria-label="Pi thinking level" title="Pi thinking level"><option value="">Thinking: —</option></select>
          <button id="send" type="button" aria-label="Send message" title="Send message" disabled>${icon("send")}</button>
        </div>
      </div>
      <div id="composer-hint">Enter to send · Shift+Enter for newline</div>
    </section>
    <div id="notice" role="status" aria-live="polite"></div>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const $ = id => document.getElementById(id);
    const messagesElement = $('messages');
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
    $('composer-hint').textContent = 'Enter to send · ' + followUpShortcutLabel + ' also sends · Shift+Enter for newline';
    let busy = false;
    let queueable = false;
    let connected = false;
    let deletableSession = false;
    let imageSupported = true;
    let attachedImages = false;
    let pendingImageReads = 0;
    let submissionPending = false;
    let backgroundSubmissionPending = false;
    let composerRevision = 0;
    let updatingControls = false;
    let thinkingSelectable = false;

    function submit(kind = 'steer') {
      const text = input.value.trim();
      if (!text || !connected || submissionPending || backgroundSubmissionPending) return;
      if (busy) {
        if (!queueable) {
          notice.textContent = 'This request does not accept queued messages.';
          notice.className = 'warning';
          return;
        }
        submissionPending = true;
        updateSendState();
        vscode.postMessage({ type: 'queueInstruction', kind, text: input.value, revision: composerRevision });
      } else {
        if (pendingImageReads > 0 || (attachedImages && !imageSupported)) return;
        submissionPending = true;
        updateSendState();
        vscode.postMessage({ type: 'send', text: input.value, revision: composerRevision });
      }
      notice.textContent = '';
    }

    function renderMessages(messages) {
      const nearBottom = messagesElement.scrollHeight - messagesElement.scrollTop - messagesElement.clientHeight < 80;
      const visibleMessages = messages.filter(message => message.role !== 'assistant' || Boolean(message.html));
      messagesElement.replaceChildren();
      emptyActionButtons.length = 0;
      messagesElement.classList.toggle('is-empty', visibleMessages.length === 0);
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
        for (const message of visibleMessages) {
          const wrapper = document.createElement('article');
          wrapper.className = 'message ' + message.role;
          const role = document.createElement('div');
          role.className = 'role';
          role.textContent = message.role === 'user' ? 'You' : 'Pi';
          const content = document.createElement('div');
          content.className = 'content';
          content.innerHTML = message.html || (message.role === 'assistant' ? '…' : '');
          wrapper.append(role, content);
          if (message.contextLabel) {
            const context = document.createElement('div');
            context.className = 'context';
            context.textContent = message.contextLabel;
            context.title = message.contextLabel;
            wrapper.appendChild(context);
          }
          if (message.truncated) {
            const truncated = document.createElement('div');
            truncated.className = 'truncated';
            truncated.textContent = 'Older content not shown';
            wrapper.appendChild(truncated);
          }
          messagesElement.appendChild(wrapper);
        }
      }
      if (visibleMessages.length === 0) messagesElement.scrollTop = 0;
      else if (nearBottom || busy) messagesElement.scrollTop = messagesElement.scrollHeight;
    }

    function renderProposals(proposals) {
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
        meta.textContent = (proposal.status === 'ready' ? 'Ready to preview' : proposal.status) + (proposal.totalHunks !== undefined ? ' · ' + (proposal.selected || []).length + '/' + proposal.totalHunks + ' selected' : '') + (proposal.summary ? ' · ' + proposal.summary : '');
        card.append(title, meta);
        if (proposal.error) {
          const error = document.createElement('div');
          error.className = 'proposal-error';
          error.textContent = proposal.error;
          card.appendChild(error);
        }
        const actions = document.createElement('div');
        actions.className = 'proposal-actions';
        const terminal = ['applied', 'rejected', 'stale'].includes(proposal.status);
        const transitioning = ['previewing', 'applying', 'rejecting'].includes(proposal.status);
        for (const definition of [['select', 'Choose Hunks'], ['preview', 'Preview'], ['apply', 'Apply'], ['reject', 'Reject']]) {
          if (definition[0] === 'select' && proposal.totalHunks === undefined) continue;
          const button = document.createElement('button');
          button.className = definition[0] === 'apply' ? '' : 'secondary';
          button.type = 'button';
          button.textContent = definition[1];
          button.dataset.proposalAction = definition[0];
          button.dataset.id = proposal.id;
          button.disabled = busy || terminal || transitioning || (definition[0] === 'apply' && proposal.status !== 'previewed');
          actions.appendChild(button);
        }
        card.appendChild(actions);
        proposalsElement.appendChild(card);
      }
    }

    function renderTools(tools) {
      // Preserve user disclosure choices across streamed state updates.
      const openTools = new Map(Array.from(toolsElement.children, details => [details.dataset.id, details.open]));
      const group = $('tools-group');
      group.hidden = tools.length === 0;
      if (!tools.length) group.open = false;
      const running = tools.filter(tool => tool.status === 'running');
      const failed = tools.filter(tool => tool.status === 'error');
      group.dataset.status = running.length ? 'running' : failed.length ? 'error' : 'success';
      $('tools-summary').textContent = running.length
        ? 'Running · ' + running[running.length - 1].name + (running.length > 1 ? ' · ' + running.length + ' active' : '')
        : tools.length + (tools.length === 1 ? ' tool call' : ' tool calls') + (failed.length ? ' · ' + failed.length + ' failed' : ' · completed');
      toolsElement.replaceChildren();
      for (const tool of tools) {
        const details = document.createElement('details');
        details.className = 'tool ' + tool.status;
        details.dataset.id = tool.id;
        details.open = openTools.get(tool.id) ?? tool.status !== 'success';
        const summary = document.createElement('summary');
        summary.textContent = (tool.status === 'running' ? 'Running · ' : tool.status === 'error' ? 'Failed · ' : 'Completed · ') + tool.name;
        const pre = document.createElement('pre');
        pre.textContent = tool.output || tool.input;
        details.append(summary, pre);
        toolsElement.appendChild(details);
      }
    }

    function renderChanges(changes) {
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
    }

    function renderBackground(tasks) {
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
    }

    function renderAttachments(attachments) {
      attachmentsElement.replaceChildren();
      attachedImages = attachments.some(attachment => attachment.image);
      attachmentsElement.hidden = attachments.length === 0;
      for (const attachment of attachments) {
        const chip = document.createElement('span');
        chip.className = 'attachment';
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
        remove.disabled = busy;
        chip.append(label, remove);
        attachmentsElement.appendChild(chip);
      }
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

    function updateSendState() {
      const imageBlocked = !busy && attachedImages && !imageSupported;
      const imageLoading = pendingImageReads > 0;
      const interactionLocked = busy || submissionPending || backgroundSubmissionPending || imageLoading;
      $('model-picker').disabled = interactionLocked || !connected;
      thinkingLevel.disabled = interactionLocked || !connected || !thinkingSelectable;
      $('new-session').disabled = interactionLocked;
      $('delete-session').disabled = interactionLocked || !connected || !deletableSession;
      $('more').disabled = interactionLocked || !connected;
      $('add-context').disabled = interactionLocked;
      for (const button of emptyActionButtons) button.disabled = interactionLocked;
      sendButton.disabled = interactionLocked || !connected || !input.value.trim() || imageBlocked;
      $('steer').disabled = $('follow-up').disabled = !queueable || !input.value.trim() || !connected || submissionPending;
      $('clear-queue').disabled = !queueable || submissionPending;
      sendButton.title = imageLoading
        ? 'Wait for pasted images to finish loading.'
        : submissionPending
          ? 'Waiting for Pi to accept this message.'
          : backgroundSubmissionPending
            ? 'Wait for the background agent to finish starting.'
            : imageBlocked
              ? 'The current model does not support image attachments.'
              : !connected ? 'Reconnect to Pi before sending.' : 'Send message';
      $('composer-hint').textContent = imageLoading
        ? 'Loading pasted image…'
        : backgroundSubmissionPending
          ? 'Starting background agent…'
          : imageBlocked
            ? 'Choose an image-capable model or remove images'
            : queueable
              ? 'Enter to steer · ' + followUpShortcutLabel + ' for follow-up · Shift+Enter for newline'
              : busy
                ? 'This request does not accept queued messages'
                : 'Enter to send · ' + followUpShortcutLabel + ' also sends · Shift+Enter for newline';
    }

    function render(state) {
      busy = Boolean(state.runtime.busy);
      queueable = Boolean(state.runtime.queueable) && busy;
      $('steer').hidden = $('follow-up').hidden = $('clear-queue').hidden = $('inspect-queue').hidden = !queueable;
      const queue = state.runtime.queue || { steering: [], followUp: [] };
      $('queue-status').textContent = queueable ? queue.steering.length + ' steering · ' + queue.followUp.length + ' follow-ups pending · text only; attachments excluded · steering waits for tool calls' : '';
      $('recover-queue').hidden = !(state.runtime.recoveredDrafts || []).length;
      connected = Boolean(state.runtime.connected);
      deletableSession = Boolean(state.runtime.sessionFile);
      imageSupported = Boolean(state.imageSupported);
      backgroundSubmissionPending = Boolean(state.backgroundSubmissionPending);
      renderMessages(state.messages || []);
      renderProposals(state.proposals || []);
      renderTools(state.tools || []);
      renderChanges(state.changes || []);
      renderBackground(state.backgroundTasks || []);
      renderAttachments(state.attachments || []);
      $('inspect-context').hidden = !(state.attachments || []).length;
      const estimate = state.attachmentEstimate || {};
      $('attachment-estimate').textContent = estimate.characters || attachedImages ? 'Attachments: ' + (estimate.characters || 0) + ' chars · ≈' + (estimate.estimatedTextTokens || 0) + ' heuristic text tokens' + (attachedImages ? ' · image usage unknown' : '') : '';
      $('activity').hidden = ![state.proposals, state.tools, state.changes, state.backgroundTasks].some(items => items && items.length);
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
      $('status').textContent = state.status + (connected ? '' : ' · disconnected');
      $('status').title = $('status').textContent;
      $('session').textContent = state.runtime.sessionName || (state.runtime.sessionId ? 'Session ' + state.runtime.sessionId.slice(0, 8) : '');
      $('session').title = state.runtime.sessionName || state.runtime.sessionId || '';
      const context = (state.runtime.stats || {}).contextUsage || {};
      $('usage').textContent = typeof context.percent === 'number' ? Math.round(context.percent) + '% Pi context' : 'Pi context unknown';
      $('reconnect').hidden = connected;
      $('retry').hidden = !state.retryAvailable;
      $('retry').disabled = busy || !connected;
      $('refresh-history').hidden = !state.historyRecoveryAvailable;
      $('refresh-history').disabled = busy || !connected;
      $('add-context').disabled = busy;
      cancelButton.hidden = !busy;
      sendButton.hidden = busy;
      updateSendState();
    }

    function attachPastedImages(event) {
      const items = Array.from((event.clipboardData && event.clipboardData.items) || []);
      const files = items.filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean);
      if (files.length === 0) return;
      event.preventDefault();
      if (busy) {
        notice.textContent = 'Cancel or wait for Pi before changing attachments.';
        notice.className = 'warning';
        return;
      }
      for (const file of files) {
        if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type.toLowerCase())) {
          notice.textContent = 'Only PNG, JPEG, GIF, and WebP images can be pasted.';
          notice.className = 'warning';
          continue;
        }
        if (file.size > ${maxImageBytes}) {
          notice.textContent = 'Pasted images are limited to 5 MiB each.';
          notice.className = 'warning';
          continue;
        }
        pendingImageReads += 1;
        updateSendState();
        const reader = new FileReader();
        reader.addEventListener('load', () => {
          const result = typeof reader.result === 'string' ? reader.result : '';
          const separator = result.indexOf(',');
          if (separator < 0) {
            notice.textContent = 'Could not read the pasted image.';
            notice.className = 'error';
            return;
          }
          vscode.postMessage({ type: 'pasteImage', data: result.slice(separator + 1), mimeType: file.type, fileName: file.name || 'pasted-image' });
        });
        reader.addEventListener('error', () => { notice.textContent = 'Could not read the pasted image.'; notice.className = 'error'; });
        reader.addEventListener('loadend', () => {
          pendingImageReads = Math.max(0, pendingImageReads - 1);
          updateSendState();
        });
        reader.readAsDataURL(file);
      }
    }

    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'state') render(message);
      else if (message.type === 'notice') { notice.textContent = message.message; notice.className = message.level; }
      else if (message.type === 'appendDraft') {
        if (composerRevision === message.expectedRevision) {
          input.value += (input.value ? '\\n\\n' : '') + message.text;
          composerRevision += 1; resizeInput(); updateSendState();
        } else { notice.textContent = 'Your draft changed. The recovered message remains in Recovered Drafts.'; }
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
    });
    for (const [id, kind] of [['steer', 'steer'], ['follow-up', 'followUp']]) {
      $(id).addEventListener('click', () => submit(kind));
    }
    $('clear-queue').addEventListener('click', () => vscode.postMessage({ type: 'clearQueue' }));
    $('inspect-queue').addEventListener('click', () => vscode.postMessage({ type: 'inspectQueue' }));
    $('recover-queue').addEventListener('click', () => vscode.postMessage({ type: 'recoverQueue', revision: composerRevision }));
    sendButton.addEventListener('click', () => submit());
    cancelButton.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
    $('reconnect').addEventListener('click', () => vscode.postMessage({ type: 'reconnect' }));
    $('retry').addEventListener('click', () => vscode.postMessage({ type: 'retry' }));
    $('refresh-history').addEventListener('click', () => vscode.postMessage({ type: 'refreshHistory' }));
    $('inspect-context').addEventListener('click', () => vscode.postMessage({ type: 'inspectContext' }));
    $('add-context').addEventListener('click', () => vscode.postMessage({ type: 'pickContext' }));
    $('model-picker').addEventListener('click', () => vscode.postMessage({ type: 'pickModel' }));
    $('new-session').addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));
    $('delete-session').addEventListener('click', () => vscode.postMessage({ type: 'deleteSession' }));
    $('more').addEventListener('click', () => vscode.postMessage({ type: 'showMoreActions', text: input.value, revision: composerRevision }));
    $('source-control').addEventListener('click', () => vscode.postMessage({ type: 'openSourceControl' }));
    thinkingLevel.addEventListener('change', () => { if (!updatingControls) vscode.postMessage({ type: 'setThinking', level: thinkingLevel.value }); });
    input.addEventListener('input', () => { composerRevision += 1; resizeInput(); updateSendState(); });
    window.addEventListener('resize', resizeInput);
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
    messagesElement.addEventListener('click', event => {
      const button = event.target instanceof Element ? event.target.closest('button[data-empty-action]') : undefined;
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
      const button = event.target instanceof Element ? event.target.closest('button[data-remove-attachment]') : undefined;
      if (button) vscode.postMessage({ type: 'removeAttachment', id: button.dataset.removeAttachment });
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
    input.focus();
  </script>
</body>
</html>`;
}
