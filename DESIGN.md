# OffTube — Design Document

## Problem

YouTube's UI is designed to maximize watch time through dopamine loops: thumbnails → click → video → recommendations → click → repeat. For people with ADHD, this loop is especially hard to break. Existing tools like Unhook hide elements entirely, but users just turn them off — the all-or-nothing approach doesn't work.

## Core Insight

Don't block. Nudge. Add friction to the dopamine loop without removing access entirely.

## Target Behavior Change

Interrupt the cycle: **thumbnail → click → video → more thumbnails → click → ...**

## Features (v0.1)

### 1. Blur Thumbnails

Breaks the visual hook that initiates the dopamine loop.

**Behavior:**
- Home feed thumbnails are blurred by default via CSS `filter: blur()`
- Sidebar recommendations on video pages are always blurred (biggest rabbit hole trigger)
- Click on an individual thumbnail to unblur it (friction is per-video, not per-session)
- Option to unblur all via snooze (see Feature 4)

**Why blur, not hide:**
Hiding feels like something is taken away — users disable the extension. Blur keeps the content "there" but removes the visual dopamine trigger (thumbnails are the hook).

### 2. Intent Prompt

Forces a moment of self-awareness before the loop begins.

**Behavior:**
- Triggers on first `youtube.com` visit per session
- Full-page overlay with a text input: *"What are you here to watch?"*
- User's answer pins to the top-right corner as a small sticky reminder
- If the user arrived via a direct video link (shared URL), skip the prompt — intent already exists
- "Session" resets after 30 min of no YouTube activity (configurable)

**Detection logic:**
- Direct video link: URL matches `youtube.com/watch?v=` on first navigation (not from YouTube itself)
- Referrer is external (not youtube.com) → likely a shared link → skip prompt
- Navigated to `youtube.com` or `youtube.com/` → no clear intent → show prompt

### 3. Session Timer + Video Counter

Ongoing passive awareness while inside the loop.

**Behavior:**
- Floating badge on YouTube pages showing: elapsed time + videos watched
- Example: `23 min · 4 videos`
- Extension icon badge shows the same info (visible from any tab)

**Multi-tab handling:**
- State stored in `chrome.storage.local`, shared across all tabs
- Any YouTube tab open = timer running
- All YouTube tabs closed = timer pauses
- Timer resets when session resets (30 min inactivity)

**Video count tracking:**
- Increment counter on `youtube.com/watch` navigation (via `chrome.webNavigation` or URL change detection)
- Deduplicate: same video ID doesn't increment twice in a session

### 4. Snooze System (No Off Switch)

Prevents permanent removal of friction layers.

**Behavior:**
- Extension has no "disable" option — only snooze
- Snooze disables all nudges (blur, prompt, timer) temporarily
- When snooze expires, all features re-activate automatically

**Snooze options:**

| Type | Options |
|------|---------|
| Time-based | 5 min / 15 min / 30 min |
| Video-count | 3 videos / 5 videos / 10 videos |
| Combined | Whichever limit is hit first |

**Example:** User selects "15 min or 5 videos" — nudges return after 15 minutes OR after 5 videos, whichever comes first.

**Why combined mode:**
ADHD users may lose track of time but notice video count, or vice versa. Dual limits cover both failure modes.

## Architecture

```
offtube/
├── manifest.json          # Chrome extension manifest (MV3)
├── background.js          # Service worker: session state, timer, snooze logic
├── content.js             # Injected into YouTube: blur, intent prompt, floating badge
├── content.css            # Blur styles, overlay styles, badge styles
├── popup.html             # Extension popup: snooze controls, session stats
├── popup.js               # Popup logic
└── icons/                 # Extension icons
```

**State management:**
- `chrome.storage.local` for cross-tab shared state
- Background service worker manages timers and snooze expiry
- Content script reads state and applies UI changes
- Popup reads/writes snooze settings

**Key state shape:**
```json
{
  "session": {
    "startTime": 1712000000000,
    "videoCount": 4,
    "videosWatched": ["dQw4w9WgXcQ", "abc123"],
    "intent": "watch the Next.js tutorial",
    "lastActivity": 1712001400000
  },
  "snooze": {
    "active": false,
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

## Out of Scope (v0.1)

- Breathing exercises / mindfulness prompts
- Daily watch budgets / hard limits
- Progressive delay on autoplay
- Autoplay control (Unhook handles this)
- Analytics / watch history dashboard
- Sync across devices

## Open Questions

1. Should blur intensity be configurable (light blur vs heavy blur)?
2. Should the floating timer be dismissable or always visible?
3. Should there be a "focus mode" that only allows the search bar + subscriptions?
4. Sound/notification when snooze expires, or just silent re-activation?
