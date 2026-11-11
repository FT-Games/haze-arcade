#!/usr/bin/env python3
"""Builds src/catalog.json and src/thumbs/*.webp from a checkout of the FT Games site.

    python3 tools/sync_catalog.py /path/to/ftgames

The arcade shows the cards of games.html in the same order. For every card the
script records how the game page is built (its Home / Instructions buttons, its
instructions page) and how much it downloads, so the arcade can cover the
page's own buttons and keep its loading screen up until the game is loaded.
"""

from __future__ import annotations

import html.parser
import io
import json
import os
import re
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
THUMB_WIDTH = 480
THUMB_QUALITY = 72
MAKECODE_HOST = "https://arcade.makecode.com/"


class CardParser(html.parser.HTMLParser):
    """Collects the game cards (<a class="game-card">) of games.html."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.cards: list[dict] = []
        self.card: dict | None = None
        self.field: str | None = None
        self.depth = 0

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        classes = (a.get("class") or "").split()
        if tag == "a" and "game-card" in classes and self.card is None:
            self.card = {"href": a.get("href", ""), "title": "", "description": "", "genre": "", "difficulty": "", "thumb": "", "alt": ""}
            self.depth = 0
            return
        if self.card is None:
            return
        if tag == "a":
            self.depth += 1
        if tag == "img" and "game-card-thumbnail" in classes:
            self.card["thumb"] = a.get("src", "")
            self.card["alt"] = a.get("alt", "")
        elif "game-card-title" in classes:
            self.field = "title"
        elif "game-card-description" in classes:
            self.field = "description"
        elif "game-tag-genre" in classes:
            self.field = "genre"
        elif "game-tag-difficulty" in classes:
            self.field = "difficulty"

    def handle_endtag(self, tag):
        if self.card is None:
            return
        if tag in ("h2", "p", "span"):
            self.field = None
        if tag == "a":
            if self.depth == 0:
                self.cards.append(self.card)
                self.card = None
            else:
                self.depth -= 1

    def handle_data(self, data):
        if self.card is not None and self.field:
            self.card[self.field] += data


def tidy(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def strip_prefix(text: str, prefix: str) -> str:
    text = tidy(text)
    return text[len(prefix):].strip() if text.lower().startswith(prefix.lower()) else text


def folder_size(path: Path) -> int:
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


def slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def effective_line_height(css: str) -> str:
    """The line-height a rule ends up with. Note that `font: ... !important` resets it to normal and beats a later
    plain `line-height: 1`, which is what most FT Games pages do (their buttons are 42px tall, not 39px)."""
    value, important = "normal", False
    for declaration in css.split(";"):
        if ":" not in declaration:
            continue
        prop, val = (part.strip().lower() for part in declaration.split(":", 1))
        is_important = "!important" in val
        val = val.replace("!important", "").strip()
        if prop == "font":
            m = re.search(r"\d(?:px|pt|em|rem|%)?\s*/\s*([\w.]+)", val)
            new = m.group(1) if m else "normal"
        elif prop == "line-height":
            new = val
        else:
            continue
        if is_important or not important:
            value, important = new, is_important or important
    return "1" if value in ("1", "1.0") else "normal"


def button_profile(page_html: str) -> dict:
    """How the page draws its own Home / Instructions buttons, so the arcade can cover them exactly."""
    has_home = 'id="homeButton"' in page_html
    has_instr = 'id="instructionsButton"' in page_html
    rule = re.search(r"#homeButton\s*,\s*#instructionsButton\s*\{([^}]*)\}", page_html) or re.search(r"#homeButton\s*\{([^}]*)\}", page_html)
    css = rule.group(1) if rule else ""
    display = "flex" if re.search(r"display\s*:\s*inline-flex", css) else "block"
    return {"home": has_home, "instr": has_instr, "display": display, "lineHeight": effective_line_height(css)}


def find_instructions(repo: Path, top: str, page_html: str, has_button: bool) -> str | None:
    """The instructions page the game's Instructions button opens (as a path on the site)."""
    if not has_button:
        return None
    m = re.search(r"window\.open\(\s*[\"'`]([^\"'`]+)[\"'`]", page_html)
    candidate = None
    if m:
        target = m.group(1)
        target = re.sub(r"^https://ftgames\.xyz", "", target)
        if target.startswith("/"):
            candidate = target
    if candidate is None and (repo / top / "instructions.html").is_file():
        candidate = f"/{top}/instructions"  # the button exists but the page forgot its click handler
    if candidate is None:
        return None
    # Ask for the .html file itself: no redirect, and no clash with a folder of the same name.
    file_path = repo / candidate.lstrip("/")
    if not candidate.endswith(".html") and (file_path.parent / (file_path.name + ".html")).is_file():
        candidate += ".html"
    return candidate


