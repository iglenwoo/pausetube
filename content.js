// OffTube — Content Script
// Injected into YouTube pages: blur, intent prompt, floating badge

(function () {
  "use strict";

  let currentState = null;
  let badgeEl = null;
  let stickyEl = null;
  let badgeInterval = null;
  let savedScrollY = 0;
  let toastMidpointTimer = null;

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

  // --- Feed Hidden Banner ---

  function snoozeSubtitle(count) {
    if (count >= 6) return "What's actually going on?";
    if (count >= 4) return "Still here?";
    if (count >= 2) return "You keep coming back...";
    return "Snooze to browse for a bit";
  }

  async function handleSnoozeClick(minutes, videoLimit) {
    await chrome.runtime.sendMessage({ type: "start-snooze", minutes, videoLimit });
    await fetchState();
    applyBlur();
  }

  function showFeedHiddenBanner() {
    if (document.querySelector(".offtube-feed-banner")) return;

    const snoozeCount = currentState?.session?.snoozeCount || 0;
    const totalSnoozedMs = currentState?.session?.totalSnoozedMs || 0;
    const totalMin = Math.round(totalSnoozedMs / 60000);
    const onWatchPage = window.location.pathname === "/watch";

    let statsHtml = "";
    if (snoozeCount > 0) {
      const timeStr = totalMin > 0 ? ` · ${totalMin} min browsing` : "";
      statsHtml = `<p class="offtube-banner-snooze-count">Snoozed ${snoozeCount}×${timeStr}</p>`;
    }

    const banner = document.createElement("div");
    banner.className = "offtube-feed-banner";
    banner.innerHTML = `
      <p class="offtube-banner-title">${onWatchPage ? "Take a breath" : "Feed hidden"}</p>
      <p class="offtube-banner-sub">${snoozeSubtitle(snoozeCount)}</p>
      ${statsHtml}
      <div class="offtube-banner-btns">
        <button data-minutes="1">1 min</button>
        <button data-minutes="5">5 min</button>
        <button data-minutes="10">10 min</button>
      </div>
      <div class="offtube-banner-btns">
        <button data-videos="1">1 video</button>
        <button data-videos="2">2 videos</button>
        <button data-videos="3">3 videos</button>
      </div>
    `;

    banner.querySelectorAll("[data-minutes]").forEach((btn) => {
      btn.addEventListener("click", () => handleSnoozeClick(Number(btn.dataset.minutes), null));
    });

    banner.querySelectorAll("[data-videos]").forEach((btn) => {
      btn.addEventListener("click", () => handleSnoozeClick(null, Number(btn.dataset.videos)));
    });

    document.body.appendChild(banner);
  }

  function removeFeedHiddenBanner() {
    document.querySelector(".offtube-feed-banner")?.remove();
  }

  // --- Blur ---

  function applyBlur() {
    if (isSnoozed()) {
      document.documentElement.classList.remove("offtube-blur");
      removeFeedHiddenBanner();
      window.scrollTo(0, savedScrollY);
    } else {
      savedScrollY = window.scrollY;
      document.documentElement.classList.add("offtube-blur");
      document.querySelectorAll("video").forEach((v) => v.pause());
      showFeedHiddenBanner();
    }
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
    applyBlur();

    // Intent prompt
    if (shouldShowIntent()) {
      showIntentPrompt();
    } else if (currentState?.session?.intent && currentState.session.intent !== "Just browsing") {
      showIntentSticky();
    }

    // Session badge
    createBadge();

    // Periodic badge updates
    badgeInterval = setInterval(async () => {
      await fetchState();
      updateBadge();
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
      applyBlur();
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
      applyBlur();
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
  });

  // Go
  init();
})();
