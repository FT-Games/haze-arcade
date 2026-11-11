#!/usr/bin/env bash
# Builds the extension, checks it with PhantomHaze's own parser, then plays it in Chromium.
#
#   FTGAMES=/path/to/ftgames PHANTOMHAZE=/path/to/PhantomHaze tests/run.sh [suites]
#
# Needs python3 (+ Pillow for tools/sync_catalog.py), the .NET 10 SDK and Node with Playwright.
# suites: boot,games,nav,live,offline (default: all of them). Add --real to the node line to use GitHub itself.
set -euo pipefail
cd "$(dirname "$0")/.."
FTGAMES=${FTGAMES:?set FTGAMES to a checkout of https://github.com/FT-Games/ftgames}
PHANTOMHAZE=${PHANTOMHAZE:?set PHANTOMHAZE to a checkout of https://github.com/PhantomHaze-Security/PhantomHaze}
OUT=tests/out

python3 tools/build.py
dotnet build tests/phext-check -nologo -v q -o tests/phext-check/bin -p:PhantomHazeSrc="$PHANTOMHAZE"
# The page exactly as PhantomHaze would render it.
dotnet tests/phext-check/bin/PhextCheck.dll "dist/Haze Arcade.phext" "$OUT"
node tests/arcade.test.js --ftgames "$FTGAMES" --page "$OUT/page-arcade.html" --suite "${1:-boot,games,nav,live,offline}" --shots "$OUT/shots"
