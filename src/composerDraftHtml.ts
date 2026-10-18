// Inline script uses the sidebar's existing nonce. Text never enters HTML or webview state.
export function composerDraftHtml(): string {
  return `
    composerDraft = (() => {
      const panel = document.createElement('details'); panel.id = 'text-draft-recovery';
      const summary = document.createElement('summary'); summary.textContent = 'Text draft recovery';
      const status = document.createElement('p'); status.id = 'text-draft-status'; status.setAttribute('role', 'status');
      const actions = document.createElement('div'); actions.className = 'proposal-actions';
      const button = (id, label) => { const item = document.createElement('button'); item.id = id; item.type = 'button'; item.className = 'secondary'; item.textContent = label; actions.append(item); return item; };
      const enable = button('enable-text-drafts', 'Enable recovery');
      const restore = button('restore-text-draft', 'Restore text');
      const discard = button('discard-text-draft', 'Discard retained text');
      const disable = button('disable-text-drafts', 'Disable and discard all');
      const body = document.createElement('div'); body.id = 'text-draft-body'; body.append(status, actions);
      panel.append(summary, body); $('conversation-details').insertBefore(panel, $('session-details'));
      const notice = document.createElement('button'); notice.id = 'text-draft-notice'; notice.type = 'button';
      notice.className = 'secondary'; notice.textContent = 'Retained text available · Review'; notice.hidden = true;
      notice.setAttribute('aria-haspopup', 'dialog'); $('composer').append(notice);
      notice.addEventListener('click', () => { panel.open = true; showConversationDetails(); });
      let binding, enabled = false, available = false, writable = false, timer, composing = false;
      let observed = -1, sent = -1, lastScope = 'sessions', pendingSend;
      let moving = false, ownershipBlocked = false;
      const renderDraft = () => {
        notice.hidden = !available || moving;
        enable.hidden = enabled; enable.disabled = !binding || !writable;
        disable.hidden = !enabled; restore.hidden = discard.hidden = !available;
        restore.disabled = Boolean(input.value || composing || moving || ownershipBlocked || submissionPending || recoveredDraftPending || input.readOnly);
        discard.disabled = composing;
        const text = moving ? 'Waiting for the draft context. Text is not saved or sent.'
          : ownershipBlocked ? 'Text was kept after a session change. Verify the current session, then clear the composer before using recovery or Send.'
          : available
          ? 'Retained text is available. Restore needs an empty composer. Attachments are not restored. New text is not saved until you restore or discard the retained text.'
          : !enabled ? 'Off. Enable only for non-secret text. Review the storage notice first.'
          : !writable ? 'This session has no verified draft identity. Text is not saved.'
          : input.value.length > 50000 ? 'Text exceeds 50,000 characters and is not saved. The last saved text can be older.'
          : 'Text only; attachments are not saved. Recovery never sends a request. Recent edits can be lost before storage completes.';
        if (status.textContent !== text) status.textContent = text;
      };
      const flush = () => {
        if (timer) clearTimeout(timer); timer = undefined;
        if (!binding || !enabled || !writable || composing || moving || ownershipBlocked || sent === composerRevision) return;
        sent = composerRevision;
        vscode.postMessage(input.value.length <= 50000
          ? { type: 'draftChanged', binding, revision: composerRevision, text: input.value }
          : { type: 'draftOversized', binding, revision: composerRevision });
      };
      const changed = () => {
        if (ownershipBlocked && !input.value && !composing) ownershipBlocked = false;
        renderDraft();
        if (observed === composerRevision) return;
        observed = composerRevision;
        if (timer) clearTimeout(timer);
        if (!composing) timer = setTimeout(flush, 250);
      };
      const handoff = () => {
        pendingSend = undefined;
        flush(); if (!binding) return;
        moving = true; renderDraft();
      };
      const sendHandoff = () => {
        handoff();
        if (binding) pendingSend = { binding, revision: composerRevision, text: input.value, awaitingSessionScope: true };
      };
      const select = scope => {
        if (scope === lastScope) return;
        // Session creation changes the navigation scope before its accepted clear arrives.
        const origin = pendingSend?.awaitingSessionScope && lastScope === 'sessions' && scope === 'session' ? pendingSend : undefined;
        handoff();
        if (origin) { origin.awaitingSessionScope = false; pendingSend = origin; }
        lastScope = scope;
        vscode.postMessage({ type: 'draftSelect', scope });
      };
      const matches = (value, revision, text) => {
        if (pendingSend && value === pendingSend.binding && revision === pendingSend.revision && text === pendingSend.text) {
          pendingSend = undefined;
          // Local commands can accept without a new session or another draftState reply.
          // Rearm retention if newer input's debounce expired while the handoff blocked writes.
          if (value === binding) { moving = false; observed = -1; }
          return true;
        }
        return !value || value === binding;
      };
      const receive = message => {
        if (message.type === 'draftState') {
          if (typeof message.binding !== 'string') return;
          const changedBinding = binding && binding !== message.binding;
          if (changedBinding && pendingSend) {
            if (pendingSend.destination) pendingSend = undefined;
            else pendingSend.destination = message.binding;
          }
          if (timer) clearTimeout(timer); timer = undefined;
          if (changedBinding && message.reset !== false) {
            fileCompletion?.cancel();
            // No persistence acknowledgement exists. Even an unchanged flushed draft can be unsaved.
            if (input.value) {
              ownershipBlocked = true;
              showNotice('Text was kept after the session changed. Verify the session, then clear the composer before sending.', 'warning');
            }
            moving = false;
          } else if (moving && !changedBinding) {
            moving = false;
          }
          const wasEnabled = enabled;
          binding = message.binding; enabled = message.enabled === true;
          available = message.available === true; writable = message.writable === true;
          observed = -1;
          if (changedBinding || !wasEnabled && enabled || !available) sent = -1;
          renderDraft(); changed(); updateSendState();
        } else if (['sessionSwitchRejected', 'newSessionRejected', 'sendRejected'].includes(message.type)) {
          moving = false; pendingSend = undefined; observed = -1; changed();
        } else if (message.type === 'draftRestored' && message.binding === binding) {
          if (message.expectedRevision !== composerRevision || input.value || composing || moving || ownershipBlocked || submissionPending || recoveredDraftPending || input.readOnly || typeof message.text !== 'string' || message.text.length > 50000) {
            showNotice('Your composer changed. Retained text was not inserted.', 'warning'); return;
          }
          fileCompletion?.cancel(); input.value = message.text; composerRevision += 1;
          resizeInput(); updateSendState(); changed(); flush(); closeConversationDetails(true); input.focus();
        }
      };
      enable.addEventListener('click', () => { if (binding) vscode.postMessage({ type: 'draftEnable', binding }); });
      disable.addEventListener('click', () => { if (binding) vscode.postMessage({ type: 'draftDisable', binding }); });
      restore.addEventListener('click', () => { if (binding && !restore.disabled) vscode.postMessage({ type: 'draftRestore', binding, revision: composerRevision }); });
      discard.addEventListener('click', () => { if (binding) { vscode.postMessage({ type: 'draftDiscard', binding, revision: composerRevision }); composerRevision += 1; observed = -1; sent = -1; changed(); } });
      input.addEventListener('compositionstart', () => { composing = true; if (timer) clearTimeout(timer); renderDraft(); });
      input.addEventListener('compositionend', () => { composing = false; observed = -1; changed(); });
      document.addEventListener('click', flush, true);
      input.addEventListener('keydown', flush, true);
      window.addEventListener('pagehide', flush);
      renderDraft();
      return { changed, flush, receive, select, handoff, sendHandoff, matches, blocked: () => moving || ownershipBlocked };
    })();
  `;
}
