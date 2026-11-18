#!/bin/sh

set -eu

cd "$(dirname "$0")/.."

# Check the files Git will commit, not the working tree.
snapshot=$(mktemp -d "${TMPDIR:-/tmp}/pi-pre-commit.XXXXXXXX")
trap 'rm -rf -- "$snapshot"' EXIT
git -c core.autocrlf=false checkout-index --all --prefix="$snapshot/"

(
  cd "$snapshot"
  npx --yes @biomejs/biome@2.5.13 migrate
  npx --yes @biomejs/biome@2.5.13 check src
)
