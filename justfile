# Compile the extension and open a new Extension Development Host window.
dev:
    npm run compile
    code --new-window --extensionDevelopmentPath="{{justfile_directory()}}" "{{invocation_directory()}}"

# Package and install the Pi and VS Code extensions.
install: install-pi-extension
    npm run package
    code --install-extension "{{justfile_directory()}}/pi-coding-agent.vsix" --force

# Install the standalone Pi extension globally.
install-pi-extension:
    node "{{justfile_directory()}}/scripts/install-pi-extension.mjs"
