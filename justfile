# Rebuild and install the extensions, then open the current directory in VS Code.
dev: install
    code --new-window "{{invocation_directory()}}"

# Launch Pi with the Pi bridge extension.
dev-pi:
    pi -ne -e "{{justfile_directory()}}/resources/picode-bridge.ts"

# Package and install the VS Code extension.
install-vsix:
    npm run package
    code --install-extension "{{justfile_directory()}}/pi-coding-agent-vscode.vsix" --force

# Package and install the Pi extensions for VS Code and Pi.
install: install-picode-extension
    npm run package
    code --install-extension "{{justfile_directory()}}/pi-coding-agent-vscode.vsix" --force

# Install the standalone Pi bridge extension globally.
install-picode-extension:
    node "{{justfile_directory()}}/scripts/install-picode-extension.mjs"
