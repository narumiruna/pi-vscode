---
"narumi-pi": minor
---

BREAKING: Rename settings, commands, views, storage keys, and virtual document schemes from `picode` to `pi`. Remove the `piCodingAgent` settings fallback. Rename bridge and permission environment variables and prompt markers to `PI_VSCODE_*`, and rename bundled Pi resources.

Update settings, custom keybindings, and bridge consumers, then reload VS Code and create a new integrated terminal. Cached extension state does not migrate; persistent Pi session files are unchanged. Old transcript markers remain plain text. Exact legacy global bridge cleanup paths remain supported. The package name and extension ID are unchanged.
