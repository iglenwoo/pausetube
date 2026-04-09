// OffTube — Background Service Worker
// Manages session state, timers, snooze logic, and badge updates

const DEFAULT_SETTINGS = {
  sessionTimeoutMin: 30,
  defaultSnoozeMin: 15,
  defaultSnoozeVideos: 5,
};

const EMPTY_SESSION = {
  startTime: null,
  videoCount: 0,
  videosWatched: [],
  intent: null,
  lastActivity: null,
};

const EMPTY_SNOOZE = {
  active: false,
  expiresAt: null,
  videoLimit: null,
  videosAtSnoozeStart: 0,
};

// --- Initialization ---

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get("settings");
  if (!settings) {
    await chrome.storage.local.set({
      settings: DEFAULT_SETTINGS,
      session: EMPTY_SESSION,
      snooze: EMPTY_SNOOZE,
    });
  }
});

// --- Session Management ---

async function getState() {
  const data = await chrome.storage.local.get(["session", "snooze", "settings"]);
  return {
    session: data.session || EMPTY_SESSION,
    snooze: data.snooze || EMPTY_SNOOZE,
    settings: data.settings || DEFAULT_SETTINGS,
  };
}

async function ensureSession() {
  const { session, settings } = await getState();
  const now = Date.now();

  // Reset session if timed out
  if (session.lastActivity) {
    const inactiveMin = (now - session.lastActivity) / 1000 / 60;
    if (inactiveMin > settings.sessionTimeoutMin) {
      const newSession = { ...EMPTY_SESSION, startTime: now, lastActivity: now };
      await chrome.storage.local.set({ session: newSession, snooze: EMPTY_SNOOZE });
      return newSession;
    }
  }

  // Start new session if none exists
  if (!session.startTime) {
    const newSession = { ...EMPTY_SESSION, startTime: now, lastActivity: now };
    await chrome.storage.local.set({ session: newSession });
    return newSession;
  }

  // Update activity timestamp
  session.lastActivity = now;
  await chrome.storage.local.set({ session });
  return session;
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
  const snooze = {
    active: true,
    expiresAt: minutes ? Date.now() + minutes * 60 * 1000 : null,
    videoLimit: videoLimit || null,
    videosAtSnoozeStart: session.videoCount,
  };
  await chrome.storage.local.set({ snooze });

  if (minutes) {
    chrome.alarms.create("snooze-expire", { delayInMinutes: minutes });
  }

  await updateBadge();
  notifyContentScripts({ type: "snooze-changed", snooze });
}

async function endSnooze() {
  await chrome.storage.local.set({ snooze: EMPTY_SNOOZE });
  chrome.alarms.clear("snooze-expire");
  await updateBadge();
  notifyContentScripts({ type: "snooze-changed", snooze: EMPTY_SNOOZE });
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
  const { session, snooze } = await getState();

  if (snooze.active) {
    chrome.action.setBadgeBackgroundColor({ color: "#6B7280" });
    chrome.action.setBadgeText({ text: "💤" });
    return;
  }

  if (!session.startTime) {
    chrome.action.setBadgeText({ text: "" });
    return;
  }

  const elapsedMin = Math.floor((Date.now() - session.startTime) / 1000 / 60);
  const text = `${elapsedMin}m`;
  chrome.action.setBadgeBackgroundColor({ color: "#EF4444" });
  chrome.action.setBadgeText({ text });
}

// --- Tab Monitoring ---

// Track when YouTube tabs are active to keep timer going
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (tab.url && tab.url.includes("youtube.com")) {
    await ensureSession();
    await updateBadge();
  }
});

// Periodic badge update while YouTube is open
chrome.alarms.create("update-badge", { periodInMinutes: 1 });

// --- Navigation Tracking ---

function extractVideoId(url) {
  if (url.pathname === "/watch") return url.searchParams.get("v");
  if (url.pathname.startsWith("/shorts/")) return url.pathname.split("/shorts/")[1] || null;
  return null;
}

chrome.webNavigation.onHistoryStateUpdated.addListener(
  async (details) => {
    if (details.frameId !== 0) return;
    const url = new URL(details.url);
    const videoId = extractVideoId(url);
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
    const url = new URL(details.url);
    const videoId = extractVideoId(url);
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
      session.intent = msg.intent;
      session.lastActivity = Date.now();
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
  if (msg.type === "heartbeat") {
    ensureSession().then(() => updateBadge()).then(() => sendResponse({ ok: true }));
    return true;
  }
});

// --- Helpers ---

async function notifyContentScripts(message) {
  const tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, message).catch(() => {});
  }
}
