// PauseTube — Background Service Worker
// Manages session state, timers, snooze logic, and badge updates

importScripts("config.js");
const { effectiveSettings, toSparse, snoozeBadgeColors } = self.PauseTubeConfig;

const EMPTY_SESSION = {
  startTime: null,
  elapsedMs: 0,
  timerStartedAt: null,
  videoCount: 0,
  videosWatched: [],
  intent: null,
  lastActivity: null,
  snoozeCount: 0,
  totalSnoozedMs: 0,
};

const EMPTY_SNOOZE = {
  active: false,
  expiresAt: null,
  videoLimit: null,
  videosAtSnoozeStart: 0,
};

// --- Initialization ---

chrome.runtime.onInstalled.addListener(async () => {
  const { settings, session, snooze } = await chrome.storage.local.get([
    "settings",
    "session",
    "snooze",
  ]);
  // Settings are stored as *sparse overrides* — only keys the user changed.
  // toSparse(effectiveSettings(...)) clamps whatever is stored and drops any key
  // that equals the current default, so (a) old full settings objects migrate to
  // sparse form, and (b) a changed default automatically reaches anyone who
  // hasn't overridden that key. session/snooze are only seeded when absent, so a
  // live session survives an extension reload.
  await chrome.storage.local.set({
    settings: toSparse(effectiveSettings(settings)),
    session: session || EMPTY_SESSION,
    snooze: snooze || EMPTY_SNOOZE,
  });

  // Manifest content scripts only reach tabs loaded after install, so YouTube
  // tabs already open would sit unguarded until refreshed. Start the session
  // and inject into them now. Tabs still loading get the manifest injection.
  const tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
  if (tabs.length === 0) return;
  await ensureSession();
  await syncTimerWithYouTubeTabs();
  await updateBadge();
  for (const tab of tabs) {
    if (tab.status !== "complete" || tab.discarded) continue;
    chrome.scripting
      .insertCSS({ target: { tabId: tab.id }, files: ["content.css"] })
      .then(() =>
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["config.js", "content.js"],
        })
      )
      .catch(() => {});
  }
});

// --- Session Management ---

async function getState() {
  const data = await chrome.storage.local.get(["session", "snooze", "settings"]);
  return {
    session: { ...EMPTY_SESSION, ...(data.session || {}) },
    snooze: { ...EMPTY_SNOOZE, ...(data.snooze || {}) },
    settings: effectiveSettings(data.settings),
  };
}

function getElapsedMs(session, now = Date.now()) {
  const elapsedMs = session.elapsedMs || 0;
  if (!session.timerStartedAt) return elapsedMs;
  // Cap at lastActivity so a stale timerStartedAt (from before laptop sleep)
  // doesn't accumulate hours of elapsed time.
  const effectiveNow = session.lastActivity ? Math.min(now, session.lastActivity) : now;
  return elapsedMs + Math.max(0, effectiveNow - session.timerStartedAt);
}

function pauseTimer(session, now = Date.now()) {
  if (!session.timerStartedAt) return session;
  return {
    ...session,
    elapsedMs: getElapsedMs(session, now),
    timerStartedAt: null,
  };
}

function resumeTimer(session, now = Date.now()) {
  if (session.timerStartedAt) return session;
  return {
    ...session,
    startTime: session.startTime || now,
    timerStartedAt: now,
  };
}

async function ensureSession() {
  let { session, settings } = await getState();
  const now = Date.now();

  // If the timer is running but lastActivity is stale (laptop slept without
  // triggering onStartup), pause the timer at lastActivity before checking
  // the timeout — otherwise elapsed keeps growing through the sleep gap.
  if (session.timerStartedAt && session.lastActivity && (now - session.lastActivity) > 2 * 60 * 1000) {
    session = pauseTimer(session, session.lastActivity);
    await chrome.storage.local.set({ session });
  }

  // Reset session if timed out
  if (session.lastActivity) {
    const inactiveMin = (now - session.lastActivity) / 1000 / 60;
    if (inactiveMin > settings.sessionTimeoutMin) {
      const newSession = {
        ...EMPTY_SESSION,
        startTime: now,
        timerStartedAt: now,
        lastActivity: now,
      };
      await chrome.storage.local.set({ session: newSession, snooze: EMPTY_SNOOZE });
      return newSession;
    }
  }

  // Start new session if none exists
  if (!session.startTime) {
    const newSession = {
      ...EMPTY_SESSION,
      startTime: now,
      timerStartedAt: now,
      lastActivity: now,
    };
    await chrome.storage.local.set({ session: newSession });
    return newSession;
  }

  // Update activity timestamp
  session.lastActivity = now;
  await chrome.storage.local.set({ session });
  return session;
}

async function hasOpenYouTubeTabs() {
  const tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
  return tabs.length > 0;
}

// --- Settings ---

