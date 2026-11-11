#!/usr/bin/env bash
# Builds the extension, checks it with PhantomHaze's own parser, then plays it in Chromium.
#
#   FTGAMES=/path/to/ftgames PHANTOMHAZE=/path/to/PhantomHaze tests/run.sh [suites]
#
# Needs python3 (+ Pillow for tools/sync_catalog.py), the .NET 10 SDK and Node with Playwright.
# suites: boot,games,nav,live,offline,settings,tab (default: all of them) and speed (slow-connection timing).
set -euo pipefail
cd "$(dirname "$0")/.."
FTGAMES=${FTGAMES:?set FTGAMES to a checkout of https://github.com/FT-Games/ftgames}
PHANTOMHAZE=${PHANTOMHAZE:?set PHANTOMHAZE to a checkout of https://github.com/PhantomHaze-Security/PhantomHaze}
OUT=tests/out

python3 tools/build.py
dotnet build tests/phext-check -nologo -v q -o tests/phext-check/bin -p:PhantomHazeSrc="$PHANTOMHAZE"
# The page and tab script exactly as PhantomHaze would render them, with the default settings...
dotnet tests/phext-check/bin/PhextCheck.dll "dist/Haze Arcade.phext" "$OUT"
# ...and with a 1 second hold, which the long per-game run uses.
dotnet tests/phext-check/bin/PhextCheck.dll "dist/Haze Arcade.phext" "$OUT/fast" holdSeconds=1 > /dev/null
node tests/arcade.test.js --ftgames "$FTGAMES" --page "$OUT/page-arcade.html" --fast-page "$OUT/fast/page-arcade.html" \
  --tab-script "$OUT/script-tabLoader.js" --suite "${1:-boot,games,nav,live,offline,settings,tab}" --shots "$OUT/shots"
