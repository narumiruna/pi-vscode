# User Experience, Webviews, and Privacy

Use this guide when adding commands, menus, views, notifications, settings, status, webviews, credentials, or telemetry.

## Choose the Correct UI Surface

- Prefer commands, Quick Picks, notifications, progress, tree views, settings, and native editors before creating custom web content.
- Put workspace-wide status on the left side of the Status Bar and active-resource status on the right.
- Use context menus for actions tied to a specific object and the Command Palette for generally discoverable commands.
- Use `when` clauses to control visibility or enablement, and use namespaced custom context keys only when built-in keys cannot express the state.
- Inspect runtime context values with **Developer: Inspect Context Keys** instead of guessing them.
- Treat hidden UI as presentation only because a command remains callable by identifier.
- Follow existing VS Code naming, icon, placement, keyboard, and progress patterns instead of creating a parallel interaction model.

## Account for Webview Placement

- A webview runs on the user's UI side even when the extension code that owns it runs in a remote Workspace Extension Host.
- `localhost` inside a remote extension's webview refers to the user's UI machine, not the remote machine where the extension started its server.
- Prefer webview message passing because it works across local, remote, and Codespaces configurations without exposing a server port.
- Webview `portMapping` can work in desktop remote scenarios but does not support the Codespaces browser editor.
- Use `webview.asWebviewUri` for portable local-resource loading because it is not merely a cosmetic URI conversion.

## Secure Webviews

- Use a webview only when native VS Code surfaces cannot provide the required experience.
- Enable only required capabilities, and leave scripts disabled when they are unnecessary.
- Restrict `localResourceRoots` to the smallest required set.
- Start the Content Security Policy with `default-src 'none'` and selectively allow required sources through `webview.cspSource` and HTTPS.
- Keep scripts and styles in external files instead of weakening the Content Security Policy for inline content.
- Sanitize file contents, paths, settings, and all other workspace or user-controlled HTML input.
- Validate every message and argument received from the webview before performing an extension-side action.
- Treat Content Security Policy and sanitization as independent defenses because neither replaces the other.
- Do not use webviews for promotions, update notices, wizards, or functionality already provided by native VS Code UI.

## Manage Webview Lifecycle and Accessibility

- `getState` and `setState` survive a webview becoming hidden but do not survive destruction of the webview panel.
- Restoring a panel after VS Code restarts requires a `WebviewPanelSerializer` in addition to persisted webview state.
- `retainContextWhenHidden` keeps scripts running and consumes substantially more memory, so it is not a default persistence mechanism.
- Honor VS Code theme tokens, keyboard navigation, ARIA labels, screen-reader state, and reduced-motion preferences.
- Open webviews only in the active window and only in response to contextually appropriate user behavior.

## Protect Credentials and Telemetry

- Store extension credentials only with `ExtensionContext.secrets`.
- Collect the minimum telemetry necessary and document what is collected.
- Respect `vscode.env.isTelemetryEnabled` and `onDidChangeTelemetryEnabled` even when the extension also has its own telemetry setting.
- A custom telemetry setting cannot override the user's global decision, and no telemetry may be sent when `vscode.env.isTelemetryEnabled` is false.
- Reading `telemetry.telemetryLevel` is not equivalent to using `vscode.env.isTelemetryEnabled` because the setting can report an incorrect effective state.
- Tag extension telemetry settings with `telemetry` and `usesOnlineServices`.
- Never collect personally identifiable information or bypass the user's VS Code telemetry choice.
- Use `telemetry.json` when the extension needs to expose its event inventory through the VS Code CLI.
