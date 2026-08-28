import { randomBytes } from "node:crypto";

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
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); line-height: 1.45; overflow: hidden; }
    #app { height: 100vh; min-width: 0; display: grid; grid-template-rows: auto auto minmax(0, 1fr) auto auto auto; }
    button, select { min-height: 28px; border: 1px solid transparent; border-radius: 3px; padding: 3px 8px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; font: inherit; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary, select { color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground); border-color: var(--vscode-button-border, transparent); }
    button:focus-visible, select:focus-visible, textarea:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    button:disabled, select:disabled { cursor: default; opacity: .55; }
    .header { display: grid; grid-template-columns: minmax(72px, auto) minmax(0, 1fr) auto auto; gap: 5px; padding: 7px 8px; border-bottom: 1px solid var(--vscode-sideBar-border, transparent); }
    .header select, .header button { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #model-picker { text-align: left; }
    #runtime { display: flex; min-width: 0; gap: 8px; align-items: center; padding: 4px 9px; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-sideBar-border, transparent); font-size: .82em; }
    #runtime span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #runtime #status { flex: 1; }
    #reconnect { min-height: 22px; padding: 1px 6px; }
    #messages { min-width: 0; overflow-y: auto; padding: 10px; }
    .empty { margin: 10vh 12px 0; text-align: center; color: var(--vscode-descriptionForeground); }
    .empty h2 { margin: 0 0 6px; color: var(--vscode-foreground); font-size: 1.05em; }
    .empty-actions { display: grid; gap: 6px; margin-top: 14px; }
    .message { min-width: 0; margin: 0 0 12px; }
    .role { margin-bottom: 3px; color: var(--vscode-descriptionForeground); font-size: .78em; font-weight: 600; text-transform: uppercase; }
    .content { min-width: 0; padding: 8px 10px; border-radius: 6px; overflow-wrap: anywhere; }
    .content p { margin: 0 0 7px; }
    .content p:last-child { margin-bottom: 0; }
    .content pre { max-width: 100%; overflow: auto; margin: 7px 0; padding: 7px; background: var(--vscode-textCodeBlock-background); border-radius: 3px; white-space: pre; }
    .content code { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
    .content :not(pre) > code { padding: 1px 3px; background: var(--vscode-textCodeBlock-background); border-radius: 2px; }
    .content ul { margin: 5px 0; padding-left: 22px; }
    .user .content { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
    .assistant .content { background: var(--vscode-editor-background); border: 1px solid var(--vscode-sideBar-border, transparent); }
    .context, .truncated { display: inline-block; max-width: 100%; margin: 5px 4px 0 0; padding: 2px 6px; border-radius: 10px; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); font-size: .8em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #activity { max-height: 245px; overflow-y: auto; }
    #proposals, #tools, #changes { padding: 0 8px; }
    .proposal, .change, .tool, .background-task { margin: 0 0 6px; border: 1px solid var(--vscode-sideBar-border, var(--vscode-input-border)); border-radius: 4px; }
    .proposal { padding: 7px; }
    .proposal-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .proposal-meta, .background-meta { color: var(--vscode-descriptionForeground); font-size: .8em; }
    .proposal-error { color: var(--vscode-errorForeground); font-size: .85em; overflow-wrap: anywhere; }
    .proposal-actions, .change-actions, .background-actions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
    .tool summary { padding: 5px 7px; cursor: pointer; color: var(--vscode-descriptionForeground); }
    .tool.running summary { color: var(--vscode-progressBar-background); }
    .tool.error summary { color: var(--vscode-errorForeground); }
    .tool pre, .background-output { max-height: 100px; overflow: auto; margin: 0; padding: 7px; border-top: 1px solid var(--vscode-sideBar-border, transparent); white-space: pre-wrap; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
    .change { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 5px; align-items: center; padding: 5px 7px; }
    .change-label, .background-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .background-task { margin-left: 8px; margin-right: 8px; padding: 7px; }
    .section-heading { display: flex; justify-content: space-between; align-items: center; margin: 5px 8px; color: var(--vscode-descriptionForeground); font-size: .78em; font-weight: 600; text-transform: uppercase; }
    #attachments { display: none; gap: 5px; flex-wrap: wrap; padding: 6px 8px 0; border-top: 1px solid var(--vscode-sideBar-border, transparent); }
    .attachment { display: inline-flex; max-width: 100%; align-items: center; gap: 4px; padding: 3px 4px 3px 7px; border-radius: 12px; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); font-size: .82em; }
    .attachment-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .attachment button { min-height: 18px; width: 18px; padding: 0; border-radius: 50%; color: inherit; background: transparent; }
    #composer { padding: 8px; }
    textarea { display: block; width: 100%; min-height: 76px; max-height: 220px; resize: vertical; padding: 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; font: inherit; }
    .composer-actions { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; gap: 5px; margin-top: 7px; align-items: center; }
    #composer-hint { min-width: 0; color: var(--vscode-descriptionForeground); font-size: .78em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #notice { min-height: 22px; padding: 0 8px 5px; color: var(--vscode-descriptionForeground); font-size: .85em; overflow-wrap: anywhere; }
    #notice.error { color: var(--vscode-errorForeground); }
    #notice.warning { color: var(--vscode-editorWarning-foreground); }
    @media (max-width: 340px) { .header { grid-template-columns: minmax(66px, 1fr) auto auto; } #model-picker { grid-column: 1 / -1; grid-row: 2; } .composer-actions { grid-template-columns: auto 1fr auto; } #composer-hint { display: none; } }
  </style>
</head>
<body>
  <main id="app">
    <header class="header" aria-label="Pi conversation controls">
      <select id="mode" aria-label="Pi mode" title="Choose how Pi may work"><option value="ask">Ask</option><option value="edit">Edit</option><option value="plan">Plan</option><option value="agent">Agent</option></select>
      <button id="model-picker" class="secondary" type="button" aria-label="Change Pi model">Model…</button>
      <button id="new-session" class="secondary" type="button" title="Start a new Pi conversation" aria-label="New Pi conversation">New</button>
      <button id="more" class="secondary" type="button" title="Session and advanced actions" aria-label="More Pi actions">More…</button>
    </header>
    <div id="runtime"><span id="status" role="status" aria-live="polite">Connecting…</span><span id="session"></span><span id="usage"></span><button id="retry" class="secondary" type="button" hidden>Retry</button><button id="refresh-history" class="secondary" type="button" hidden>Refresh history</button><button id="reconnect" class="secondary" type="button" hidden>Reconnect</button></div>
    <section id="messages" aria-live="off" aria-label="Pi conversation"></section>
    <section id="activity">
      <div id="proposals-heading" class="section-heading" hidden><span>Edit proposals</span></div><section id="proposals" aria-label="Pi edit proposals"></section>
      <section id="tools" aria-label="Pi tool activity"></section>
      <div id="changes-heading" class="section-heading" hidden><span>Pi changes</span><button id="source-control" class="secondary" type="button">Source Control</button></div><section id="changes" aria-label="Pi file changes"></section>
      <div id="background-heading" class="section-heading" hidden><span>Background agents</span></div><section id="background" aria-label="Background Pi agents"></section>
    </section>
    <div id="attachments" aria-label="Context attached to the next message"></div>
    <section id="composer">
      <label for="input" class="role">Message Pi</label>
      <textarea id="input" maxlength="${maxInputCharacters}" placeholder="Ask Pi…" aria-label="Message Pi"></textarea>
      <div class="composer-actions">
        <button id="add-context" class="secondary" type="button">Add context</button>
        <span id="composer-hint">Enter to send · Shift+Enter for newline</span>
        <button id="cancel" class="secondary" type="button" hidden>Cancel</button>
        <button id="send" type="button">Send</button>
      </div>
    </section>
    <div id="notice" role="status" aria-live="polite"></div>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const $ = id => document.getElementById(id);
    const messagesElement = $('messages');
    const toolsElement = $('tools');
    const proposalsElement = $('proposals');
    const changesElement = $('changes');
    const backgroundElement = $('background');
    const attachmentsElement = $('attachments');
    const input = $('input');
    const sendButton = $('send');
    const cancelButton = $('cancel');
    const notice = $('notice');
    const mode = $('mode');
    let busy = false;
    let connected = false;
    let imageSupported = true;
    let attachedImages = false;
    let pendingImageReads = 0;
    let submissionPending = false;
    let composerRevision = 0;
    let updatingControls = false;

    function submit() {
      const text = input.value.trim();
      if (!text || busy || !connected || pendingImageReads > 0 || submissionPending || (attachedImages && !imageSupported)) return;
      submissionPending = true;
      updateSendState();
      vscode.postMessage({ type: 'send', text });
      notice.textContent = '';
    }

    function renderMessages(messages) {
      const nearBottom = messagesElement.scrollHeight - messagesElement.scrollTop - messagesElement.clientHeight < 80;
      messagesElement.replaceChildren();
      if (messages.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.innerHTML = '<h2>What do you want to do?</h2><div>Start with code context or choose a working mode.</div>';
        const actions = document.createElement('div');
        actions.className = 'empty-actions';
        for (const item of [['selection', 'Ask about current selection'], ['plan', 'Plan a change'], ['agent', 'Start an agent task']]) {
          const button = document.createElement('button');
          button.className = 'secondary';
          button.type = 'button';
          button.dataset.emptyAction = item[0];
          button.textContent = item[1];
          actions.appendChild(button);
        }
        empty.appendChild(actions);
        messagesElement.appendChild(empty);
      } else {
        for (const message of messages) {
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
      if (nearBottom || busy) messagesElement.scrollTop = messagesElement.scrollHeight;
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
        meta.textContent = proposal.status === 'ready' ? 'Ready to preview' : proposal.status;
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
        for (const definition of [['preview', 'Preview'], ['apply', 'Apply'], ['reject', 'Reject']]) {
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
      toolsElement.replaceChildren();
      for (const tool of tools) {
        const details = document.createElement('details');
        details.className = 'tool ' + tool.status;
        const summary = document.createElement('summary');
        summary.textContent = (tool.status === 'running' ? 'Running · ' : tool.status === 'error' ? 'Failed · ' : 'Completed · ') + tool.name;
        const pre = document.createElement('pre');
        pre.textContent = tool.output || tool.input;
        details.append(summary, pre);
        toolsElement.appendChild(details);
      }
      if (tools.length && tools[tools.length - 1].status !== 'success') toolsElement.lastElementChild.open = true;
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
        output.textContent = task.error || task.output || '';
        const actions = document.createElement('div');
        actions.className = 'background-actions';
        const running = task.status === 'starting' || task.status === 'running';
        for (const definition of [['cancelBackground', 'Cancel', running], ['resumeBackground', 'Resume', Boolean(task.sessionFile) && !running], ['openWorktree', 'Open Worktree', Boolean(task.worktreePath)], ['cleanupWorktree', 'Remove Worktree', Boolean(task.worktreePath) && !running]]) {
          if (!definition[2]) continue;
          const button = document.createElement('button');
          button.className = 'secondary';
          button.type = 'button';
          button.textContent = definition[1];
          button.dataset.action = definition[0];
          button.dataset.id = task.id;
          actions.appendChild(button);
        }
        card.append(title, meta, output, actions);
        backgroundElement.appendChild(card);
      }
    }

    function renderAttachments(attachments) {
      attachmentsElement.replaceChildren();
      attachedImages = attachments.some(attachment => attachment.image);
      attachmentsElement.style.display = attachments.length ? 'flex' : 'none';
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

    function updateSendState() {
      const imageBlocked = attachedImages && !imageSupported;
      const imageLoading = pendingImageReads > 0;
      const interactionLocked = busy || submissionPending || imageLoading;
      mode.disabled = interactionLocked;
      $('model-picker').disabled = interactionLocked || !connected;
      $('new-session').disabled = interactionLocked;
      $('more').disabled = interactionLocked || !connected;
      $('add-context').disabled = interactionLocked;
      sendButton.disabled = interactionLocked || !connected || !input.value.trim() || imageBlocked;
      sendButton.title = imageLoading
        ? 'Wait for pasted images to finish loading.'
        : submissionPending
          ? 'Waiting for Pi to accept this message.'
          : imageBlocked
            ? 'The current model does not support image attachments.'
            : !connected ? 'Reconnect to Pi before sending.' : '';
      $('composer-hint').textContent = imageLoading
        ? 'Loading pasted image…'
        : imageBlocked ? 'Choose an image-capable model or remove images' : 'Enter to send · Shift+Enter for newline';
    }

    function render(state) {
      busy = Boolean(state.runtime.busy);
      connected = Boolean(state.runtime.connected);
      imageSupported = Boolean(state.imageSupported);
      renderMessages(state.messages || []);
      renderProposals(state.proposals || []);
      renderTools(state.tools || []);
      renderChanges(state.changes || []);
      renderBackground(state.backgroundTasks || []);
      renderAttachments(state.attachments || []);
      updatingControls = true;
      mode.value = state.runtime.mode;
      mode.disabled = busy;
      updatingControls = false;
      const currentModel = state.runtime.model || {};
      $('model-picker').textContent = currentModel.name || currentModel.id || 'Choose model…';
      $('model-picker').title = currentModel.provider && currentModel.id ? currentModel.provider + '/' + currentModel.id : 'Choose Pi model';
      $('model-picker').disabled = busy || !connected;
      $('new-session').disabled = busy;
      $('more').disabled = busy || !connected;
      $('status').textContent = state.status + (connected ? '' : ' · disconnected');
      $('session').textContent = state.runtime.sessionName || (state.runtime.sessionId ? 'Session ' + state.runtime.sessionId.slice(0, 8) : '');
      const context = (state.runtime.stats || {}).contextUsage || {};
      $('usage').textContent = typeof context.percent === 'number' ? Math.round(context.percent) + '% context' : '';
      $('reconnect').hidden = connected;
      $('retry').hidden = !state.retryAvailable;
      $('retry').disabled = busy || !connected;
      $('refresh-history').hidden = !state.historyRecoveryAvailable;
      $('refresh-history').disabled = busy || !connected;
      $('add-context').disabled = busy;
      cancelButton.hidden = !busy;
      sendButton.textContent = busy ? 'Working…' : 'Send';
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
      else if (message.type === 'setInput') {
        input.value = message.text;
        composerRevision += 1;
        updateSendState();
        input.focus();
      }
      else if (message.type === 'clearInput') {
        submissionPending = false;
        const revisionMatches = message.expectedRevision === undefined || composerRevision === message.expectedRevision;
        const textMatches = message.expectedText === undefined || input.value === message.expectedText;
        if (revisionMatches && textMatches) {
          input.value = '';
          composerRevision += 1;
          input.focus();
        }
        updateSendState();
      }
      else if (message.type === 'sendRejected') { submissionPending = false; updateSendState(); input.focus(); }
    });
    sendButton.addEventListener('click', submit);
    cancelButton.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
    $('reconnect').addEventListener('click', () => vscode.postMessage({ type: 'reconnect' }));
    $('retry').addEventListener('click', () => vscode.postMessage({ type: 'retry' }));
    $('refresh-history').addEventListener('click', () => vscode.postMessage({ type: 'refreshHistory' }));
    $('add-context').addEventListener('click', () => vscode.postMessage({ type: 'pickContext' }));
    $('model-picker').addEventListener('click', () => vscode.postMessage({ type: 'pickModel' }));
    $('new-session').addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));
    $('more').addEventListener('click', () => vscode.postMessage({ type: 'showMoreActions', text: input.value, revision: composerRevision }));
    $('source-control').addEventListener('click', () => vscode.postMessage({ type: 'openSourceControl' }));
    mode.addEventListener('change', () => { if (!updatingControls) vscode.postMessage({ type: 'setMode', mode: mode.value }); });
    input.addEventListener('input', () => { composerRevision += 1; updateSendState(); });
    input.addEventListener('paste', attachPastedImages);
    input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); } });
    messagesElement.addEventListener('click', event => {
      const button = event.target instanceof Element ? event.target.closest('button[data-empty-action]') : undefined;
      if (!button) return;
      if (button.dataset.emptyAction === 'selection') { vscode.postMessage({ type: 'attachSelection' }); input.focus(); }
      else vscode.postMessage({ type: 'setMode', mode: button.dataset.emptyAction });
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
