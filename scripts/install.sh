#!/bin/sh

set -eu

repository="narumiruna/pi-vscode"
asset="pi-coding-agent-vscode.vsix"
version="${1:-latest}"

if ! command -v curl >/dev/null 2>&1; then
  echo "Error: curl is required." >&2
  exit 1
fi

if ! command -v code >/dev/null 2>&1; then
  echo "Error: the VS Code 'code' command is required." >&2
  exit 1
fi

if [ "${version}" = "latest" ]; then
  download_url="https://github.com/${repository}/releases/latest/download/${asset}"
else
  if ! printf '%s\n' "${version}" | grep -Eq '^v?[0-9]+\.[0-9]+\.[0-9]+$'; then
    echo "Error: version must be 'latest' or a stable SemVer such as 0.0.2." >&2
    exit 1
  fi
  version="${version#v}"
  download_url="https://github.com/${repository}/releases/download/v${version}/${asset}"
fi

temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/pi-vscode.XXXXXX")"
vsix_path="${temporary_directory}/${asset}"
cleanup() {
  rm -rf "${temporary_directory}"
}
trap cleanup 0 1 2 3 15

printf 'Downloading %s...\n' "${download_url}"
curl --fail --location --silent --show-error --retry 3 --output "${vsix_path}" "${download_url}"

printf 'Installing %s...\n' "${asset}"
code --install-extension "${vsix_path}" --force

printf 'Pi for VS Code installed. Run "Developer: Reload Window" in VS Code to finish.\n'
