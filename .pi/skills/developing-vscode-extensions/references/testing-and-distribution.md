# Testing and Distribution

Use this guide when adding tests, changing runtime assets or bundling, creating a VSIX, or preparing Marketplace publication.

## Test at the Correct Layers

- Unit-test deterministic parsing, prompts, state transitions, and business logic without loading VS Code when possible.
- Use Extension Host integration tests for activation, registrations, VS Code APIs, commands, and UI-dependent behavior.
- Isolate integration runs from unrelated installed extensions when reproducibility matters.
- Command-line Extension Host tests cannot use a VS Code installation that already has another running instance, so development and test versions may need to differ.
- Test both trusted and untrusted runs when declaring Workspace Trust behavior.
- Workspace Trust cannot be granted or revoked programmatically inside one extension test run, so trusted and untrusted behavior require separate launches.
- Test browser behavior with the web extension runner when a `browser` entry exists.
- Exercise remote or virtual workspaces when a change touches file access, processes, localhost, storage, URI handling, or extension placement.
- Test against the minimum supported VS Code version when using APIs newer than existing project code.
- Record manual Extension Development Host checks separately from automated assertions.

## Build and Inspect the Package

- Run packaging after build and tests when runtime files, bundling, manifest fields, or distribution contents change.
- Use `vscode:prepublish` to produce required runtime artifacts before packaging.
- Exclude source and development-only files with `.vscodeignore`, while retaining every runtime asset and declaration needed by the extension.
- Development dependencies are excluded from VSIX packaging automatically, but runtime dependencies and generated artifacts still need explicit inspection.
- Inspect the generated VSIX contents instead of assuming ignore and bundling rules worked.
- Install the VSIX in the intended local, remote, or web-capable environment before claiming packaged behavior works there.

## Prepare Marketplace Metadata

- Keep the Marketplace README, license, changelog, icon, support information, and compatibility claims aligned with the package.
- Ensure README and changelog image URLs use HTTPS.
- Marketplace tooling rejects extension icons and most user-provided README or changelog SVG images even when those assets render correctly elsewhere.
- Keep the declared minimum VS Code version aligned with APIs and contribution points actually used by the package.
- Review platform-specific native artifacts when publishing separate target packages.

## Respect Release Boundaries

- Treat `vsce package` as a local artifact operation.
- Treat `vsce publish`, unpublish, deprecate, publisher changes, credential creation, and CI secret configuration as external writes requiring explicit approval.
- Do not publish a package that enables proposed APIs to the Marketplace.
- A proposed-API package can be shared as a VSIX only when recipients use VS Code Insiders and explicitly enable the proposal for that extension.
- Report the exact artifact inspected, checks run, target environments exercised, and any unverified compatibility claims.
