export function conversationHistoryControlsHtml(): string {
  return `<section id="history-controls" aria-label="Conversation search and history" hidden>
    <p id="history-status" role="status" aria-live="polite" hidden></p>
    <div id="history-search-bar" hidden role="search" aria-label="Find conversation text">
      <p id="history-scope">Search current text window only; includes code and diagram source. Excludes thinking, tool details and images.</p>
      <label for="history-search-input">Find literal text (case-sensitive)</label>
      <input id="history-search-input" type="search" maxlength="256" autocomplete="off" aria-describedby="history-scope" />
      <span id="history-search-count" role="status" aria-live="polite"></span>
      <div class="history-actions"><button id="history-search-prev" type="button" class="secondary">Previous</button>
      <button id="history-search-next" type="button" class="secondary">Next</button>
      <button id="history-search-close" type="button" class="secondary">Close search</button></div>
    </div></section>`;
}

export function conversationHistoryStyles(): string {
  return `
    #history-controls { flex: 0 0 auto; min-width: 0; padding: 6px 12px; border-bottom: 1px solid var(--pi-border); }
    .history-actions { display: flex; flex-wrap: wrap; gap: 4px; }
    #history-scope, #history-status { margin: 4px 0; font-size: 11px; color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
    #history-search-bar label, #history-search-count { display: block; font-size: 11px; }
    #history-search-input { width: 100%; min-width: 0; box-sizing: border-box; margin: 4px 0; }
    ::highlight(pi-conversation-matches) { background: var(--vscode-editor-findMatchHighlightBackground, #785c00); color: var(--vscode-editor-foreground); }
    ::highlight(pi-conversation-selected) { background: var(--vscode-editor-findMatchBackground, #996500); color: var(--vscode-editor-foreground); }
  `;
}

