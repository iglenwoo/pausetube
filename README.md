# PauseTube

ADHD-friendly YouTube nudges. Instead of blocking YouTube, it adds friction to the dopamine loop.

## What it does

- **Intent prompt** on first visit: *"What are you here to watch?"*
- **Time-gate overlay** after 3 min of browsing: pauses the video, runs a ~10s breathing beat, then asks what you want to do: done, more minutes, or cancel the session.
- **Session timer** with minute pulses and a floating badge: blue = minutes left before the gate, yellow = minutes left in a snooze, red = minutes past the gate.
- **Snooze count** on the extension icon. The color blends from blue at 1 through violet and crimson to red-black at 10+, getting more serious with each snooze. Resets with the session.
- **Snooze, no off switch.** Suppress nudges for 1/5/10 min from the popup, or 1/3 min from the overlay. No disable toggle.

## Settings

You can tune the friction, but not turn it off, from the **⚙ Settings** link in the popup (or the extension's options page):

- **Browse time before the gate** (default 3 min) and **inactivity reset** (default 30 min)
- **Breathing inhale / exhale** length
- **Snooze button** options for the popup and the gate
- **Intent prompt** on/off, and whether to also prompt on links opened from outside YouTube

Settings are sparse overrides on the schema in [`utils/config.js`](./utils/config.js). That one schema drives the defaults, the options form, and validation. Only changed knobs are stored, so the rest keep tracking the defaults across updates.

## Develop

Built with [WXT](https://wxt.dev). Needs Node 22+ and pnpm (`brew install pnpm`).

```sh
pnpm install
pnpm dev      # dev build in .output/chrome-mv3-dev/ with hot reload; load it unpacked
pnpm build    # production build in .output/chrome-mv3/
pnpm zip      # store-ready zip in .output/
pnpm icons    # regenerate public/icons/*.png from icons/icon.svg
```

To load a build by hand: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `.output/chrome-mv3/`.

The version comes from `package.json`; the rest of the manifest from `wxt.config.js` and `entrypoints/`.

## Project layout

```
wxt.config.js           Manifest fields (permissions, icons)
utils/config.js         Settings schema + defaults + validation (shared everywhere)
entrypoints/
  background.js         Service worker (session, timers, snooze, settings, tab tracking)
  content/index.js      Injected on youtube.com (overlay, intent, badge, pulse)
  content/style.css     Overlay + badge styles
  popup/                Extension popup (stats, snooze, cancel)
  options/              Settings page
  debug/                Developer state console
public/icons/           Action icons
icons/                  Icon source SVG + generator
site/                   pausetube.com landing and privacy pages
```

State lives in `chrome.storage.local`. Timer runs only while a YouTube tab is open.
