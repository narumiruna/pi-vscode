# Extension Architecture and Compatibility

Use this guide when changing the manifest, activation, API version, Extension Host placement, remote behavior, web support, virtual workspaces, or Workspace Trust.

## Define the Compatibility Contract

- Treat `engines.vscode` as the minimum API contract rather than a descriptive version label.
- Record whether the extension must run in desktop, remote, Codespaces, or browser configurations before choosing APIs or dependencies.
- Record whether the extension supports trusted, untrusted, file-backed, and virtual workspaces.
- Check `main`, `browser`, and `extensionKind` together because they determine available runtimes and preferred execution location.
- Keep declarative-only extensions free of executable entry points when runtime code is unnecessary.
- Verify newly used APIs against installed `vscode` declarations, the minimum engine, and the release in which the API became stable.

## Align Manifest, Activation, and Runtime Code

- Model each feature as a static contribution, activation condition, and runtime registration when all three are required.
- Keep every command, view, custom editor, chat participant, tool, setting, and menu identifier identical across the manifest and code.
- Use the narrowest activation behavior that makes the feature available when needed, and avoid `*` when multiple specific events suffice.
- A contributed command activates an extension without an explicit `onCommand` event only when the minimum supported VS Code version is 1.74 or newer.
- Register returned `Disposable` objects in `ExtensionContext.subscriptions` unless another owner disposes them deterministically.
- Use `deactivate` only for shutdown cleanup that subscriptions do not cover, and return its promise when cleanup is asynchronous.
- Keep activation fast and defer expensive initialization until the feature is actually used.

## Select the Extension Host Deliberately

- A `main` entry runs in a Node.js local or remote Extension Host, while a `browser` entry runs in a browser Web Worker.
- `extensionKind` expresses a preferred or required location, but available hosts, entry points, installation location, and workspace configuration still participate in placement.
- When both `main` and `browser` exist, VS Code normally selects a Node.js Extension Host when one is available rather than automatically preferring the browser build.
- A web-only extension always runs in the web Extension Host, so adding `extensionKind` usually does not improve its placement.
- Use `extensionKind: ["workspace"]` when the extension must run where workspace contents or processes live.
- Use a UI preference only when the extension needs local devices, assets, low latency, or other client-side capabilities.
- UI and Workspace describe execution location rather than which extension may contribute UI, because Workspace Extensions can still add views and other interface elements.
- Use **Developer: Show Running Extensions** to verify actual placement when remote behavior is uncertain.
- Do not import Electron internals or rely on undocumented VS Code modules because remote hosts use standard Node.js.
- Treat native dependencies as platform-specific artifacts that need explicit runtime, architecture, and libc coverage.

## Handle Remote Resources and Communication

- Persist key-value state with `workspaceState` or `globalState` and file data with `storageUri` or `globalStorageUri`.
- `ExtensionContext.secrets` keeps secrets on the client side and remains the correct storage API even when extension code runs remotely.
- `vscode.env.clipboard` always targets the user's local clipboard even when called by a remote Workspace Extension.
- `vscode.env.openExternal` opens the user's local application and automatically forwards localhost HTTP or HTTPS addresses from remote environments.
- `vscode.env.asExternalUri` may return a non-localhost address, so preserve the complete returned URI instead of rebuilding it.
- An API returned from `activate` is visible only to extensions in the same Extension Host, while VS Code commands can be routed across hosts.
- Cross-host command arguments are serialized to plain JSON data, so prototypes, functions, cyclic references, and object identity do not survive.
- Installing an unpublished VSIX for remote testing must be done in the window connected to that remote environment, not merely in the local VS Code window.

## Support Web and Virtual Workspaces

- A declarative extension can be web-enabled without a `browser` entry when it has no `main` entry and does not contribute localizations, debuggers, terminals, or TypeScript server plugins.
- A browser extension has access to the VS Code API but runs in a Web Worker without Node.js module loading or child processes.
- Browser extension code must be bundled into one loadable file even when the source is split across modules.
- Use `vscode.workspace.fs` and URI operations because workspace, extension, and storage resources can all use non-`file` schemes.
- Use `URI.fsPath` or Node's `fs` only after proving that the URI scheme is `file`.
- Keep shared logic runtime-neutral and isolate Node-specific and browser-specific implementations behind small adapters.
- Use `virtualWorkspace`, `resourceScheme`, and `shellExecutionSupported` context keys to hide unsupported actions.
- Most extensions default to virtual-workspace support unless they declare otherwise or VS Code applies a compatibility override.
- Declare `capabilities.virtualWorkspaces` as `true`, `false`, or limited with an explanation that matches actual behavior.

## Enforce Workspace Trust

- Review any workspace file, dependency, configuration, task, executable, or command-line argument that can influence code execution.
- A declarative extension with no `main` entry generally does not need Workspace Trust because it executes no workspace code.
- An executable extension that omits `capabilities.untrustedWorkspaces` is treated conservatively as unsupported and remains disabled in Restricted Mode.
- Declare full, limited, or unsupported behavior deliberately instead of relying on default disablement.
- Put vulnerable setting identifiers in `restrictedConfigurations` so untrusted workspace values are not exposed.
- Restricted configuration entries make VS Code return the user-level value instead of the untrusted workspace value and emit configuration change after trust is granted.
- Gate dangerous runtime paths with `workspace.isTrusted` and react to `onDidGrantWorkspaceTrust` when delayed registration is needed.
- Debugger extensions and task providers can normally declare untrusted-workspace support because VS Code itself blocks debugging and task execution in Restricted Mode.
- Extra commands or settings outside the built-in debug or task flow still require their own limited-support and trust analysis.
- Localize the manifest explanation that tells users why trust is required.

## Handle Proposed APIs

- Proposed APIs are available only in VS Code Insiders and can change without compatibility guarantees.
- Proposed declaration files must match the normal `vscode.d.ts` version, so the newest proposal can be incompatible with older `@types/vscode`.
- Enable only the named proposals required by local development and keep proposed declarations separate from stable API assumptions.
