#!/usr/bin/env python3
"""Builds the Haze Arcade extension.

    python3 tools/build.py

Writes:
  dist/Haze Arcade.phext   the PhantomHaze extension (import it from Settings -> Extensions)
  dist/haze-arcade.html    the same page with the settings at their defaults, to open in a browser

PhantomHaze shows extension pages with WebView2's NavigateToString, which refuses pages over 2 MB, so the
games themselves stay on ftgames.xyz and only the arcade (page, thumbnails, fonts) goes into the file.
"""

from __future__ import annotations

import base64
import html
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
DIST = ROOT / "dist"

VERSION = "1.0.0"
EXTENSION_ID = "ftgames.haze-arcade"
PAGE_TERMINATOR = "HAZE_ARCADE_PAGE"
ICON_TERMINATOR = "HAZE_ARCADE_ICON"
TAB_TERMINATOR = "HAZE_ARCADE_TAB"
TAB_PATTERN = "https://ftgames.xyz/*"

# Settings shown in Settings -> Extensions -> Haze Arcade: (command, key, label, default, extra args)
SETTINGS = [
    ("setting.number", "holdSeconds", "Seconds the loading screen stays up after everything has loaded", "5", "0 30"),
    ("setting.toggle", "liveList", "Check ftgames.xyz for new games each time the arcade opens", "true", ""),
    ("setting.text", "server", "FT Games website address (only change this if the site moves)", "https://ftgames.xyz", ""),
]
ALLOWED_PLACEHOLDERS = {"{{setting.holdSeconds}}", "{{setting.liveList}}", "{{setting.server}}", "{{extension.version}}"}

# NavigateToString takes at most 2 MB; keep well clear of it (CRLF line endings on Windows included).
PAGE_BUDGET_BYTES = 1_500_000


def b64(path: Path) -> str:
    return base64.b64encode(path.read_bytes()).decode("ascii")


def phext_quote(value: str) -> str:
    """A double-quoted .phext argument (backslash escapes as described in PHEXT_GUIDE.md)."""
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def build_catalog() -> str:
    catalog = json.loads((SRC / "catalog.json").read_text(encoding="utf-8"))
    for game in catalog["games"]:
        thumb = game.get("thumb")
        if thumb:
            game["thumb"] = "data:image/webp;base64," + b64(SRC / "thumbs" / thumb)
    text = json.dumps(catalog, ensure_ascii=True, separators=(",", ":"))
    # Inside <script type="application/json"> only "</script" and "<!--" can end or confuse the block.
    return text.replace("</", "<\\/").replace("<!--", "<\\u0021--")


def build_page() -> str:
    page = (SRC / "arcade.html").read_text(encoding="utf-8")
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    replacements = {
        "@@BUILD_INFO@@": f"Version {VERSION}, built {stamp} by tools/build.py from https://github.com/FT-Games/haze-arcade.",
        "@@FONT_NEON@@": b64(SRC / "fonts" / "haze-neon.woff2"),
        "@@FONT_PIXEL@@": b64(SRC / "fonts" / "haze-pixel.woff2"),
        "@@CATALOG_JSON@@": build_catalog(),
    }
    for marker, value in replacements.items():
        if page.count(marker) != 1:
            sys.exit(f"build: expected exactly one {marker} in src/arcade.html")
        page = page.replace(marker, value)
    return page


def build_tab_script() -> str:
    """The loading screen for games the arcade opens in a PhantomHaze tab (a web.script)."""
    script = (SRC / "tab-loader.js").read_text(encoding="utf-8")
    for marker, value in {"@@FONT_NEON@@": b64(SRC / "fonts" / "haze-neon.woff2"), "@@FONT_PIXEL@@": b64(SRC / "fonts" / "haze-pixel.woff2")}.items():
        if script.count(marker) != 1:
            sys.exit(f"build: expected exactly one {marker} in src/tab-loader.js")
        script = script.replace(marker, value)
    try:
        script.encode("ascii")
    except UnicodeEncodeError as error:
        sys.exit(f"build: non-ASCII character in src/tab-loader.js at offset {error.start}")
    if any(line.strip() == TAB_TERMINATOR for line in script.splitlines()) or re.search(r"\{\{(?:extension|setting)\.", script):
        sys.exit("build: src/tab-loader.js contains the heredoc terminator or a placeholder")
    return script


