#!/usr/bin/env python3
"""Makes the two small fonts embedded in the arcade (needs: pip install fonttools brotli).

    python3 tools/make_fonts.py Monoton.woff2 PressStart2P.woff2

The originals come from Google Fonts (https://fonts.google.com/specimen/Monoton and
https://fonts.google.com/specimen/Press+Start+2P). Both are under the SIL Open Font License 1.1 with Reserved Font
Names, so the subsets made here are renamed "HazeNeon" and "HazePixel" (in the files and in the CSS), as the
licence asks of modified versions. The licences are in src/fonts/.
"""

import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

OUT = Path(__file__).resolve().parent.parent / "src" / "fonts"

JOBS = [
    # (source, new family name, output, characters)
    (0, "HazeNeon", "haze-neon.woff2", "ABCDEFGHIJKLMNOPQRSTUVWXYZ "),
    (1, "HazePixel", "haze-pixel.woff2", "".join(chr(c) for c in range(0x20, 0x7F)) + "\u00a9\u00b7\u2022\u2026"),
]


def rename(font: TTFont, family: str) -> None:
    names = font["name"]
    for record in list(names.names):
        if record.nameID in (1, 4, 16, 21):
            record.string = family
        elif record.nameID in (6, 20):
            record.string = family.replace(" ", "")
        elif record.nameID == 3:
            record.string = family + "-Regular"
        elif record.nameID == 2:
            record.string = "Regular"
        elif record.nameID in (17, 22):
            record.string = "Regular"


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    sources = sys.argv[1:]
    for index, family, output, text in JOBS:
        options = subset.Options()
        options.flavor = "woff2"
        options.layout_features = ["*"]
        options.hinting = False
        options.name_IDs = ["*"]
        options.name_languages = ["*"]
        font = TTFont(sources[index])
        subsetter = subset.Subsetter(options)
        subsetter.populate(text=text)
        subsetter.subset(font)
        rename(font, family)
        font.flavor = "woff2"
        font.save(OUT / output)
        print(f"src/fonts/{output}: {(OUT / output).stat().st_size} bytes")


if __name__ == "__main__":
    main()
