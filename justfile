# Compile the extension and open a new Extension Development Host window.
dev:
    npm run compile
    code --new-window --extensionDevelopmentPath="{{justfile_directory()}}" "{{invocation_directory()}}"
