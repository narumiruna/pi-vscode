---
name: developing-vscode-extensions
description: Build, modify, debug, test, package, or publish Visual Studio Code extensions using official platform guidance. Use for extension manifests, activation, commands, views, webviews, language or debugger support, AI chat participants, language model tools, MCP integration, Extension Host behavior, Workspace Trust, virtual workspaces, remote or web compatibility, UX, and Marketplace preparation.
---

# Developing VS Code Extensions

Use verified VS Code platform behavior instead of guessing how an extension mechanism works.

## Workflow

1. Inspect the request, repository instructions, `package.json`, extension entry points, tests, build scripts, and existing contribution patterns.
2. Record the minimum VS Code version, supported extension hosts, workspace types, trust behavior, and user-visible surface affected by the change.
3. Apply [the architecture and compatibility guide](references/extension-architecture.md) when changing the manifest, activation, API version, Extension Host placement, remote behavior, web support, virtual workspaces, or Workspace Trust.
4. Apply [the user experience and security guide](references/user-experience-and-security.md) when changing commands, menus, views, notifications, settings, status, webviews, credentials, or telemetry.
5. Apply [the testing and distribution guide](references/testing-and-distribution.md) when adding tests, changing runtime assets or bundling, creating a VSIX, or preparing Marketplace publication.
6. For chat participants, language models, agent tools, or MCP, also apply [the AI extensibility guide](references/ai-extensibility.md).
7. Verify uncertain behavior against the official VS Code API documentation, installed `vscode` type declarations, `engines.vscode`, and relevant release notes.
8. Keep contribution identifiers, activation behavior, runtime registrations, context keys, settings, menus, and disposal behavior consistent.
9. Implement the smallest complete change and add focused tests at the lowest layer that can prove it.
10. Run the documented compile, lint, unit, Extension Host, web, remote, packaging, or publishing checks that apply.
11. Report changed behavior, evidence consulted, checks run, and any compatibility or manual-test gaps.

## Limits

- Prefer stable APIs, native VS Code UI, lazy activation, and existing repository patterns.
- Do not enable proposed APIs unless the request or an existing project requirement explicitly calls for them.
- Do not silently raise `engines.vscode`, change extension host placement, weaken trust handling, or reduce remote, web, or virtual-workspace compatibility.
- Do not publish an extension, create credentials, or perform another external write without explicit approval.
- Do not claim Extension Host, remote, web, trust, virtual-workspace, AI-model, or Marketplace behavior was verified unless the corresponding check actually ran.
