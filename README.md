# OffTube

ADHD-friendly YouTube nudges. Don't block — add friction to the dopamine loop.

## What it does

- **Intent prompt** on first visit: *"What are you here to watch?"*
- **Time-gate overlay** after 3 min of browsing: pauses the video, runs a ~10s breathing beat, then asks what you want to do — done, more minutes, or cancel the session.
- **Session timer** with minute pulses, floating badge, and a matching countdown on the extension icon.
- **Snooze, no off switch.** Suppress nudges for 1/5/10 min from the popup, or 1/3 min from the overlay. No disable toggle.

## Settings

Tune the friction — but never turn it off — from the **⚙ Settings** link in the popup (or the extension's options page):

- **Browse time before the gate** (default 3 min) and **inactivity reset** (default 30 min)
- **Breathing inhale / exhale** length
- **Snooze button** options for the popup and the gate
- **Intent prompt** on/off, and whether to also prompt on links opened from outside YouTube

Settings live in `chrome.storage.local` as sparse overrides — only what you change is stored, so unchanged knobs keep tracking the defaults across updates. The schema in [`config.js`](./config.js) is the single source of truth that drives the defaults, the options form, and validation. The 🐞 Debug console exposes the raw state for development.

## Install (dev)

1. `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this folder

## Project layout

```
manifest.json     MV3 manifest
config.js         Settings schema + defaults + validation (shared everywhere)
background.js     Service worker (session, timers, snooze, settings, tab tracking)
content.js        Injected on youtube.com (overlay, intent, badge, pulse)
content.css       Overlay + badge styles
popup.html/js     Extension popup (stats, snooze, cancel)
options.html/js   Settings page
debug.html/js     Developer state console
icons/            Action icons
```

State lives in `chrome.storage.local`. Timer runs only while a YouTube tab is open.
