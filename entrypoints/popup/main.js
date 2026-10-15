// PauseTube popup script

const statsEl = document.getElementById("stats");
const intentEl = document.getElementById("intent");
const snoozeControls = document.getElementById("snooze-controls");
const snoozeActiveEl = document.getElementById("snooze-active");
const snoozeRemaining = document.getElementById("snooze-remaining");
const snoozeCancelBtn = document.getElementById("snooze-cancel");
const sessionCancelBtn = document.getElementById("session-cancel");

async function loadState() {
  try {
    const state = await chrome.runtime.sendMessage({ type: "get-state" });
    if (!state) return;
    render(state);
  } catch (err) {
    console.error("[PauseTube popup]", err);
  }
}

// Snooze durations are configurable, so rebuild the buttons whenever the set
// changes (cheap; the popup re-renders once a second).
let snoozeSig = null;
function buildSnoozeButtons(options) {
  const sig = options.join(",");
  if (sig === snoozeSig) return;
  snoozeSig = sig;
  snoozeControls.querySelectorAll(".snooze-btn").forEach((b) => b.remove());
  options.forEach((min) => {
    const btn = document.createElement("button");
    btn.className = "snooze-btn";
    btn.textContent = `${min}m`;
    btn.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "start-snooze", minutes: min, videoLimit: null });
      // Resume only the tab the user is looking at, like the in-page gate does.
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "resume-playback" }).catch(() => {});
      await loadState();
    });
    snoozeControls.appendChild(btn);
  });
}

function render(state) {
  const session = state.session || {};
  const snooze = state.snooze || { active: false };
  buildSnoozeButtons(state.settings?.popupSnoozeOptions || [1, 5, 10]);

  // Stats
  let timeText = "-";
  if (session.startTime) {
    const elapsedBase = session.elapsedMs || 0;
    const runningElapsed = session.timerStartedAt ? Date.now() - session.timerStartedAt : 0;
    const elapsed = elapsedBase + runningElapsed;
    const min = Math.floor(elapsed / 60000);
    timeText = min < 60 ? `${min}m` : `${Math.floor(min / 60)}h ${min % 60}m`;
  }
  const videos = session.videoCount || 0;
  statsEl.textContent = `${timeText} · ${videos} video${videos !== 1 ? "s" : ""}`;

  // Intent
  if (session.intent && session.intent !== "Just browsing") {
    intentEl.textContent = `🎯 ${session.intent}`;
    intentEl.classList.remove("empty");
  } else {
    intentEl.classList.add("empty");
  }

  // Session controls only appear once the user has committed (intent chosen)
  const hasSession = Boolean(session.startTime && session.intent);

  if (!hasSession) {
    snoozeControls.style.display = "none";
    snoozeActiveEl.style.display = "none";
    sessionCancelBtn.classList.add("hidden");
  } else if (snooze.active) {
    snoozeControls.style.display = "none";
    snoozeActiveEl.style.display = "flex";
    const remaining = snooze.expiresAt ? Math.max(0, snooze.expiresAt - Date.now()) : 0;
    const min = Math.ceil(remaining / 60000);
    snoozeRemaining.textContent = `Snoozed · ${min}m left`;
    sessionCancelBtn.classList.remove("hidden");
  } else {
    snoozeControls.style.display = "flex";
    snoozeActiveEl.style.display = "none";
    sessionCancelBtn.classList.remove("hidden");
  }
}

snoozeCancelBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "end-snooze" });
  await loadState();
});

document.getElementById("settings-link").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

const debugLink = document.getElementById("debug-link");
debugLink.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("debug.html") });
});

// Debug console is a dev-only tool: show its link only when the extension is
// loaded unpacked. Store installs report installType "normal" and never see it.
// getSelf() needs no "management" permission (unlike the rest of that API).
chrome.management.getSelf((self) => {
  if (self.installType !== "development") debugLink.style.display = "none";
});

sessionCancelBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "reset-session" });
  await loadState();
});

loadState();
setInterval(loadState, 1000);
