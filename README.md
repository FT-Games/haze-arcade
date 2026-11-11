# Haze Arcade

A [PhantomHaze](https://github.com/PhantomHaze-Security/PhantomHaze) extension that puts the whole
[FT Games](https://ftgames.xyz) library in its own **Haze Arcade** tab in the PhantomHaze menu bar, next to
**Logs** and **Web View**.

![The Haze Arcade loading screen](docs/loading-screen.webp)

## Install

1. Download [`dist/Haze Arcade.phext`](dist/Haze%20Arcade.phext).
2. In PhantomHaze open **Settings -> Extensions -> Import extension**, pick the file and click **Save**.
3. Click **Haze Arcade** in the menu bar.

Re-importing a newer file updates the installed extension (same `meta.id`).

## What you get

- **The games page, not the homepage.** The tab opens on the FT Games games list: every card of
  `games.html` in the same order, with thumbnails, descriptions, genre and difficulty tags, search, genre and
  difficulty filters and favourites.
- **Games play inside the tab.** Clicking a card loads the game from ftgames.xyz in the arcade itself. The game's
  **Home** button (top right) takes you back to the games page, and **Instructions** (top left) opens the game's
  instructions in a panel instead of a popup window.
- **A neon "Haze Arcade" loading screen** while the games page or a game loads. It stays up until everything has
  loaded (for Scratch games that includes downloading and unpacking the project) and then counts down
  **5 seconds** before showing the game.
- **New games show up by themselves.** Each time the arcade opens it reads the live games page, so games FT Games
  adds later appear without a new extension. Without an internet connection it falls back to the list built into
  the file and says so.

![The games page](docs/games-page.webp)

## How it fits into PhantomHaze

PhantomHaze shows extension pages with WebView2's `NavigateToString`, which refuses documents over 2 MB. The FT Games
site is about 260 MB, so the games cannot be packed into the extension. The `.phext` contains the arcade itself (the
page, its 31 thumbnails as small WebP images and two tiny fonts, about 370 KB), and each game streams from
ftgames.xyz, exactly as on the website. Games therefore need an internet connection.

Things the arcade does so the games behave well inside PhantomHaze:

| Problem in an extension page | What Haze Arcade does |
| :-- | :-- |
| Clicking a game's **Home** link would load the FT Games site inside the tab. | The arcade draws its own copy of the button exactly over the page's one (same size, per page), so Home goes to the arcade's games page. |
| **Instructions** uses `window.open`, which PhantomHaze turns into a new tab and switches to Web View. | Instructions open in a panel inside the arcade. Retro Pong's Instructions button, which does nothing on the site, works here. |
| Other ways a game page can leave the game (Minecraft's "Back to safety", the Home button in full screen) | A `frame-src` policy only lets game frames show their own game. Anything else is blocked and the arcade goes back to the games page. |
| A game trying to navigate the whole page would make PhantomHaze open tabs. | Games run in a sandbox without top-level navigation (everything else, such as storage, workers, pointer lock, full screen and popups, still works). |
| Extension pages are never a *secure context*, and **Polytrack** needs one (`crypto.subtle`) to check its 3D models. | Polytrack opens in a normal PhantomHaze tab, where it runs. A small `web.script` shows the same Haze Arcade loading screen there. |
| Minecraft Classic, the two MakeCode games and the Suggestion Box run on other sites. | They play in the arcade, with an extra **Tab** button to open them in a PhantomHaze tab if one ever needs a secure page too. |
| The site's Farming Sim 19 card has a broken thumbnail. | The arcade ships a picture from the game itself. |

Other details: the 2D Platformer card is FT Games' how-to page, and its PLAY button opens Google's Jerry Lawson
doodle, which PhantomHaze shows in a new tab. FT Games' analytics consent bar appears in the first game of each
session; answering it once covers the whole arcade session (PhantomHaze forgets it on exit, like all site data).
Favourites last for the PhantomHaze session, because extension pages have no storage.

![Instructions open inside the arcade](docs/instructions.webp)

## Settings

In **Settings -> Extensions -> Haze Arcade**:

| Setting | Default |
| :-- | :-- |
| Seconds the loading screen stays up after everything has loaded (0-30) | 5 |
| Check ftgames.xyz for new games each time the arcade opens | on |
| FT Games website address (only change this if the site moves) | `https://ftgames.xyz` |

## Development

```
src/arcade.html       the arcade page (template)
src/tab-loader.js     loading screen for games opened in a tab (web.script)
src/catalog.json      the game list, generated from FT Games' games.html
src/overrides.json    hand-set values per game (Polytrack opens in a tab, Tab buttons)
src/thumbs/           card thumbnails (generated), src/thumb-overrides/ pictures the site lacks
src/fonts/            HazeNeon and HazePixel subsets with their licences
tools/sync_catalog.py rebuilds catalog.json and thumbs/ from a checkout of FT-Games/ftgames
tools/build.py        writes dist/Haze Arcade.phext and dist/haze-arcade.html
tools/make_fonts.py   makes the font subsets
tests/                PhantomHaze parser check (C#) and end-to-end browser tests (Playwright)
```

After FT Games adds or changes games:

```bash
python3 tools/sync_catalog.py /path/to/ftgames
```

```bash
python3 tools/build.py
```

`dist/haze-arcade.html` is the page with default settings, for a quick look in any browser.

### Tests

```bash
FTGAMES=/path/to/ftgames PHANTOMHAZE=/path/to/PhantomHaze tests/run.sh
```

The run builds the extension and parses it with PhantomHaze's own `PhextParser` (compiled from the PhantomHaze
sources), which also writes the page and tab script exactly as PhantomHaze would render them. The page is then
opened in Chromium as a `data:` URL, the same opaque, non-secure context `NavigateToString` gives it, while
`https://ftgames.xyz` is served from the FT Games checkout. The suites check:

- **boot**: the 5-second hold, all thumbnails and fonts loaded, cards, search, filters and favourites.
- **games**: each card loads, each Scratch project loads and runs, the button copies cover the page's buttons
  exactly, instructions open, and Home goes back.
- **nav**: the hold after a game loads, blocked navigations, Minecraft's buttons, popups, and cancelling a load.
- **live**, **offline**, **settings** and **tab** (Polytrack with its loading screen).
- **speed** checks, on simulated 1.5 to 40 MB/s connections, that Scratch games have finished loading before the
  countdown starts.

## Credits

Games by FT Games. The fonts are subsets of Monoton (Vernon Adams) and Press Start 2P (The Press Start 2P Project
Authors), under the SIL Open Font License 1.1 (see `src/fonts/`), renamed HazeNeon and HazePixel as the licence asks.
