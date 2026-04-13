// OffTube — Content Script
// Injected into YouTube pages: blur, intent prompt, floating badge

(function () {
  "use strict";

  let currentState = null;
  let badgeEl = null;
  let stickyEl = null;
  let badgeInterval = null;
  let toastMidpointTimer = null;
  let stateLabelShown = false;
  let lastKnownSessionStart = null;

  // --- State ---

  async function fetchState() {
    try {
      currentState = await chrome.runtime.sendMessage({ type: "get-state" });
    } catch {
      currentState = null;
    }
    return currentState;
  }

  function isSnoozed() {
    return currentState?.snooze?.active === true;
  }

  function getElapsedMs(session) {
    const base = session.elapsedMs || 0;
    if (!session.timerStartedAt) return base;
    return base + (Date.now() - session.timerStartedAt);
  }

  function getRiskLevel() {
    if (!currentState?.session?.startTime) return "none";
    if (isSnoozed()) return "snoozed";
    const elapsed = getElapsedMs(currentState.session);
    const shortStreak = currentState.session?.shortStreak || 0;
    if (elapsed >= 15 * 60 * 1000 || shortStreak >= 3) return "high";
    if (elapsed >= 10 * 60 * 1000) return "medium";
    return "none";
  }

  // --- Feed Hidden Banner ---

  async function handleSnoozeClick(minutes, videoLimit) {
    await chrome.runtime.sendMessage({ type: "start-snooze", minutes, videoLimit });
    await fetchState();
    applyRiskUI();
  }

  function showFeedHiddenBanner() {
    if (document.querySelector(".offtube-feed-banner")) return;

    const session = currentState?.session || {};
    const elapsed = getElapsedMs(session);
    const min = Math.floor(elapsed / 60000);
    const videos = session.videoCount || 0;
    const shortStreak = session.shortStreak || 0;
    const intent = session.intent && session.intent !== "Just browsing" ? session.intent : null;

    const stateText = shortStreak >= 3
      ? `${shortStreak} Shorts in a row`
      : `${min} min here · ${videos} video${videos !== 1 ? "s" : ""}`;

    const intentBtnHtml = intent
      ? `<button class="offtube-choice-intent">Back to: ${intent}</button>`
      : "";

    const banner = document.createElement("div");
    banner.className = "offtube-feed-banner";
    banner.innerHTML = `
      <p class="offtube-banner-state">${stateText}</p>
      <div class="offtube-breathe-wrap">
        <div class="offtube-breathe-circle"></div>
        <p class="offtube-breathe-label">breathe</p>
      </div>
      <div class="offtube-banner-choices">
        <button class="offtube-choice-snooze" data-minutes="10">10 more min</button>
        <button class="offtube-choice-snooze" data-minutes="3">3 more min</button>
        ${intentBtnHtml}
        <button class="offtube-choice-done">I'm done</button>
      </div>
    `;

    // Reveal choices after breathing animation (~6s)
    setTimeout(() => {
      banner.querySelector(".offtube-banner-choices")?.classList.add("visible");
    }, 6500);

    banner.querySelectorAll("[data-minutes]").forEach((btn) => {
      btn.addEventListener("click", () => handleSnoozeClick(Number(btn.dataset.minutes), null));
    });

    const doneBtn = banner.querySelector(".offtube-choice-done");
    if (doneBtn) {
      doneBtn.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "close-tab" });
      });
    }

    const intentBtnEl = banner.querySelector(".offtube-choice-intent");
    if (intentBtnEl) {
      // Snooze 10 min so the overlay clears; intent sticky stays visible
      intentBtnEl.addEventListener("click", () => handleSnoozeClick(10, null));
    }

    document.body.appendChild(banner);
  }

  function removeFeedHiddenBanner() {
    document.querySelector(".offtube-feed-banner")?.remove();
  }

  // --- State Label (medium risk) ---

  function showStateLabel() {
    if (document.querySelector(".offtube-state-label")) return;

    const session = currentState?.session || {};
    const elapsed = getElapsedMs(session);
    const min = Math.floor(elapsed / 60000);
    const videos = session.videoCount || 0;

    const label = document.createElement("div");
    label.className = "offtube-state-label";
    label.textContent = `${min} min here · ${videos} video${videos !== 1 ? "s" : ""}`;
    document.body.appendChild(label);

    setTimeout(() => {
      label.classList.add("offtube-state-label-hide");
      setTimeout(() => label.remove(), 500);
    }, 8000);

    stateLabelShown = true;
  }

  function removeStateLabel() {
    document.querySelector(".offtube-state-label")?.remove();
  }

  // --- Risk UI ---

  function applyRiskUI() {
    const risk = getRiskLevel();

    // Reset state label tracking when session resets
    if (currentState?.session?.startTime !== lastKnownSessionStart) {
      lastKnownSessionStart = currentState?.session?.startTime || null;
      stateLabelShown = false;
    }

    if (risk === "snoozed" || risk === "none") {
      document.documentElement.classList.remove("offtube-blur");
      removeFeedHiddenBanner();
      removeStateLabel();
      return;
    }

    if (risk === "medium") {
      document.documentElement.classList.remove("offtube-blur");
      removeFeedHiddenBanner();
      if (!stateLabelShown) showStateLabel();
      return;
    }

    // high
    document.documentElement.classList.add("offtube-blur");
    document.querySelectorAll("video").forEach((v) => v.pause());
    removeStateLabel();
    showFeedHiddenBanner();
  }

  // --- Intent Prompt ---

  function isDirectVideoLink() {
    const url = new URL(window.location.href);
    if (url.pathname !== "/watch") return false;

    // If referrer is not youtube.com, it's likely a shared link
    try {
      if (document.referrer) {
        const ref = new URL(document.referrer);
        return ref.hostname !== "www.youtube.com";
      }
    } catch {
      // No referrer = likely direct navigation or shared link
    }
    return true;
  }

  function shouldShowIntent() {
    if (!currentState) return false;
    if (isSnoozed()) return false;
    if (currentState.session.intent) return false;
    if (isDirectVideoLink()) return false;
    return true;
  }

  function showIntentPrompt() {
    if (document.querySelector(".offtube-intent-overlay")) return;

    const overlay = document.createElement("div");
    overlay.className = "offtube-intent-overlay";
    overlay.innerHTML = `
      <div class="offtube-intent-card">
        <h1>What are you here to watch?</h1>
        <p>Having a purpose helps you stay in control.</p>
        <input class="offtube-intent-input" type="text" placeholder="e.g. Next.js tutorial, music for studying..." autofocus />
        <br />
        <button class="offtube-intent-submit">Let's go</button>
        <br />
        <button class="offtube-intent-skip">Just browsing</button>
      </div>
    `;

    const input = overlay.querySelector(".offtube-intent-input");
    const submitBtn = overlay.querySelector(".offtube-intent-submit");
    const skipBtn = overlay.querySelector(".offtube-intent-skip");

    async function submit() {
      const intent = input.value.trim() || "Just browsing";
      await chrome.runtime.sendMessage({ type: "set-intent", intent });
      overlay.remove();
      await fetchState();
      showIntentSticky();
    }

    submitBtn.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
    skipBtn.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "set-intent", intent: "Just browsing" });
      overlay.remove();
      await fetchState();
    });

    document.body.appendChild(overlay);
  }

  function showIntentSticky() {
    if (!currentState?.session?.intent) return;
    if (currentState.session.intent === "Just browsing") return;
    removeIntentSticky();

    stickyEl = document.createElement("div");
    stickyEl.className = "offtube-intent-sticky";
    stickyEl.textContent = `🎯 ${currentState.session.intent}`;
    document.body.appendChild(stickyEl);
  }

  function removeIntentSticky() {
    if (stickyEl) {
      stickyEl.remove();
      stickyEl = null;
    }
  }

  // --- Toast ---

  function showToast() {
    document.querySelector(".offtube-toast")?.remove();

    const snoozeCount = currentState?.session?.snoozeCount || 0;
    const totalSnoozedMs = currentState?.session?.totalSnoozedMs || 0;
    const totalMin = Math.round(totalSnoozedMs / 60000);
    const text = totalMin > 0
      ? `Snoozed ${snoozeCount}× · ${totalMin} min browsing`
      : `Snoozed ${snoozeCount}×`;

    const toast = document.createElement("div");
    toast.className = "offtube-toast";
    toast.textContent = text;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.classList.add("offtube-toast-hide");
      setTimeout(() => toast.remove(), 500);
    }, 4000);
  }

  function scheduleToastMidpoint() {
    clearTimeout(toastMidpointTimer);
    toastMidpointTimer = null;

    const expiresAt = currentState?.snooze?.expiresAt;
    if (!expiresAt) return;

    const remaining = expiresAt - Date.now();
    if (remaining < 10000) return;

    toastMidpointTimer = setTimeout(async () => {
      await fetchState();
      if (isSnoozed()) showToast();
    }, remaining / 2);
  }

  // --- Session Badge ---

  function createBadge() {
    if (badgeEl) return;

    badgeEl = document.createElement("div");
    badgeEl.className = "offtube-badge";
    document.body.appendChild(badgeEl);
    updateBadge();
  }

  function updateBadge() {
    if (!badgeEl || !currentState?.session?.startTime) return;

    const elapsedBase = currentState.session.elapsedMs || 0;
    const runningElapsed = currentState.session.timerStartedAt
      ? Date.now() - currentState.session.timerStartedAt
      : 0;
    const elapsed = elapsedBase + runningElapsed;
    const min = Math.floor(elapsed / 60000);
    const videos = currentState.session.videoCount || 0;
    const snoozed = isSnoozed();

    if (snoozed) {
      badgeEl.className = "offtube-badge offtube-badge-snoozed";
    } else {
      badgeEl.className = "offtube-badge";
    }

    let text = `${min}m · ${videos} video${videos !== 1 ? "s" : ""}`;
    if (snoozed) {
      text += " · snoozed";
    }

    badgeEl.innerHTML = `<span class="offtube-badge-dot"></span>${text}`;
  }

  // --- Lifecycle ---

  async function init() {
    await fetchState();
    applyRiskUI();

    // Intent prompt
    if (shouldShowIntent()) {
      showIntentPrompt();
    } else if (currentState?.session?.intent && currentState.session.intent !== "Just browsing") {
      showIntentSticky();
    }

    // Session badge
    createBadge();

    // Periodic badge updates and risk level checks
    badgeInterval = setInterval(async () => {
      await fetchState();
      updateBadge();
      applyRiskUI();
    }, 10000);

    // Heartbeat to keep session alive
    setInterval(() => {
      chrome.runtime.sendMessage({ type: "heartbeat" }).catch(() => {});
    }, 60000);
  }

  // YouTube is an SPA — listen for navigation events
  function onNavigate() {
    removeFeedHiddenBanner();
    fetchState().then(() => {
      applyRiskUI();
      updateBadge();
      if (shouldShowIntent()) {
        showIntentPrompt();
      } else if (currentState?.session?.intent && currentState.session.intent !== "Just browsing") {
        showIntentSticky();
      }
    });
  }

  // YouTube fires this custom event on SPA navigation
  document.addEventListener("yt-navigate-finish", onNavigate);

  // Also watch for URL changes via History API
  let lastUrl = location.href;
  const urlObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      onNavigate();
    }
  });
  urlObserver.observe(document.body, { childList: true, subtree: true });

  // Listen for messages from background
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "snooze-changed") {
      if (currentState) {
        currentState.snooze = msg.snooze;
      }
      applyRiskUI();
      updateBadge();

      if (msg.snooze.active) {
        fetchState().then(() => {
          showToast();
          scheduleToastMidpoint();
        });
      } else {
        clearTimeout(toastMidpointTimer);
        toastMidpointTimer = null;
      }
    }
    if (msg.type === "session-updated") {
      if (currentState) {
        currentState.session = msg.session;
      }
      applyRiskUI();
      updateBadge();
    }
  });

  // Go
  init();
})();