def check_page(page: str) -> None:
    problems = []
    if "<html" not in page.lower():
        problems.append("the page must be a complete document so PhantomHaze uses it as written")
    try:
        page.encode("ascii")
    except UnicodeEncodeError as error:
        problems.append(f"non-ASCII character at offset {error.start}: {page[error.start:error.start + 20]!r}")
    if any(line.strip() == PAGE_TERMINATOR for line in page.splitlines()):
        problems.append(f"a line of the page equals the heredoc terminator {PAGE_TERMINATOR}")
    placeholders = set(re.findall(r"\{\{(?:extension\.(?:id|name|version)|setting\.[A-Za-z0-9_.-]+)\}\}", page, re.I))
    if placeholders - ALLOWED_PLACEHOLDERS:
        problems.append(f"unexpected placeholders: {sorted(placeholders - ALLOWED_PLACEHOLDERS)}")
    if "@@" in page:
        problems.append("an @@MARKER@@ was left in the page")
    windows_bytes = len(page.encode("utf-8")) + page.count("\n") + 2
    if windows_bytes > PAGE_BUDGET_BYTES:
        problems.append(f"page is {windows_bytes} bytes, over the {PAGE_BUDGET_BYTES} byte budget")
    if problems:
        sys.exit("build: " + "\n  ".join(["page check failed:"] + problems))


def resolve_defaults(page: str) -> str:
    """What PhantomHaze would render with the default settings (values are HTML-encoded in pages)."""
    values = {f"{{{{setting.{key}}}}}": default for _, key, _, default, _ in SETTINGS}
    values["{{extension.version}}"] = VERSION
    for placeholder, value in values.items():
        page = page.replace(placeholder, html.escape(value, quote=True))
    return page


def build_phext(page: str, tab_script: str) -> str:
    icon = "data:image/svg+xml;base64," + b64(SRC / "icon-extension.svg")
    menu_icon = (SRC / "icon-menu.svg").read_text(encoding="utf-8").strip()
    lines = [
        "# Haze Arcade - every FT Games game in its own PhantomHaze tab.",
        "# Import: PhantomHaze Settings -> Extensions -> Import extension, then click Save.",
        "# Built by tools/build.py from https://github.com/FT-Games/haze-arcade - edit src/, not this file.",
        "",
        f"meta.name {phext_quote('Haze Arcade')}",
        f"meta.id {phext_quote(EXTENSION_ID)}",
        f"meta.version {phext_quote(VERSION)}",
        f"meta.description {phext_quote('Play the whole FT Games library in its own Haze Arcade tab, with a neon loading screen.')}",
        f"meta.icon {phext_quote(icon)}",
        "",
    ]
    for command, key, label, default, extra in SETTINGS:
        value = default if command != "setting.text" else phext_quote(default)
        lines.append(" ".join(part for part in (command, key, phext_quote(label), value, extra) if part))
    lines += [
        "",
        "# The arcade page: a button next to Logs and Web View in the menu bar.",
        f"app.page arcade {phext_quote('Haze Arcade')} <<{PAGE_TERMINATOR}",
        page.rstrip("\n"),
        PAGE_TERMINATOR,
        "",
        "# A neon look for the arcade's menu bar button.",
        f"ui.svg arcade <<{ICON_TERMINATOR}",
        menu_icon,
        ICON_TERMINATOR,
        f"ui.element arcade text {phext_quote('Haze Arcade')}",
        f"ui.element arcade tooltip {phext_quote('Play the FT Games library')}",
        f"ui.element arcade foreground {phext_quote('#00e5ff')}",
        f"ui.shape arcade pill {phext_quote('#16052e')} {phext_quote('#ff2bd6')}",
        "",
        "# Games that need a full browser tab (Polytrack) open in a PhantomHaze tab marked #haze-arcade;",
        "# this shows the same loading screen there. It does nothing on pages the arcade did not open.",
        f"web.script tabLoader {phext_quote(TAB_PATTERN)} document-end <<{TAB_TERMINATOR}",
        tab_script.rstrip("\n"),
        TAB_TERMINATOR,
        "",
    ]
    text = "\n".join(lines)
    text.encode("ascii")
    return text


def main() -> None:
    page = build_page()
    check_page(page)
    DIST.mkdir(exist_ok=True)
    (DIST / "haze-arcade.html").write_text(resolve_defaults(page), encoding="ascii", newline="\n")
    phext = build_phext(page, build_tab_script())
    (DIST / "Haze Arcade.phext").write_text(phext, encoding="ascii", newline="\n")
    print(f"dist/Haze Arcade.phext  {len(phext.encode()):>9,} bytes")
    print(f"dist/haze-arcade.html   {len(page.encode()):>9,} bytes (page)")


if __name__ == "__main__":
    main()
