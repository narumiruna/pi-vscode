#!/bin/sh

set -eu

cd "$(dirname "$0")/.."

npx --yes @biomejs/biome@2.5.13 migrate --write
npx --yes @biomejs/biome@2.5.13 format --write src
npx --yes @biomejs/biome@2.5.13 check --write src
