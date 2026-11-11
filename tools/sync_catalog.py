#!/usr/bin/env python3
"""Builds src/catalog.json and src/thumbs/*.webp from a checkout of the FT Games site.

    python3 tools/sync_catalog.py /path/to/ftgames

The arcade shows the cards of games.html in the same order and loads every game
from the FT-Games/ftgames repository on GitHub. For every card this records the
game's page in the repository, whether it is a TurboWarp (Scratch) page, its
instructions page, the scripts it loads on the fly and how much it downloads (for
the loading bar).
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


def button_profile(page_html: str) -> dict:
    """Whether the page has its own way back to the games page and its own Instructions button."""
    home_link = re.search(r"""<a\b[^>]*\bhref=["'](?:https?://ftgames\.xyz)?/(?:games(?:\.html)?)?["']""", page_html)
    return {"home": 'id="homeButton"' in page_html or bool(home_link), "instr": 'id="instructionsButton"' in page_html}


def find_instructions(repo: Path, top: str, page_html: str, has_button: bool) -> str | None:
    """The instructions page the game's Instructions button opens, as a file in the repository."""
    if not has_button:
        return None
    m = re.search(r"window\.open\(\s*[\"'`]([^\"'`]+)[\"'`]", page_html)
    candidate = None
    if m:
        target = re.sub(r"^https?://ftgames\.xyz", "", m.group(1))
        if target.startswith("/"):
            candidate = target.lstrip("/")
    if candidate is None and (repo / top / "instructions.html").is_file():
        candidate = f"{top}/instructions"  # the button exists but the page forgot its click handler
    if candidate is None:
        return None
    if not candidate.endswith(".html") and (repo / (candidate + ".html")).is_file():
        candidate += ".html"
    return candidate if (repo / candidate).is_file() else None


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
            entry.update(id=slugify(entry["title"]), kind="makecode", url=f"{MAKECODE_HOST}---run?id={share_id}",
                         tabUrl=href, buttons={"home": False, "instr": False}, instructions=None, bytes=0)
        elif href.startswith("/"):
            parts = [p for p in href.split("/") if p]
            top = parts[0]
            if (repo / top).is_dir():
                rel = "/".join(parts)
                if len(parts) > 1 and (repo / (rel + ".html")).is_file():
                    file = rel + ".html"
                elif (repo / rel / "index.html").is_file():
                    file = rel + "/index.html"
                else:
                    print(f"warning: {href} has no page in the checkout; skipped", file=sys.stderr)
                    continue
            elif (repo / (top + ".html")).is_file():
                file = top + ".html"
            else:
                print(f"warning: {href} is not in the checkout; skipped", file=sys.stderr)
                continue
            page_file = repo / file
            page_html = page_file.read_text(encoding="utf-8", errors="replace")
            buttons = button_profile(page_html)
            folder = page_file.parent
            # TurboWarp-packaged Scratch game: script.js plus a project whose assets are listed in project.json.
            tw = 'src="script.js"' in page_html and (folder / "assets" / "project.json").is_file()
            size = page_file.stat().st_size
            for tag in re.finditer(r"<script\b[^>]*\bsrc=[\"']([^\"']+)[\"']", page_html):
                src = tag.group(1)
                if re.match(r"[a-z]+:", src) or "analytics-consent" in src:
                    continue
                script = (repo / src.lstrip("/")) if src.startswith("/") else (folder / src)
                if script.is_file():
                    size += script.stat().st_size
            if tw:
                size += folder_size(folder / "assets")
            entry.update(id=slugify(top), kind="ft", file=file, tw=tw, buttons=buttons,
                         instructions=find_instructions(repo, top, page_html, buttons["instr"]), bytes=size)
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
        for extra in entry.get("prefetch", []):
            if not (repo / extra).is_file():
                sys.exit(f"overrides.json: {entry['id']} prefetches {extra}, which is not in the checkout")
            entry["bytes"] += (repo / extra).stat().st_size
        games.append(entry)

    out = {"source": "games.html", "games": games}
    (SRC / "catalog.json").write_text(json.dumps(out, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    total = sum((thumbs / g["thumb"]).stat().st_size for g in games if g.get("thumb"))
    print(f"{len(games)} cards, thumbnails {total // 1024} KB")


if __name__ == "__main__":
    main()