// Merge a partial settings patch into the stored overrides, clamp the result to
// the schema, and persist it sparsely (only keys that differ from the default).
// Content scripts re-render off the storage write via chrome.storage.onChanged.
async function patchSettings(patch) {
  const { settings } = await chrome.storage.local.get("settings");
  const merged = effectiveSettings({ ...(settings || {}), ...(patch || {}) });
  await chrome.storage.local.set({ settings: toSparse(merged) });
}

async function pausePersistedTimerAtLastActivity() {
  const { session } = await getState();
  if (!session.timerStartedAt) return session;

  const pauseAt = Math.max(session.timerStartedAt, session.lastActivity || session.timerStartedAt);
  const pausedSession = pauseTimer(session, pauseAt);
  await chrome.storage.local.set({ session: pausedSession });
  return pausedSession;
}

async function syncTimerWithYouTubeTabs() {
  const [{ session }, youtubeTabsOpen] = await Promise.all([getState(), hasOpenYouTubeTabs()]);

  if (!session.startTime) return session;

  const nextSession = youtubeTabsOpen ? resumeTimer(session) : pauseTimer(session);
  if (
    nextSession.elapsedMs !== session.elapsedMs ||
    nextSession.timerStartedAt !== session.timerStartedAt ||
    nextSession.startTime !== session.startTime
  ) {
    await chrome.storage.local.set({ session: nextSession });
  }

  return nextSession;
}

// --- Video Tracking ---

async function trackVideo(videoId) {
  const { session } = await getState();
  if (!videoId || session.videosWatched.includes(videoId)) return;

  session.videosWatched.push(videoId);
  session.videoCount = session.videosWatched.length;
  session.lastActivity = Date.now();
  await chrome.storage.local.set({ session });

  await checkSnoozeVideoLimit();
  await updateBadge();
}

// --- Snooze Management ---

async function startSnooze(minutes, videoLimit) {
  const { session } = await getState();

  session.snoozeCount = (session.snoozeCount || 0) + 1;
  await chrome.storage.local.set({ session });

  const snooze = {
    active: true,
    startedAt: Date.now(),
    expiresAt: minutes ? Date.now() + minutes * 60 * 1000 : null,
    videoLimit: videoLimit || null,
    videosAtSnoozeStart: session.videoCount,
  };
  await chrome.storage.local.set({ snooze });

  if (minutes) {
    chrome.alarms.create("snooze-expire", { delayInMinutes: minutes });
  }

  await updateBadge();
}

async function endSnooze() {
  const { snooze, session } = await getState();

  if (snooze.active && snooze.startedAt) {
    session.totalSnoozedMs = (session.totalSnoozedMs || 0) + (Date.now() - snooze.startedAt);
    await chrome.storage.local.set({ session });
  }

  await chrome.storage.local.set({ snooze: EMPTY_SNOOZE });
  chrome.alarms.clear("snooze-expire");
  await updateBadge();
}

async function checkSnoozeVideoLimit() {
  const { snooze, session } = await getState();
  if (!snooze.active || !snooze.videoLimit) return;

  const videosSinceSnooze = session.videoCount - snooze.videosAtSnoozeStart;
  if (videosSinceSnooze >= snooze.videoLimit) {
    await endSnooze();
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "snooze-expire") {
    await endSnooze();
  }
  if (alarm.name === "update-badge") {
    await updateBadge();
  }
});

// --- Badge ---

async function updateBadge() {
  const { session } = await getState();
  const count = session.snoozeCount || 0;

  if (count === 0) {
    chrome.action.setBadgeText({ text: "" });
    return;
  }

  const colors = snoozeBadgeColors(count);
  chrome.action.setBadgeBackgroundColor({ color: colors.background });
  chrome.action.setBadgeTextColor?.({ color: colors.text });
  chrome.action.setBadgeText({ text: `${count}` });
}

// --- Tab Monitoring ---

// Track when YouTube tabs are active to keep timer going
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (tab.url && tab.url.includes("youtube.com")) {
    await ensureSession();
  }

  if (changeInfo.url || tab.url) {
    await syncTimerWithYouTubeTabs();
    await updateBadge();
  }
});

chrome.tabs.onRemoved.addListener(async () => {
  if (await hasOpenYouTubeTabs()) {
    await syncTimerWithYouTubeTabs();
    await updateBadge();
    return;
  }

  // Last YouTube tab closed — end the session so the next visit starts fresh
  // (new intent prompt), instead of resuming the paused session.
  const { session } = await getState();
  if (!session.startTime) return; // nothing to reset
  await chrome.storage.local.set({ session: EMPTY_SESSION, snooze: EMPTY_SNOOZE });
  chrome.alarms.clear("snooze-expire");
  await updateBadge();
});

// Periodic badge update while YouTube is open
chrome.alarms.create("update-badge", { periodInMinutes: 1 });

