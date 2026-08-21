import { randomBytes } from "node:crypto";

export function getSidebarHtml(maxInputCharacters: number): string {
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
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); font-weight: var(--vscode-font-weight, normal); line-height: 1.45; }
    #app { height: 100vh; display: grid; grid-template-rows: auto auto 1fr auto auto auto auto; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 8px; border-bottom: 1px solid var(--vscode-sideBar-border, transparent); }
    button, select { min-height: 26px; border: 1px solid transparent; border-radius: 2px; padding: 3px 7px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; font: inherit; }
    select { max-width: 150px; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border-color: var(--vscode-dropdown-border, transparent); }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-foreground); background: transparent; border-color: var(--vscode-button-secondaryBackground); }
    button:disabled, select:disabled { cursor: default; opacity: .55; }
    #runtime { display: flex; gap: 8px; padding: 4px 9px; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-sideBar-border, transparent); font-size: .82em; overflow: hidden; }
    #runtime span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #messages { overflow-y: auto; padding: 10px; }
    .empty { margin: 16vh 18px 0; text-align: center; color: var(--vscode-descriptionForeground); }
    .message { margin: 0 0 12px; }
    .role { margin-bottom: 3px; color: var(--vscode-descriptionForeground); font-size: .8em; font-weight: 600; text-transform: uppercase; }
    .content { padding: 8px 10px; border-radius: 6px; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
    .user .content { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
    .assistant .content { background: var(--vscode-editor-background); border: 1px solid var(--vscode-sideBar-border, transparent); }
    .context { display: inline-block; max-width: 100%; margin-top: 5px; padding: 2px 6px; border-radius: 10px; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); font-size: .8em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #activity { max-height: 230px; overflow-y: auto; }
    #tools, #changes { padding: 0 8px; }
    .tool { margin: 0 0 5px; border: 1px solid var(--vscode-sideBar-border, var(--vscode-input-border)); border-radius: 4px; }
    .tool summary { padding: 4px 7px; cursor: pointer; color: var(--vscode-descriptionForeground); }
    .tool.running summary { color: var(--vscode-progressBar-background); }
    .tool.error summary { color: var(--vscode-errorForeground); }
    .tool pre { max-height: 120px; overflow: auto; margin: 0; padding: 7px; border-top: 1px solid var(--vscode-sideBar-border, transparent); white-space: pre-wrap; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
    .change { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 5px; align-items: center; margin: 0 0 5px; padding: 5px 7px; border: 1px solid var(--vscode-sideBar-border, var(--vscode-input-border)); border-radius: 4px; }
    .change-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .change-actions { display: flex; flex-wrap: wrap; gap: 3px; }
    .background-task { margin: 0 8px 6px; padding: 6px 8px; border: 1px solid var(--vscode-sideBar-border, var(--vscode-input-border)); border-radius: 4px; }
    .background-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .background-meta { color: var(--vscode-descriptionForeground); font-size: .8em; }
    .background-output { max-height: 80px; overflow: auto; margin: 5px 0; white-space: pre-wrap; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
    .background-actions { display: flex; flex-wrap: wrap; gap: 3px; }
    .section-heading { display: flex; justify-content: space-between; align-items: center; margin: 5px 8px; color: var(--vscode-descriptionForeground); font-size: .8em; font-weight: 600; text-transform: uppercase; }
    #attachments { display: none; margin: 0 8px 6px; padding: 5px 8px; border-radius: 3px; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #composer { padding: 8px; border-top: 1px solid var(--vscode-sideBar-border, transparent); }
    textarea { display: block; width: 100%; min-height: 72px; max-height: 220px; resize: vertical; padding: 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; font: inherit; }
    textarea:focus { border-color: var(--vscode-focusBorder); outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .actions { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px; margin-top: 7px; }
    .context-actions, .right-actions { display: flex; flex-wrap: wrap; gap: 4px; }
    #notice { min-height: 20px; padding: 0 8px 5px; color: var(--vscode-descriptionForeground); font-size: .85em; }
    #notice.error { color: var(--vscode-errorForeground); }
    #notice.warning { color: var(--vscode-editorWarning-foreground); }
  </style>
</head>
<body>
  <main id="app">
    <div class="toolbar">
      <select id="mode" aria-label="Pi mode" title="Pi mode">
        <option value="ask">Ask</option><option value="edit">Edit</option><option value="plan">Plan</option><option value="agent">Agent</option>
      </select>
      <select id="model" aria-label="Pi model" title="Pi model"></select>
      <select id="thinking" aria-label="Thinking level" title="Thinking level"></select>
      <button id="new-session" class="secondary" type="button" title="Start a new Pi session">New</button>
      <button id="resume-session" class="secondary" type="button" title="Resume a Pi session">Resume</button>
      <button id="name-session" class="secondary" type="button" title="Name this Pi session">Name</button>
      <button id="compact" class="secondary" type="button" title="Compact Pi context">Compact</button>
      <button id="commands" class="secondary" type="button" title="Insert a Pi command, prompt template, or skill">Commands…</button>
      <button id="export" class="secondary" type="button" title="Export this Pi session to HTML">Export</button>
      <button id="terminal" class="secondary" type="button" title="Open this Pi session in a terminal">Terminal</button>
      <button id="handoff-agent" type="button" title="Continue this Plan session in Agent mode" hidden>Implement Plan</button>
    </div>
    <div id="runtime"><span id="status">Connecting…</span><span id="session"></span><span id="usage"></span></div>
    <section id="messages" aria-live="polite"><div class="empty">Ask Pi about your workspace, or switch to Agent mode for autonomous coding.</div></section>
    <section id="activity">
      <section id="tools" aria-label="Pi tool activity"></section>
      <div id="changes-heading" class="section-heading" hidden><span>Pi changes</span><button id="source-control" class="secondary" type="button">Source Control</button></div>
      <section id="changes" aria-label="Pi file changes"></section>
      <div id="background-heading" class="section-heading" hidden><span>Background agents</span></div>
      <section id="background" aria-label="Background Pi agents"></section>
    </section>
    <div id="attachments" title="Attached to the next message"></div>
    <section id="composer">
      <label for="input" class="role">Message Pi</label>
      <textarea id="input" maxlength="${maxInputCharacters}" placeholder="Ask Pi…" aria-label="Message Pi"></textarea>
      <div class="actions">
        <div class="context-actions">
          <button id="attach" class="secondary" type="button" title="Attach the current editor selection">Selection</button>
          <button id="attach-current" class="secondary" type="button" title="Attach the current file">Current file</button>
          <button id="attach-file" class="secondary" type="button" title="Choose files to attach">Files…</button>
          <button id="attach-diagnostics" class="secondary" type="button" title="Attach current-file diagnostics">Problems</button>
          <button id="attach-image" class="secondary" type="button" title="Attach images">Images…</button>
          <button id="attach-terminal" class="secondary" type="button" title="Attach selected terminal output">Terminal text</button>
          <button id="clear-context" class="secondary" type="button" title="Clear attached context">Clear context</button>
        </div>
        <div class="right-actions">
          <button id="background-run" class="secondary" type="button" title="Run as an independent background agent">Background</button>
          <button id="worktree-run" class="secondary" type="button" title="Run in an isolated detached Git worktree">Worktree</button>
          <button id="cancel" class="secondary" type="button" hidden>Cancel</button>
          <button id="send" type="button">Send</button>
        </div>
      </div>
    </section>
    <div id="notice" role="status" aria-live="polite"></div>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const $ = id => document.getElementById(id);
    const messagesElement = $('messages');
    const toolsElement = $('tools');
    const changesElement = $('changes');
    const backgroundElement = $('background');
    const input = $('input');
    const send = $('send');
    const cancel = $('cancel');
    const attach = $('attach');
    const attachments = $('attachments');
    const notice = $('notice');
    const mode = $('mode');
    const model = $('model');
    const thinking = $('thinking');
    let busy = false;
    let updatingControls = false;

    function submit() {
      const text = input.value.trim();
      if (!text || busy) return;
      vscode.postMessage({ type: 'send', text });
      input.value = '';
      notice.textContent = '';
    }

    function option(select, value, label) {
      const item = document.createElement('option');
      item.value = value;
      item.textContent = label;
      select.appendChild(item);
    }

    function renderControls(runtime) {
      updatingControls = true;
      mode.value = runtime.mode;
      model.replaceChildren();
      const currentProvider = runtime.model && runtime.model.provider;
      const currentId = runtime.model && runtime.model.id;
      for (const candidate of runtime.availableModels || []) {
        if (!candidate.provider || !candidate.id) continue;
        option(model, JSON.stringify([candidate.provider, candidate.id]), candidate.name || (candidate.provider + '/' + candidate.id));
      }
      const currentModelValue = JSON.stringify([currentProvider, currentId]);
      if (![...model.options].some(item => item.value === currentModelValue) && currentId) {
        option(model, currentModelValue, currentProvider + '/' + currentId);
      }
      model.value = currentModelValue;
      thinking.replaceChildren();
      for (const level of runtime.availableThinkingLevels || ['off']) option(thinking, level, level);
      if (runtime.thinkingLevel && ![...thinking.options].some(item => item.value === runtime.thinkingLevel)) {
        option(thinking, runtime.thinkingLevel, runtime.thinkingLevel);
      }
      thinking.value = runtime.thinkingLevel || 'off';
      mode.disabled = busy;
      $('handoff-agent').hidden = runtime.mode !== 'plan';
      $('handoff-agent').disabled = busy;
      model.disabled = busy || !runtime.connected;
      thinking.disabled = busy || !runtime.connected;
      updatingControls = false;
    }

    function renderMessages(messages) {
      const nearBottom = messagesElement.scrollHeight - messagesElement.scrollTop - messagesElement.clientHeight < 80;
      messagesElement.replaceChildren();
      if (messages.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'Ask Pi about your workspace, or switch to Agent mode for autonomous coding.';
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
          content.textContent = message.content || (message.role === 'assistant' ? '…' : '');
          wrapper.append(role, content);
          if (message.contextLabel) {
            const context = document.createElement('div');
            context.className = 'context';
            context.textContent = message.contextLabel;
            context.title = message.contextLabel;
            wrapper.appendChild(context);
          }
          messagesElement.appendChild(wrapper);
        }
      }
      if (nearBottom || busy) messagesElement.scrollTop = messagesElement.scrollHeight;
    }

    function renderTools(tools) {
      toolsElement.replaceChildren();
      for (const tool of tools) {
        const details = document.createElement('details');
        details.className = 'tool ' + tool.status;
        const summary = document.createElement('summary');
        summary.textContent = (tool.status === 'running' ? '● ' : tool.status === 'error' ? '× ' : '✓ ') + tool.name;
        const pre = document.createElement('pre');
        pre.textContent = tool.output || tool.input;
        details.append(summary, pre);
        toolsElement.appendChild(details);
      }
      if (tools.length) toolsElement.lastElementChild.open = true;
    }

    function submitBackground(isolated) {
      const text = input.value.trim();
      if (!text) return;
      vscode.postMessage({ type: 'runBackground', text, isolated });
      input.value = '';
      notice.textContent = '';
    }

    function renderChanges(changes) {
      changesElement.replaceChildren();
      $('changes-heading').hidden = changes.length === 0;
      for (const change of changes) {
        const row = document.createElement('div');
        row.className = 'change';
        const label = document.createElement('span');
        label.className = 'change-label';
        label.textContent = (change.created ? '+ ' : change.deleted ? '− ' : 'M ') + change.label;
        label.title = change.label;
        const actions = document.createElement('span');
        actions.className = 'change-actions';
        for (const [action, title] of [['openChange', 'Open'], ['reviewChange', 'Diff'], ['revertChange', 'Revert']]) {
          const button = document.createElement('button');
          button.className = 'secondary';
          button.type = 'button';
          button.textContent = title;
          button.dataset.action = action;
          button.dataset.id = change.id;
          button.disabled = action === 'reviewChange' ? !change.canPreview : action === 'revertChange' ? !change.canRevert : change.deleted;
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
        const definitions = [
          ['cancelBackground', 'Cancel', running],
          ['resumeBackground', 'Resume', Boolean(task.sessionFile) && !running],
          ['openWorktree', 'Open Worktree', Boolean(task.worktreePath)],
          ['cleanupWorktree', 'Remove Worktree', Boolean(task.worktreePath) && !running],
        ];
        for (const [action, label, visible] of definitions) {
          if (!visible) continue;
          const button = document.createElement('button');
          button.className = 'secondary';
          button.type = 'button';
          button.textContent = label;
          button.dataset.action = action;
          button.dataset.id = task.id;
          actions.appendChild(button);
        }
        card.append(title, meta, output, actions);
        backgroundElement.appendChild(card);
      }
    }

    function render(state) {
      busy = Boolean(state.runtime.busy);
      renderMessages(state.messages || []);
      renderTools(state.tools || []);
      renderChanges(state.changes || []);
      renderBackground(state.backgroundTasks || []);
      renderControls(state.runtime);
      $('status').textContent = state.status + (state.runtime.connected ? '' : ' · disconnected');
      $('session').textContent = state.runtime.sessionName || (state.runtime.sessionId ? 'Session ' + state.runtime.sessionId.slice(0, 8) : '');
      const stats = state.runtime.stats || {};
      const context = stats.contextUsage || {};
      $('usage').textContent = typeof context.percent === 'number' ? Math.round(context.percent) + '% context' : '';
      send.disabled = busy || !state.runtime.connected;
      for (const id of ['attach', 'attach-current', 'attach-file', 'attach-diagnostics', 'attach-image', 'attach-terminal', 'clear-context']) $(id).disabled = busy;
      cancel.hidden = !busy;
      send.textContent = busy ? 'Working…' : 'Send';
      for (const id of ['new-session', 'resume-session', 'compact']) $(id).disabled = busy;
      if (state.attachments && state.attachments.length) {
        attachments.style.display = 'block';
        attachments.textContent = 'Attached: ' + state.attachments.map(item => item.label).join(' · ');
      } else {
        attachments.style.display = 'none';
        attachments.textContent = '';
      }
    }

    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'state') render(message);
      if (message.type === 'notice') {
        notice.textContent = message.message;
        notice.className = message.level;
      }
      if (message.type === 'setInput') {
        input.value = message.text;
        input.focus();
      }
    });
    send.addEventListener('click', submit);
    $('background-run').addEventListener('click', () => submitBackground(false));
    $('worktree-run').addEventListener('click', () => submitBackground(true));
    cancel.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
    attach.addEventListener('click', () => vscode.postMessage({ type: 'attachSelection' }));
    $('attach-current').addEventListener('click', () => vscode.postMessage({ type: 'attachCurrentFile' }));
    $('attach-file').addEventListener('click', () => vscode.postMessage({ type: 'attachFile' }));
    $('attach-diagnostics').addEventListener('click', () => vscode.postMessage({ type: 'attachDiagnostics' }));
    $('attach-image').addEventListener('click', () => vscode.postMessage({ type: 'attachImage' }));
    $('attach-terminal').addEventListener('click', () => vscode.postMessage({ type: 'attachTerminal' }));
    $('clear-context').addEventListener('click', () => vscode.postMessage({ type: 'clearAttachments' }));
    $('new-session').addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));
    $('resume-session').addEventListener('click', () => vscode.postMessage({ type: 'resumeSession' }));
    $('name-session').addEventListener('click', () => vscode.postMessage({ type: 'nameSession' }));
    $('compact').addEventListener('click', () => vscode.postMessage({ type: 'compact' }));
    $('commands').addEventListener('click', () => vscode.postMessage({ type: 'pickCommand' }));
    $('export').addEventListener('click', () => vscode.postMessage({ type: 'exportSession' }));
    $('terminal').addEventListener('click', () => vscode.postMessage({ type: 'openTerminal' }));
    $('handoff-agent').addEventListener('click', () => vscode.postMessage({ type: 'handoffAgent' }));
    $('source-control').addEventListener('click', () => vscode.postMessage({ type: 'openSourceControl' }));
    for (const container of [changesElement, backgroundElement]) {
      container.addEventListener('click', event => {
        const target = event.target;
        const button = target instanceof Element ? target.closest('button[data-action]') : undefined;
        if (button) vscode.postMessage({ type: button.dataset.action, id: button.dataset.id });
      });
    }
    mode.addEventListener('change', () => { if (!updatingControls) vscode.postMessage({ type: 'setMode', mode: mode.value }); });
    model.addEventListener('change', () => {
      if (updatingControls || !model.value) return;
      const [provider, modelId] = JSON.parse(model.value);
      vscode.postMessage({ type: 'setModel', provider, modelId });
    });
    thinking.addEventListener('change', () => { if (!updatingControls) vscode.postMessage({ type: 'setThinking', level: thinking.value }); });
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        submit();
      }
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}
