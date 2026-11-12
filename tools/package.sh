#!/usr/bin/env bash
# Builds the zip you upload to the Chrome Web Store: dist/strict-shield-<version>.zip
set -euo pipefail
cd "$(dirname "$0")/.."

node tools/build-rules.mjs
version=$(node -p "require('./extension/manifest.json').version")
out="dist/strict-shield-${version}.zip"
mkdir -p dist
rm -f "$out"
# _metadata/ is written by Chrome when the folder is loaded unpacked; the store rejects it.
(cd extension && zip -qr -X "../$out" . -x '*.DS_Store' -x '__MACOSX/*' -x '_metadata/*')
echo "Created $out ($(du -h "$out" | cut -f1))"
