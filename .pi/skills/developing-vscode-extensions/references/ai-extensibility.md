# VS Code AI Extensibility Guide

Use this guide when implementing chat participants, Language Model API features, language model tools, or MCP integration.

## Choose the Smallest Extension Point

| Goal | Prefer | Key tradeoff |
| --- | --- | --- |
| Let agent mode invoke a VS Code-aware capability automatically | Language model tool | Runs in the Extension Host and can use VS Code APIs. |
| Reuse a tool across VS Code and other MCP clients | MCP server | Runs outside VS Code and cannot use VS Code Extension APIs. |
| Own a specialized end-to-end chat interaction | Chat participant | Controls request handling and response streaming but adds another user-visible assistant. |
| Add AI to an editor action, code action, hover, or custom view | Language Model API | Gives direct model control outside the chat participant experience. |
| Provide inline code suggestions | Inline Completion API | Fits the native completion surface without requiring chat. |

Do not create a chat participant when a tool, smart action, or existing editor surface provides a smaller and more composable integration.

## Build Language Model Tools

- Define the tool in `contributes.languageModelTools` and register the same name with `vscode.lm.registerTool` when public invocation is required.
- Use a unique `{verb}_{noun}` tool name and noun-based parameter names that expose intent rather than implementation details.
- Write `modelDescription` for model selection by stating what the tool does, what it returns, when it should and should not run, and its limits.
- Give every input property a precise JSON Schema description and mark only truly mandatory fields as required.
- Restrict tool availability with a `when` clause when the capability only makes sense in a specific editor, language, debug, trust, or workspace state.
- VS Code always presents a generic confirmation for extension tools, so use `prepareInvocation` to add concrete target and effect details when they help the user decide.
- Treat schema validation as structural validation and still validate semantic ranges, resource ownership, trust, and authorization in `invoke`.
- Honor the cancellation token before and during expensive work.
- Return concise model-readable results without unrelated UI prose.
- Throw errors that explain the failure and, when useful, tell the model whether changed parameters or another action can recover.

## Build Chat Participants

- Keep the manifest participant ID identical to the ID passed to `vscode.chat.createChatParticipant`.
- Prefix the globally unique ID with the extension name, use a short lowercase mention name, and use title case for the user-facing full name.
- Keep descriptions and slash-command names short, specific, and easy to discover.
- Prefer one participant per extension so the Chat UI does not become crowded.
- Use the model on `ChatRequest` so the extension respects the model selected by the user.
- Use request location, command, variables, and history only when they materially change the response.
- Stream progress and results, and prefer native response parts such as references, buttons, trees, and Markdown over custom UI.
- Make follow-ups actionable questions or directions rather than labels with no context.
- Ask explicit consent before costly work or edits and deletions that cannot be undone.
- Keep non-chat extension functionality usable without a hard Copilot dependency when graceful optional behavior is possible.

## Use the Language Model API Defensively

- Build prompts with user and assistant messages because the Language Model API does not provide a system-message role.
- Call `selectChatModels` from a user-initiated action because model access can require user consent.
- Handle an empty model selection without indexing into the result.
- Avoid hard-coding one model as permanently available, and select by the broadest capability that satisfies the feature.
- Respect each model's `maxInputTokens` and bound workspace context, history, tool output, and attachments before sending.
- Pass cancellation tokens through model requests and stop downstream work after cancellation.
- Handle consent denial, unavailable models, quota limits, request errors, and streaming errors separately from parsing failures.
- Separate prompt construction, response parsing, and side effects so deterministic logic can be unit-tested without a live model.
- Do not use live Language Model API calls in routine integration tests because responses are nondeterministic and requests are rate limited.
- Treat model output as untrusted input before applying edits, executing commands, opening URIs, or rendering content.

## Decide Between Extension Tools and MCP

- Choose an extension language model tool when the operation requires editor state, VS Code APIs, or Marketplace delivery as part of the extension.
- Choose MCP when the capability should run outside VS Code, support other clients, or deploy as an independent local or remote service.
- Do not assume an MCP server can read VS Code state unless the extension explicitly supplies that context through a designed boundary.
- Keep authentication, transport, deployment, and user setup explicit when registering or installing MCP servers.
- Apply the same clear descriptions, bounded inputs, confirmation, trust checks, and model-readable errors to both mechanisms.

## Privacy, Safety, and Release

- Follow the extension's telemetry contract and the user's VS Code telemetry choice before recording prompts, feedback, model choices, or tool use.
- Never place secrets, full source files, or unrelated workspace content in prompts or telemetry without a necessary disclosed purpose.
- Review Microsoft AI practices and applicable Copilot extensibility policy before Marketplace publishing.
- Verify the required AI APIs against installed `vscode` declarations and `engines.vscode` because AI surfaces evolve quickly.
- Report which paths were tested with deterministic doubles and which still require a live model, agent mode, or user-consent smoke test.
