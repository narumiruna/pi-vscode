# Compile and launch the VS Code extension.
dev:
    npm run compile
    code --new-window --disable-extension=narumitw.pi-coding-agent --disable-extension=narumi.pi-coding-agent --extensionDevelopmentPath="{{justfile_directory()}}" "{{invocation_directory()}}"

# Launch Pi with the bridge extension.
dev-pi:
    pi -ne -e "{{justfile_directory()}}/resources/pi-vscode-bridge.ts"

# Package and install the Pi and VS Code extensions.
install: install-pi-extension
    npm run package
    code --install-extension "{{justfile_directory()}}/pi-agent.vsix" --force

# Install the standalone Pi extension globally.
install-pi-extension:
    node "{{justfile_directory()}}/scripts/install-pi-extension.mjs"