chrome.runtime.onStartup.addListener(async () => {
  await pausePersistedTimerAtLastActivity();

  if (await hasOpenYouTubeTabs()) {
    await ensureSession();
  }

  await syncTimerWithYouTubeTabs();
  await updateBadge();
});

// --- Navigation Tracking ---

function extractVideoId(url) {
  if (url.pathname === "/watch") return url.searchParams.get("v");
  if (url.pathname.startsWith("/shorts/")) {
    return url.pathname.split("/shorts/")[1]?.split("?")[0] || null;
  }
  return null;
}

chrome.webNavigation.onHistoryStateUpdated.addListener(
  async (details) => {
    if (details.frameId !== 0) return;
    const videoId = extractVideoId(new URL(details.url));
    if (videoId) {
      await ensureSession();
      await trackVideo(videoId);
    }
  },
  { url: [{ hostContains: "youtube.com" }] }
);

// Also track via completed navigation (for fresh page loads)
chrome.webNavigation.onCompleted.addListener(
  async (details) => {
    if (details.frameId !== 0) return;
    const videoId = extractVideoId(new URL(details.url));
    if (videoId) {
      await ensureSession();
      await trackVideo(videoId);
    }
  },
  { url: [{ hostContains: "youtube.com" }] }
);

// --- Message Handling ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "get-state") {
    getState().then(sendResponse);
    return true;
  }
  if (msg.type === "set-intent") {
    getState().then(async ({ session }) => {
      const now = Date.now();
      session.intent = msg.intent;
      session.lastActivity = now;
      // Restart the high-risk countdown from the moment the user commits to an
      // intent — time spent sitting on the intent prompt shouldn't count.
      session.elapsedMs = 0;
      session.timerStartedAt = now;
      await chrome.storage.local.set({ session });
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg.type === "start-snooze") {
    startSnooze(msg.minutes, msg.videoLimit).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "end-snooze") {
    endSnooze().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "set-settings") {
    patchSettings(msg.settings)
      .then(() => updateBadge())
      .then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "heartbeat") {
    ensureSession()
      .then(() => syncTimerWithYouTubeTabs())
      .then(() => updateBadge())
      .then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "done-session") {
    (async () => {
      // "I'm done" ends the session for *every* tab, not just this one. Closing
      // the tab alone only resets state when it's the last YouTube tab (see
      // tabs.onRemoved) — with other tabs still open they'd keep the old at-risk
      // session and stay blurred. Start a fresh session (startTime set, intent
      // cleared) so any remaining tabs drop the breath banner and re-prompt for
      // intent. A fresh session rather than EMPTY_SESSION matters: set-intent
      // preserves an existing startTime, whereas an empty one would be wiped by
      // the next ensureSession heartbeat, blowing away the intent just entered.
      const now = Date.now();
      const newSession = {
        ...EMPTY_SESSION,
        startTime: now,
        timerStartedAt: now,
        lastActivity: now,
      };
      await chrome.storage.local.set({ session: newSession, snooze: EMPTY_SNOOZE });
      chrome.alarms.clear("snooze-expire");
      await updateBadge();
      sendResponse({ ok: true });
      // Close this tab last. If it was the only YouTube tab, tabs.onRemoved then
      // resets to EMPTY_SESSION so the next visit starts clean.
      if (sender.tab?.id != null) chrome.tabs.remove(sender.tab.id);
    })();
    return true;
  }
  if (msg.type === "reset-session") {
    (async () => {
      const now = Date.now();
      const newSession = {
        ...EMPTY_SESSION,
        startTime: now,
        timerStartedAt: now,
        lastActivity: now,
      };
      await chrome.storage.local.set({ session: newSession, snooze: EMPTY_SNOOZE });
      sendResponse({ ok: true });
    })();
    return true;
  }
  // Debug console: merge-patch any state slice, then refresh the badge. Content
  // scripts re-render off the storage write via chrome.storage.onChanged.
  if (msg.type === "debug-apply") {
    (async () => {
      const { session, snooze } = await getState();
      const updates = {};
      if (msg.session) updates.session = { ...session, ...msg.session };
      if (msg.snooze) updates.snooze = { ...snooze, ...msg.snooze };
      if (Object.keys(updates).length) await chrome.storage.local.set(updates);
      // Settings route through patchSettings so they get clamped and stored
      // sparsely, same as the Options page.
      if (msg.settings) await patchSettings(msg.settings);
      await updateBadge();
      sendResponse({ ok: true });
    })();
    return true;
  }
  // Debug console: refresh the badge after a direct storage write. Content
  // scripts pick the write up themselves via chrome.storage.onChanged.
  if (msg.type === "debug-refresh") {
    (async () => {
      await updateBadge();
      sendResponse({ ok: true });
    })();
    return true;
  }
});
