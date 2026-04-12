# OffTube — Design Document

## Problem

YouTube's UI is designed to maximize watch time through dopamine loops: thumbnails → click → video → recommendations → click → repeat. For people with ADHD, this loop is especially hard to break. Existing tools like Unhook hide elements entirely, but users just turn them off — the all-or-nothing approach doesn't work.

## Core Insight

Don't hard-block YouTube. Hide the highest-risk browsing surfaces by default, then require a deliberate snooze to bring them back temporarily.

## Target Behavior Change

Interrupt the cycle: **thumbnail → click → video → more thumbnails → click → ...**

## Features (v0.1)

### 1. Hide Browsing Surfaces

Removes the most compulsive browsing surfaces until the user makes an explicit choice to snooze.

**Behavior:**
- Home feed is hidden by default
- Search results are hidden by default
- Sidebar recommendations on video pages are hidden by default (biggest rabbit hole trigger)
- A centered message explains that browsing is hidden and offers snooze choices
- Snooze temporarily reveals the hidden surfaces (see Feature 4)

**Why hide the screen instead of blur:**
The current product direction is stronger friction at the browsing layer. Instead of softening thumbnails, OffTube hides the high-risk browsing surfaces until the user explicitly snoozes, which makes the decision more deliberate without permanently disabling access.

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
- Extension icon badge shows the elapsed session time at a glance (visible from any tab)

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
- Snooze temporarily reveals hidden browsing surfaces and suppresses the prompt
- Session tracking continues while snoozed, and the UI indicates that snooze is active
- When snooze expires, all hidden surfaces and prompts re-activate automatically

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
├── content.js             # Injected into YouTube: hidden-screen UI, intent prompt, floating badge
├── content.css            # Hidden-screen styles, overlay styles, badge styles
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
    "elapsedMs": 540000,
    "timerStartedAt": 1712001200000,
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

1. Should home, search, and sidebar surfaces all be hidden, or should some remain visible by default?
2. Should the floating timer be dismissable or always visible?
3. Should there be a "focus mode" that only allows the search bar + subscriptions?
4. Sound/notification when snooze expires, or just silent re-activation?
