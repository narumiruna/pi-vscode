# Rebuild and install the extension, then open the current directory in VS Code.
dev: install
    code --new-window "{{invocation_directory()}}"

# Launch Pi with the Pi bridge extension.
dev-pi:
    pi -ne -e "{{justfile_directory()}}/resources/picode-bridge.ts"

# Package and install the VS Code extension.
install-vsix:
    sh "{{justfile_directory()}}/scripts/check-legacy-vscode-extension.sh"
    npm run package
    code --install-extension "{{justfile_directory()}}/pi-coding-agent-vscode.vsix" --force

# Package and install the VS Code extension, then remove bridge files created by older releases.
install: install-vsix
    node "{{justfile_directory()}}/scripts/remove-legacy-picode-extension.mjs"
