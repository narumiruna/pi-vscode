#!/bin/sh

set -eu

command -v grep >/dev/null
installed_extensions="$(code --list-extensions)"
if printf '%s\n' "${installed_extensions}" | grep -Fxiq 'narumi.pi-coding-agent-vscode'; then
  echo 'Error: the old Pi extension narumi.pi-coding-agent-vscode is installed.' >&2
  echo 'Save sessions and worktree results before removing it. See README.md: Upgrade from the old extension ID.' >&2
  echo 'Run: code --uninstall-extension narumi.pi-coding-agent-vscode' >&2
  echo 'Then run Developer: Reload Window and retry this installer.' >&2
  exit 1
fi