def make_thumb(repo: Path, src: str, out: Path) -> None:
    image = Image.open(repo / src.lstrip("/"))
    image = image.convert("RGBA")
    if image.width > THUMB_WIDTH:
        image = image.resize((THUMB_WIDTH, round(image.height * THUMB_WIDTH / image.width)), Image.LANCZOS)
    buf = io.BytesIO()
    image.save(buf, "WEBP", quality=THUMB_QUALITY, method=6)
    out.write_bytes(buf.getvalue())


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    repo = Path(sys.argv[1]).resolve()
    parser = CardParser()
    parser.feed((repo / "games.html").read_text(encoding="utf-8"))
    if len(parser.cards) < 5:
        sys.exit("games.html did not contain the expected game cards")

    thumbs = SRC / "thumbs"
    thumbs.mkdir(parents=True, exist_ok=True)
    for old in thumbs.glob("*.webp"):
        old.unlink()

    overrides_file = SRC / "overrides.json"
    overrides = json.loads(overrides_file.read_text(encoding="utf-8")) if overrides_file.is_file() else {}
    games = []
    for card in parser.cards:
        href = card["href"].strip()
        entry = {
            "title": tidy(card["title"]),
            "description": tidy(card["description"]),
            "genre": strip_prefix(card["genre"], "Genre:"),
            "difficulty": strip_prefix(card["difficulty"], "Difficulty:"),
            "href": href,
        }
        if href.startswith(MAKECODE_HOST):
            share_id = href[len(MAKECODE_HOST):].strip("/")
            entry.update(id=slugify(entry["title"]), kind="makecode",
                         url=f"{MAKECODE_HOST}---run?id={share_id}",
                         frame=[f"{MAKECODE_HOST}---run"], buttons={"home": False, "instr": False, "display": "flex", "lineHeight": "normal"},
                         instructions=None, preloadBytes=0, lazyBytes=0)
        elif href.startswith("/"):
            parts = [p for p in href.split("/") if p]
            top = parts[0]
            if (repo / top).is_dir():
                if len(parts) > 1:
                    rel = "/".join(parts)
                    url = f"/{rel}.html" if (repo / (rel + ".html")).is_file() else f"/{rel}"
                    page_file = repo / (rel + ".html") if (repo / (rel + ".html")).is_file() else repo / rel / "index.html"
                else:
                    url = f"/{top}/"
                    page_file = repo / top / "index.html"
            elif (repo / (top + ".html")).is_file():
                url = f"/{top}"
                page_file = repo / (top + ".html")
            else:
                print(f"warning: {href} is not in the checkout; skipped", file=sys.stderr)
                continue
            page_html = page_file.read_text(encoding="utf-8", errors="replace")
            buttons = button_profile(page_html)
            instructions = find_instructions(repo, top, page_html, buttons["instr"])
            # Everything the page needs before its load event: the page and its classic/defer scripts.
            preload = page_file.stat().st_size
            for tag in re.finditer(r"<script\b([^>]*)\bsrc=[\"']([^\"']+)[\"']([^>]*)>", page_html):
                attrs = tag.group(1) + tag.group(3)
                if re.search(r"\basync\b", attrs) or re.match(r"[a-z]+:", tag.group(2)):
                    continue
                script = (repo / tag.group(2).lstrip("/")) if tag.group(2).startswith("/") else (page_file.parent / tag.group(2))
                if script.is_file():
                    preload += script.stat().st_size
            lazy = 0
            folder = repo / top
            if (folder / "script.js").is_file() and (folder / "assets" / "project.json").is_file() and url == f"/{top}/":
                # TurboWarp-packaged Scratch game: the project's assets are fetched after the load event.
                lazy = folder_size(folder / "assets")
            entry.update(id=slugify(top), kind="ft", url=url, frame=[f"/{top}/", f"/{top}"], buttons=buttons,
                         instructions=instructions, preloadBytes=preload, lazyBytes=lazy)
            if top == "suggestion_box":
                entry["isGame"] = False
        else:
            print(f"warning: unsupported link {href}; skipped", file=sys.stderr)
            continue

        name = f"{entry['id']}.webp"
        override = SRC / "thumb-overrides" / f"{entry['id']}.png"
        if override.is_file():
            # The site has no picture for this card (its <img> is broken), so the arcade ships its own.
            make_thumb(override.parent, override.name, thumbs / name)
            entry["thumb"] = name
        elif card["thumb"] and (repo / card["thumb"].lstrip("/")).is_file():
            make_thumb(repo, card["thumb"], thumbs / name)
            entry["thumb"] = name
        else:
            print(f"warning: no thumbnail for {entry['title']} ({card['thumb'] or 'none'}); the arcade draws one", file=sys.stderr)
        for key, value in overrides.get(entry["id"], {}).items():
            if not key.startswith("_"):
                entry[key] = value
        games.append(entry)

    out = {"source": "games.html", "games": games}
    (SRC / "catalog.json").write_text(json.dumps(out, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    total = sum((thumbs / g["thumb"]).stat().st_size for g in games if g.get("thumb"))
    print(f"{len(games)} cards, thumbnails {total // 1024} KB")


if __name__ == "__main__":
    main()
