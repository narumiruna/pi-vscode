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

for required_command in curl code mktemp rm; do
  if ! command -v "${required_command}" >/dev/null 2>&1; then
    echo "Error: required command not found: ${required_command}" >&2
    exit 1
  fi
done

temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/pi-vscode.XXXXXX")"
vsix_path="${temporary_directory}/${asset}"
cleanup() {
  rm -rf "${temporary_directory}"
}
trap cleanup 0
trap 'exit 1' HUP INT QUIT TERM

printf 'Downloading %s...\n' "${download_url}"
curl --fail --location --silent --show-error --retry 3 --output "${vsix_path}" "${download_url}"

printf 'Installing %s...\n' "${asset}"
code --install-extension "${vsix_path}" --force

agent_directory=""
if [ -n "${PI_CODING_AGENT_DIR:-}" ]; then
  agent_directory="${PI_CODING_AGENT_DIR}"
elif [ -n "${HOME:-}" ]; then
  agent_directory="${HOME}/.pi/agent"
fi
if [ -n "${agent_directory}" ]; then
  extensions_directory="${agent_directory}/extensions"
  for legacy_bridge in "${extensions_directory}/picode.ts" "${extensions_directory}/pi-vscode.ts"; do
    if [ -e "${legacy_bridge}" ] || [ -L "${legacy_bridge}" ]; then
      rm -f "${legacy_bridge}"
      printf 'Removed legacy global Pi bridge extension: %s\n' "${legacy_bridge}"
    fi
  done
fi

printf 'Pi for VS Code installed. Run "Developer: Reload Window" in VS Code to finish.\n'
