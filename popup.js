// OffTube — Popup Script

let selectedMinutes = null;
let selectedVideos = null;

// --- DOM ---

const statTime = document.getElementById("stat-time");
const statVideos = document.getElementById("stat-videos");
const intentDisplay = document.getElementById("intent-display");
const intentText = document.getElementById("intent-text");
const snoozeControls = document.getElementById("snooze-controls");
const snoozeActiveEl = document.getElementById("snooze-active");
const snoozeRemaining = document.getElementById("snooze-remaining");
const snoozeStartBtn = document.getElementById("snooze-start");
const snoozeCancelBtn = document.getElementById("snooze-cancel");

// --- State ---

async function loadState() {
  const state = await chrome.runtime.sendMessage({ type: "get-state" });
  updateStats(state);
  updateSnoozeUI(state);
}

function updateStats(state) {
  const session = state.session;

  if (session.startTime) {
    const elapsedBase = session.elapsedMs || 0;
    const runningElapsed = session.timerStartedAt ? Date.now() - session.timerStartedAt : 0;
    const elapsed = elapsedBase + runningElapsed;
    const min = Math.floor(elapsed / 60000);
    statTime.textContent = min < 60 ? `${min}m` : `${Math.floor(min / 60)}h ${min % 60}m`;
  } else {
    statTime.textContent = "—";
  }

  statVideos.textContent = session.videoCount || 0;

  if (session.intent && session.intent !== "Just browsing") {
    intentDisplay.style.display = "block";
    intentText.textContent = session.intent;
  } else {
    intentDisplay.style.display = "none";
  }
}

function updateSnoozeUI(state) {
  const snooze = state.snooze;

  if (snooze.active) {
    snoozeControls.style.display = "none";
    snoozeActiveEl.style.display = "block";
    updateSnoozeRemaining(snooze, state.session);
  } else {
    snoozeControls.style.display = "block";
    snoozeActiveEl.style.display = "none";
  }
}

function updateSnoozeRemaining(snooze, session) {
  const parts = [];

  if (snooze.expiresAt) {
    const remaining = Math.max(0, snooze.expiresAt - Date.now());
    const min = Math.ceil(remaining / 60000);
    parts.push(`${min}m left`);
  }

  if (snooze.videoLimit) {
    const watched = (session.videoCount || 0) - snooze.videosAtSnoozeStart;
    const left = Math.max(0, snooze.videoLimit - watched);
    parts.push(`${left} video${left !== 1 ? "s" : ""} left`);
  }

  snoozeRemaining.textContent = parts.join(" · ") || "Active";
}

// --- Snooze Selection ---

function updateStartButton() {
  if (selectedMinutes || selectedVideos) {
    const parts = [];
    if (selectedMinutes) parts.push(`${selectedMinutes}m`);
    if (selectedVideos) parts.push(`${selectedVideos} videos`);
    snoozeStartBtn.textContent = `Snooze for ${parts.join(" or ")}`;
    snoozeStartBtn.disabled = false;
  } else {
    snoozeStartBtn.textContent = "Select a snooze option";
    snoozeStartBtn.disabled = true;
  }
}

document.querySelectorAll("#time-options .snooze-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#time-options .snooze-btn").forEach((b) => b.classList.remove("active"));
    if (selectedMinutes === Number(btn.dataset.minutes)) {
      selectedMinutes = null;
    } else {
      btn.classList.add("active");
      selectedMinutes = Number(btn.dataset.minutes);
    }
    updateStartButton();
  });
});


document.querySelectorAll("#video-options .snooze-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#video-options .snooze-btn").forEach((b) => b.classList.remove("active"));
    if (selectedVideos === Number(btn.dataset.videos)) {
      selectedVideos = null;
    } else {
      btn.classList.add("active");
      selectedVideos = Number(btn.dataset.videos);
    }
    updateStartButton();
  });
});

// --- Snooze Actions ---

snoozeStartBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({
    type: "start-snooze",
    minutes: selectedMinutes,
    videoLimit: selectedVideos,
  });
  selectedMinutes = null;
  selectedVideos = null;
  await loadState();
});

snoozeCancelBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "end-snooze" });
  await loadState();
});

// --- Init ---

loadState();

// Refresh every second while popup is open
setInterval(loadState, 1000);
