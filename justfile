# Compile and launch the VS Code extension.
dev:
    npm run compile
    code --new-window --extensionDevelopmentPath="{{justfile_directory()}}" "{{invocation_directory()}}"

# Launch Pi with the PiCode bridge extension.
dev-pi:
    pi -ne -e "{{justfile_directory()}}/resources/picode-bridge.ts"

# Package and install the PiCode extensions for VS Code and Pi.
install: install-picode-extension
    npm run package
    code --install-extension "{{justfile_directory()}}/pi-coding-agent-vscode.vsix" --force

# Install the standalone PiCode bridge extension globally.
install-picode-extension:
    node "{{justfile_directory()}}/scripts/install-picode-extension.mjs"
