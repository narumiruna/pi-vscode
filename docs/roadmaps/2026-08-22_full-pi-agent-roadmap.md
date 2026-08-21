# Full Pi Agent Experience Roadmap

## Vision

Provide a Pi-native VS Code experience with the interactive editing, completion, chat, autonomous-agent, session-management, and extensibility outcomes users expect from Codex, GitHub Copilot, GitHub Copilot Chat, and Claude Code.

## Objectives

- **Fast pair programming** — Success: users can receive cancellable inline completions and perform focused inline edits without leaving the editor.
- **Full agent loop** — Success: Pi streams reasoning-visible status, text, and tool activity while it explores, edits, runs commands, and self-corrects in the workspace.
- **Controlled changes** — Success: users can choose ask, edit, plan, or agent behavior, inspect changed files, and cancel or undo work.
- **Durable sessions** — Success: users can create, name, resume, fork, compact, and monitor multiple Pi sessions from VS Code.
- **Pi ecosystem compatibility** — Success: existing Pi authentication, models, settings, AGENTS.md files, skills, prompt templates, extensions, and supported external tools work without separate credentials.

## Current State

- [x] A packaged `0.3.0` extension provides a dedicated Activity Bar conversation view, native `@pi` participant, selected-code ask/modify actions, bounded local chat history, configurable Pi executable/model overrides, and Husky verification.
- [x] Version `0.4.0` replaces sidebar one-shot calls with a persistent streaming Pi RPC runtime, explicit Ask/Edit/Plan/Agent tool profiles, tool activity, model/thinking controls, and session new/name/resume/compact/terminal actions.
- [x] Version `0.5.0` adds manual/opt-in automatic inline ghost-text completions, focused editor actions with diff preview and explicit apply, and bounded selection/file/diagnostics context attachments.
- [x] Version `0.6.0` adds bounded edit/write checkpoints with diff/open/stale-safe revert actions, explicit Plan-to-Agent handoff, concurrent background agents, and optional detached Git worktree isolation.
- [x] Version `0.7.0` exposes Pi commands/prompts/skills, project trust, text/image/terminal context, HTML export, and terminal/background/worktree handoffs.
- Cloud-hosted delegation and cross-machine synchronization still require a separately configured external execution service.
- Pi RPC mode provides persistent sessions, streaming events, model control, compaction, session switching/forking, tool activity, and extension UI requests.

## Roadmap

### Phase 1: Persistent streaming Pi runtime

- [x] The sidebar runs a persistent Pi RPC session with token streaming, tool activity, cancellation, Ask/Edit/Plan/Agent modes, model and thinking controls, and recoverable process lifecycle behavior; verified by 23 tests and a real Pi streaming smoke test.
- [x] Pi sessions can be created, named, resumed, compacted, restored, and opened in a terminal from the conversation UI; verified in packaged `0.4.0`.

**Outcome:** VS Code becomes a complete front end for the Pi agent loop rather than a one-shot prompt wrapper.

### Phase 2: Editor-native assistance

- [x] Users can invoke focused editor assistance for explain, fix, review, document, test, and free-form edits with diff preview, explicit accept/reject, stale-version protection, and undo behavior.
- [x] Cancellable, debounced, cached inline code completions provide ghost-text suggestions with language and bounded nearby-code context; verified by unit tests and a real Pi completion smoke test.
- [x] Diagnostics, current file, selected code, and explicit file references can be added to Pi requests with per-item, total-size, and item-count bounds.

**Outcome:** Pi supports Copilot-style flow inside the editor for both proactive suggestions and focused changes.

### Phase 3: Controlled autonomous coding

- [x] Ask, Edit, Plan, and Agent modes have explicit tested tool policies, visible UI status, modal Agent confirmation, and Plan-to-Agent handoff.
- [x] Agent activity exposes streamed file tools, command/tool status and results, errors, completion status, checkpointed file changes, diff review, and stale-safe revert support.
- [x] Multiple local/background sessions run through independent Pi RPC clients and can be cancelled, resumed, or opened in isolated detached Git worktrees; verified by concurrent-client and real-worktree smoke tests.

**Outcome:** Pi can complete multi-file tasks while users retain visibility and control comparable to modern coding-agent extensions.

### Phase 4: Customization and handoff

- [x] Pi skills, prompt templates, extension commands, project instructions, trust behavior, and model choices are discoverable or selectable in the UI and documented.
- [x] Bounded image/file/selection/diagnostics/terminal context and Pi-extension-provided external-service tools are available through the conversation composer.
- [x] Sessions can be exported, opened in a terminal, resumed from background tasks, or handed off to local/background/worktree execution without losing Pi session or explicit attachment context.

**Outcome:** The extension exposes Pi's customization ecosystem and supports workflows analogous to Claude Code, Codex, and Copilot harness switching.

### Phase 5: Product hardening and parity audit

- [ ] Automated unit, subprocess, VS Code-host, and packaged-extension tests cover runtime framing, recovery, editor edits, completions, sessions, and security boundaries.
- [ ] A checked feature matrix maps every advertised reference-extension capability to an implemented Pi workflow or documented external dependency, with no unresolved required gaps.
- [ ] Installation, onboarding, privacy, permissions, troubleshooting, and upgrade documentation are verified from a clean VS Code profile.

**Outcome:** The extension is installable, auditable, and demonstrably satisfies the requested reference feature set end to end.

## Guiding Principles

- Use Pi's own authentication, model registry, sessions, instructions, extensions, skills, and tools instead of duplicating provider infrastructure.
- Keep source text and prompts off command-line arguments.
- Default to visible, cancellable behavior and make autonomous tool access an explicit mode choice.
- Use stable VS Code APIs for marketplace builds and isolate optional proposed-API integrations.
- Bound persisted state, subprocess output, context attachments, and completion frequency.

## Risks and Dependencies

- Cloud-agent delegation requires a configured external execution target; local/background and worktree sessions remain available without one.
- Inline completions through general coding models can have higher latency and cost than dedicated completion services; debounce, cancellation, caching, and opt-in settings mitigate this.
- Pi tools execute with the extension host user's permissions; explicit Agent mode, workspace trust, activity visibility, and revert workflows mitigate accidental changes.
- Proposed VS Code agent-session APIs cannot be required for marketplace compatibility; the dedicated Pi UI remains the stable fallback.
