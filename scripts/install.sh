#!/bin/sh

set -eu

repository="narumiruna/pi-vscode"
asset="pi-coding-agent-vscode.vsix"

if [ "$#" -gt 1 ]; then
  echo "Error: expected at most one version argument." >&2
  exit 1
fi

version="latest"
if [ "$#" -eq 1 ]; then
  version="$1"
fi

is_stable_version() {
  candidate="${1#v}"
  case "${candidate}" in
    ''|*[!0-9.]*|.*|*.|*..*) return 1 ;;
  esac

  previous_ifs="${IFS}"
  IFS=.
  set -- ${candidate}
  IFS="${previous_ifs}"
  [ "$#" -eq 3 ] || return 1

  for identifier do
    case "${identifier}" in
      0|[1-9]*) ;;
      *) return 1 ;;
    esac
  done
}

if [ "${version}" = "latest" ]; then
  download_url="https://github.com/${repository}/releases/latest/download/${asset}"
elif is_stable_version "${version}"; then
  version="${version#v}"
  download_url="https://github.com/${repository}/releases/download/v${version}/${asset}"
else
  echo "Error: version must be 'latest' or a stable SemVer such as 0.0.2." >&2
  exit 1
fi

for required_command in curl code mktemp mkdir unzip cp rm; do
  if ! command -v "${required_command}" >/dev/null 2>&1; then
    echo "Error: required command not found: ${required_command}" >&2
    exit 1
  fi
done

temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/pi-vscode.XXXXXX")"
vsix_path="${temporary_directory}/${asset}"
bridge_source="${temporary_directory}/picode-bridge.ts"
cleanup() {
  rm -rf "${temporary_directory}"
}
trap cleanup 0
trap 'exit 1' HUP INT QUIT TERM

printf 'Downloading %s...\n' "${download_url}"
curl --fail --location --silent --show-error --retry 3 --output "${vsix_path}" "${download_url}"
unzip -p "${vsix_path}" extension/resources/picode-bridge.ts > "${bridge_source}"
if [ ! -s "${bridge_source}" ]; then
  echo "Error: the VSIX does not contain the Pi bridge extension." >&2
  exit 1
fi

printf 'Installing %s...\n' "${asset}"
code --install-extension "${vsix_path}" --force

agent_directory="${PI_CODING_AGENT_DIR:-${HOME:?Error: HOME or PI_CODING_AGENT_DIR is required.}/.pi/agent}"
extensions_directory="${agent_directory}/extensions"
mkdir -p "${extensions_directory}"
cp "${bridge_source}" "${extensions_directory}/picode.ts"
rm -f "${extensions_directory}/pi-vscode.ts"

printf 'Installed Pi bridge extension: %s\n' "${extensions_directory}/picode.ts"
printf 'Pi for VS Code installed. Run "Developer: Reload Window" in VS Code to finish.\n'
