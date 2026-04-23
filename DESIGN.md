# OffTube — Design Document

## Problem

YouTube's UI is designed to maximize watch time through dopamine loops: thumbnail → click → video → recommendations → click → repeat. For people with ADHD, this loop is especially hard to break. Existing tools like Unhook hide elements entirely, but users just turn them off — the all-or-nothing approach doesn't work.

## Core Insight

Don't hard-block YouTube. Let the first few minutes of a session pass freely, then interrupt at the point where the loop usually takes over: pause playback, surface a breathing beat, and force a deliberate choice about whether to continue.

## Target Behavior Change

Interrupt the cycle: **thumbnail → click → video → more thumbnails → click → ...**

The interruption lands *during* the loop, not before it.

## Features

### 1. Intent Prompt

Forces a moment of self-awareness before the session starts.

**Behavior:**
- Triggers on first `youtube.com` visit per session, unless arriving via a direct video link (external referrer on `/watch`) — a shared link already implies intent.
- Full-page overlay with a text input: *"What are you here to watch?"*
- Two submit paths: typed intent (stored verbatim) or "Just browsing" (acknowledged but not pinned).
- Typed intents pin to the top-right as a small `🎯 <intent>` sticky reminder. "Just browsing" shows no sticky.
- Session resets after 30 min of no YouTube activity (configurable), which also clears the intent.

### 2. Session Timer, Video Counter, Shorts Streak

Ongoing passive awareness while inside the loop.

**What's tracked:**
- Elapsed time in the current session.
- Distinct videos watched (deduped by video ID).
- **Shorts streak**: consecutive Shorts watched. Any `/watch` navigation resets it to 0.

**Surfaces:**
- Floating bottom-right badge on YouTube pages: `Xm · N videos` (adds `· snoozed` while snoozed).
- Extension action badge (visible from any tab): elapsed minutes while active; snooze countdown `Xm` or 💤 while snoozed.
- Full-page minute pulse: on each minute tick, a dim (95% black) backdrop briefly displays the new minute number — a gentle heartbeat the user can't miss but doesn't have to act on.

**Multi-tab + sleep handling:**
- State lives in `chrome.storage.local`, shared across tabs.
- Timer runs only while at least one YouTube tab is open; it pauses automatically when all are closed and resumes when one reopens.
- `lastActivity` caps elapsed time so a timer left running across laptop sleep doesn't accumulate hours of fake watch time.

### 3. Time-Gate Nudge Overlay

The core intervention. Triggers when the risk of rabbit-holing becomes high.

**Trigger (risk = "high"):**
- Elapsed session time ≥ 2 minutes, **or**
- Shorts streak ≥ 3 in a row.

**Behavior when triggered:**
- Any playing video is paused.
- The page is blurred/dimmed behind a full-page overlay.
- The overlay runs in two phases; the user cannot dismiss by clicking away.

**Phase 1 — Breathing (~11s, JS-driven):**
- Header: *"Deep Breath"*.
- A circle expands on inhale, holds, then contracts on exhale.
- A horizontal phase strip (`ready → inhale → hold → exhale`) scrolls through the active phase, with a countdown number for inhale (4s) and exhale (4s).
- After the exhale, the strip drifts off-screen and Phase 2 fades in.

**Phase 2 — Exit Ramps:**
- A one-line state summary above the buttons: either `X min here · N video(s)` or `N Shorts in a row` when the streak trigger fired.
- Four choices:
  - **I'm done** — closes the current tab.
  - **1 more min** — snooze 1 minute, overlay dismisses.
  - **3 more min** — snooze 3 minutes, overlay dismisses.
  - **Cancel session** — resets the session (clears intent, timer, counts); re-triggers the intent prompt.

**Why this shape:**
Breathing eats ~10 seconds of pure friction, during which the impulse that caused the next click usually fades. Putting "I'm done" and "Cancel session" alongside the snooze options makes stopping feel as cheap as continuing.

### 4. Snooze System (No Off Switch)

Snoozing is the *only* way to suppress nudges. There is no disable toggle.

**Where snooze starts:**
- Overlay exit ramps: 1 min or 3 min.
- Extension popup: 1 min / 5 min / 10 min.
- Programmatically, a video-count limit can also be supplied (end snooze after N more videos), though no UI currently exposes this.

**Behavior while snoozed:**
- Overlay is suppressed; page is un-blurred.
- Session timer continues running.
- Badge and extension action both indicate snooze is active and show the countdown.
- A midpoint toast surfaces snooze count and total browsing time so far (*"Snoozed 2× · 12 min browsing"*), so repeated snoozes don't disappear silently.
- When snooze expires (or the video limit is hit), the risk check runs again on the next tick and the overlay re-triggers if still high-risk.

**Popup also offers:**
- *End snooze* — immediately ends the current snooze.
- *Cancel session* — resets the session the same way the overlay button does.

## Architecture

```
offtube/
├── manifest.json      # MV3 extension manifest
├── background.js      # Service worker: session state, timers, snooze, tab tracking, badge
├── content.js         # Injected on YouTube: overlay, intent prompt, badge, minute pulse, toast
├── content.css        # Overlay, breathing, badge, intent sticky, minute pulse styles
├── popup.html         # Popup: stats, intent, snooze buttons, cancel controls
├── popup.js           # Popup logic
└── icons/             # Extension icons
```

**State management:**
- `chrome.storage.local` holds all shared state.
- Background service worker owns timers, snooze alarms, and navigation/tab event handling.
- Content script reads state via `get-state`, applies UI, and sends actions (`start-snooze`, `set-intent`, `close-tab`, `reset-session`) back to the service worker.
- Popup reads state and issues the same actions.

**Key state shape:**
```json
{
  "session": {
    "startTime": 1712000000000,
    "elapsedMs": 540000,
    "timerStartedAt": 1712001200000,
    "videoCount": 4,
    "videosWatched": ["dQw4w9WgXcQ", "abc123"],
    "intent": "Next.js tutorial",
    "lastActivity": 1712001400000,
    "snoozeCount": 2,
    "totalSnoozedMs": 720000,
    "shortStreak": 0
  },
  "snooze": {
    "active": false,
    "startedAt": null,
    "expiresAt": null,
    "videoLimit": null,
    "videosAtSnoozeStart": 0
  },
  "settings": {
    "sessionTimeoutMin": 30,
    "defaultSnoozeMin": 15,
    "defaultSnoozeVideos": 5
  }
}
```

**Navigation detection:**
- `chrome.webNavigation.onHistoryStateUpdated` + `onCompleted` catch both SPA route changes and fresh loads.
- `/watch?v=…` → normal video, resets `shortStreak`.
- `/shorts/<id>` → Short, increments `shortStreak`.
- Video IDs are deduped against `videosWatched`.

## Out of Scope

- Daily watch budgets / hard blocks
- Progressive delay on autoplay
- Autoplay control (Unhook handles this)
- Analytics / watch history dashboard
- Sync across devices
- Hiding specific surfaces (home, search, sidebar) — earlier v0.1 idea, replaced by the time-gate overlay

## Open Questions

1. Should the "high risk" threshold (2 min / 3 Shorts) be user-configurable, or is a fixed value simpler and more effective?
2. Should the floating badge be dismissable, or is always-visible the whole point?
3. Should the minute pulse fade after N minutes, or stay uniformly loud every tick?
4. Should repeated snoozes extend the next breathing phase (e.g., 4→6→8 breaths) to raise the cost of continuing?