// The generated script shares the sidebar nonce. It never changes rendered source nodes.
export function conversationHistoryScript(): string {
  return `
    const conversationHistory = (() => {
      const el = id => document.getElementById(id);
      const bar = el('history-search-bar'), field = el('history-search-input'), count = el('history-search-count');
      const trigger = el('history-search-open'), earlier = el('history-earlier'), latestButton = el('history-latest');
      const controls = el('history-controls'), status = el('history-status');
      bar.hidden = status.hidden = controls.hidden = true;
      const root = el('messages'), scroller = el('conversation');
      let state = {}, matches = [], selected = -1, session, windowKey, lastContent, lastRoot, followOnLatest = false;
      let hooks = { pauseFollowing() {}, followLatest() {} };
      const highlights = Boolean(globalThis.CSS?.highlights && globalThis.Highlight);
      const clear = () => { if (highlights) { CSS.highlights.delete('pi-conversation-matches'); CSS.highlights.delete('pi-conversation-selected'); } };
      const paint = () => {
        clear();
        if (highlights && matches.length) {
          CSS.highlights.set('pi-conversation-matches', new Highlight(...matches.map(match => match.range)));
          if (selected >= 0) CSS.highlights.set('pi-conversation-selected', new Highlight(matches[selected].range));
        }
        const query = field.value.slice(0, 256);
        const label = !query ? 'Enter text to search this window.' : !matches.length ? 'No matches in this window.'
          : (selected + 1) + ' of ' + matches.length + (matches.length === 1000 ? '+ (match limit)' : '') + ' in this window'
            + (highlights ? '' : ' (highlighting unavailable)');
        if (count.textContent !== label) count.textContent = label;
        el('history-search-prev').disabled = el('history-search-next').disabled = !matches.length;
      };
      const rebuild = () => {
        const old = matches[selected];
        matches = [];
        const query = field.value.slice(0, 256);
        if (bar.hidden || !query) { selected = -1; paint(); return; }
        let budget = 250000;
        for (const article of root.children) {
          const content = article.querySelector('.content');
          if (!content || budget <= 0 || matches.length >= 1000) continue;
          const nodes = [], walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
              return node.parentElement?.closest('svg, style, script, button, annotation, [aria-hidden="true"], [hidden]')
                ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
            }
          });
          let node, text = '';
          while ((node = walker.nextNode()) && budget > 0) {
            const part = node.data.slice(0, budget);
            nodes.push({ node, start: text.length, end: text.length + part.length });
            text += part; budget -= part.length;
          }
          let offset = text.indexOf(query);
          let nodeIndex = 0;
          while (offset >= 0 && matches.length < 1000) {
            while (nodes[nodeIndex].end <= offset) nodeIndex += 1;
            let endIndex = nodeIndex;
            while (nodes[endIndex].end < offset + query.length) endIndex += 1;
            const range = document.createRange();
            range.setStart(nodes[nodeIndex].node, offset - nodes[nodeIndex].start);
            range.setEnd(nodes[endIndex].node, offset + query.length - nodes[endIndex].start);
            matches.push({ key: String(article.messageId) + ':' + offset, range });
            offset = text.indexOf(query, offset + query.length);
          }
        }
        const retained = old ? matches.findIndex(match => match.key === old.key) : -1;
        selected = retained >= 0 ? retained : matches.length ? Math.min(Math.max(selected, 0), matches.length - 1) : -1;
        paint();
      };
      const navigate = delta => {
        if (!matches.length) return;
        selected = (selected + delta + matches.length) % matches.length;
        hooks.pauseFollowing(); paint();
        const rect = matches[selected].range.getBoundingClientRect(), viewport = scroller.getBoundingClientRect();
        scroller.scrollTop += rect.top - viewport.top - viewport.height / 2;
      };
      const syncSurface = () => { controls.hidden = bar.hidden && status.hidden; };
      const canNavigate = () => Boolean(state.history?.canNavigate && state.history.available && !state.history.loading
        && state.runtime?.connected && !state.runtime.busy);
      const close = () => {
        bar.hidden = true; trigger.setAttribute('aria-expanded', 'false'); syncSurface();
        matches = []; selected = -1; clear(); trigger.focus();
      };
      const latest = () => {
        if (!canNavigate() || state.history.mode !== 'earlier') return false;
        followOnLatest = true;
        vscode.postMessage({ type: 'historyWindow', direction: 'latest', generation: state.history.generation });
        return true;
      };
      const open = () => {
        bar.hidden = false; trigger.setAttribute('aria-expanded', 'true'); syncSurface();
        rebuild(); field.focus(); field.select();
      };
      trigger.addEventListener('click', () => bar.hidden ? open() : close());
      el('history-search-close').addEventListener('click', close);
      el('history-search-prev').addEventListener('click', () => navigate(-1));
      el('history-search-next').addEventListener('click', () => navigate(1));
      field.addEventListener('input', () => { matches = []; selected = -1; rebuild(); });
      bar.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
        else if (event.key === 'Enter' && event.target === field) { event.preventDefault(); navigate(event.shiftKey ? -1 : 1); }
      });
      earlier.addEventListener('click', () => {
        if (!canNavigate() || !state.history.omittedBefore) return;
        hooks.pauseFollowing(); followOnLatest = false;
        vscode.postMessage({ type: 'historyWindow', direction: 'earlier', generation: state.history.generation });
      });
      latestButton.addEventListener('click', latest);
      window.addEventListener('pagehide', () => { matches = []; clear(); });
      return {
        bind(callbacks) { hooks = { ...hooks, ...callbacks }; }, open, latest,
        isEarlier() { return state.history?.mode === 'earlier'; },
        beforeRender(next) {
          const nextSession = JSON.stringify([next.runtime?.sessionFile, next.runtime?.sessionId]);
          if (session !== undefined && nextSession !== session) {
            field.value = ''; matches = []; selected = -1; clear(); followOnLatest = false; lastContent = undefined;
          }
          session = nextSession;
          if (next.history?.mode === 'earlier') hooks.pauseFollowing();
        },
        onState(next) {
          state = next;
          const history = next.history;
          earlier.disabled = !canNavigate() || !history?.omittedBefore;
          latestButton.disabled = !canNavigate() || history?.mode !== 'earlier';
          const feedback = [];
          if (history?.loading) feedback.push('Loading history…');
          else if (!history?.available) feedback.push('Full history unavailable; current text remains searchable.');
          if (history?.available && history.mode === 'earlier') feedback.push('Earlier window: ' + (next.messages?.length || 0)
            + ' of ' + history.total + ' messages. ' + history.omittedBefore + ' earlier; ' + history.omittedAfter + ' later.');
          if (history?.truncated) feedback.push('Text is truncated; omitted portions of long messages cannot be browsed.');
          const label = feedback.join(' ');
          if (status.textContent !== label) status.textContent = label;
          status.hidden = !label;
          syncSurface();
          const nextWindowKey = JSON.stringify([session, history?.mode, history?.start, history?.end]);
          const changedWindow = nextWindowKey !== windowKey;
          if (changedWindow && !history?.loading) { matches = []; selected = -1; windowKey = nextWindowKey; }
          const content = (next.messages || []).slice(-100).map(message => [message.id, message.html]);
          const changedContent = !lastContent || content.length !== lastContent.length
            || content.some((item, index) => item[0] !== lastContent[index][0] || item[1] !== lastContent[index][1]);
          const changedDom = lastRoot !== root.firstElementChild;
          lastContent = content; lastRoot = root.firstElementChild;
          if (!bar.hidden && (changedContent || changedWindow || changedDom)) rebuild();
          if (followOnLatest && history?.mode === 'latest' && history.available && !history.loading) {
            followOnLatest = false; hooks.followLatest();
          }
          if (!history?.loading && !history?.available) followOnLatest = false;
        }
      };
    })();
  `;
}
