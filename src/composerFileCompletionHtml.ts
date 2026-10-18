import { composerFileToken } from "./composerFileToken";

// Inline script shares the existing nonce and CSP. All file labels use textContent.
export function composerFileCompletionHtml(): string {
  return `
    const parseFileToken = ${composerFileToken.toString()};
    fileCompletion = (() => {
      const menu = $('file-completions');
      let sequence = 0, current, timer, composing = false, index = 0, session;
      let candidates = [], pending = false;
      const sameDraft = () => current && composerRevision === current.revision && input.value === current.text
        && input.selectionStart === current.token.cursor && input.selectionEnd === current.token.cursor;
      const hide = () => {
        menu.hidden = true;
        if (slashMenu.hidden) { input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); }
      };
      const cancel = () => {
        if (timer) clearTimeout(timer);
        timer = undefined;
        const hadQuery = Boolean(current);
        current = undefined; candidates = []; pending = false; input.readOnly = false; hide();
        if (hadQuery) vscode.postMessage({ type: 'fileCompletionCancel' });
      };
      const renderMenu = () => {
        menu.replaceChildren();
        if (!sameDraft() || pending || !candidates.length) { hide(); return; }
        candidates.forEach((candidate, rowIndex) => {
          const row = document.createElement('button');
          row.type = 'button'; row.tabIndex = -1; row.id = 'file-completion-' + rowIndex;
          row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(index === rowIndex));
          row.textContent = candidate.path;
          row.title = (current.token.kind === 'attachment' ? 'Attach snapshot: ' : 'Insert path only: ') + candidate.path;
          row.addEventListener('mousedown', event => event.preventDefault());
          row.addEventListener('click', () => select(rowIndex));
          menu.appendChild(row);
        });
        menu.setAttribute('aria-label', current.token.kind === 'attachment' ? 'Files to attach as snapshots' : 'Paths to insert without attaching');
        menu.hidden = false;
        input.setAttribute('aria-expanded', 'true'); input.setAttribute('aria-activedescendant', 'file-completion-' + index);
      };
      const search = () => {
        cancel();
        if (composing || input.disabled || submissionPending || recoveredDraftPending || document.activeElement !== input) return;
        const token = parseFileToken(input.value, input.selectionStart, input.selectionEnd, composing);
        if (!token) return;
        timer = setTimeout(() => {
          timer = undefined;
          if (composing || document.activeElement !== input) return;
          current = { type: 'fileCompletionQuery', id: ++sequence, revision: composerRevision, text: input.value, token };
          index = 0;
          vscode.postMessage(current);
        }, 120);
      };
      const select = rowIndex => {
        const candidate = candidates[rowIndex];
        if (pending || !candidate || !sameDraft()) return;
        pending = true; input.readOnly = true; hide(); updateSendState();
        vscode.postMessage({ type: 'fileCompletionSelect', id: current.id, revision: current.revision, candidateId: candidate.id });
      };
      const receive = message => {
        if (message.type === 'state') {
          const next = JSON.stringify([message.runtime?.sessionId, message.runtime?.sessionFile]);
          if (session !== undefined && session !== next) cancel();
          session = next;
          return;
        }
        if (!message.type.startsWith('fileCompletion') || !current || message.id !== current.id || message.revision !== current.revision) return;
        if (!sameDraft()) { cancel(); updateSendState(); return; }
        if (message.type === 'fileCompletionResults') {
          if (pending || JSON.stringify(message.token) !== JSON.stringify(current.token)) return;
          candidates = Array.isArray(message.candidates) ? message.candidates.slice(0, 30).filter(item =>
            item && typeof item.id === 'string' && /^[a-f0-9-]{36}$/.test(item.id) && typeof item.path === 'string' && item.path.length <= 1024) : [];
          renderMenu();
        } else if (message.type === 'fileCompletionApplied' && pending && typeof message.replacement === 'string'
            && JSON.stringify(message.token) === JSON.stringify(current.token)) {
          const token = current.token;
          const replacement = message.replacement;
          input.value = input.value.slice(0, token.start) + replacement + input.value.slice(token.end);
          input.setSelectionRange(token.start + replacement.length, token.start + replacement.length);
          composerRevision += 1; cancel(); resizeInput(); updateSendState(); input.focus();
        } else if (message.type === 'fileCompletionFailed') {
          cancel(); updateSendState();
          showNotice('File completion could not be captured. Your token and attachments were kept. Search again or use Attach.', 'warning');
        }
      };
      input.addEventListener('mousedown', event => { if (pending) event.preventDefault(); });
      input.addEventListener('input', search);
      input.addEventListener('click', () => { if (!pending) search(); });
      input.addEventListener('keyup', event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) search(); });
      input.addEventListener('select', () => { if (current && !sameDraft()) search(); });
      input.addEventListener('blur', () => { if (!pending) cancel(); });
      input.addEventListener('compositionstart', () => { composing = true; cancel(); });
      input.addEventListener('compositionend', () => { composing = false; search(); });
      window.addEventListener('pagehide', cancel);
      return {
        cancel, receive, refresh: renderMenu, get busy() { return pending; },
        keydown(event) {
          if (pending) { event.preventDefault(); return true; }
          if (event.isComposing || composing || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false;
          if (event.key === 'Escape' && current) { event.preventDefault(); if (!pending) { cancel(); updateSendState(); } return true; }
          if (pending && ['Enter', 'Tab'].includes(event.key)) { event.preventDefault(); return true; }
          if (menu.hidden || !candidates.length || !sameDraft()) return false;
          if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
            event.preventDefault(); index = (index + (event.key === 'ArrowDown' ? 1 : -1) + candidates.length) % candidates.length;
            renderMenu(); menu.children[index]?.scrollIntoView?.({ block: 'nearest' }); return true;
          }
          if (event.key === 'Tab' || (event.key === 'Enter' && current.token.kind === 'attachment')) {
            event.preventDefault(); select(index); return true;
          }
          return false;
        }
      };
    })();
`;
}
