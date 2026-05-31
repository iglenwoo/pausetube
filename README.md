# OffTube

ADHD-friendly YouTube nudges. Don't block — add friction to the dopamine loop.

## What it does

- **Intent prompt** on first visit: *"What are you here to watch?"*
- **Time-gate overlay** after 3 min of browsing (or 3 Shorts in a row): pauses the video, runs a ~10s breathing beat, then asks what you want to do — done, 1 more min, 3 more min, or cancel the session.
- **Session timer** with minute pulses, floating badge, and a matching countdown on the extension icon.
- **Snooze, no off switch.** Suppress nudges for 1/5/10 min from the popup, or 1/3 min from the overlay. No disable toggle.

See [DESIGN.md](./DESIGN.md) for the full behavior spec.

## Install (dev)

1. `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this folder

## Project layout

```
manifest.json   MV3 manifest
background.js   Service worker (session, timers, snooze, tab tracking)
content.js      Injected on youtube.com (overlay, intent, badge, pulse)
content.css     Overlay + badge styles
popup.html/js   Extension popup (stats, snooze, cancel)
icons/          Action icons
```

State lives in `chrome.storage.local`. Timer runs only while a YouTube tab is open.
